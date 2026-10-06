import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { fromSecSubmissions } from "@aihot/backend/sources/sec";
import { candidateIdentity, limitNewCandidates } from "@aihot/backend/sources/limits";
import { collectSource, noiseFiltered } from "@aihot/backend/sources/collect";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { extractSecFiling, secEarningsExhibit } from "@aihot/backend/content/sec-filing";

after(async () => { await stopBoss(); await closeDb(); });
const source = { id: "stock-us-sec-test", config: { cik: "0001045810", ticker: "NVDA" } } as never;
function submissions() {
  return { cik: "0001045810", name: "Synthetic Company", tickers: ["NVDA"], filings: { recent: {
    form: ["4", "8-K", "8-K", "10-Q", "8-K/A"],
    items: ["", "9.01", "2.02,9.01", "", "1.01"],
    accessionNumber: Array.from({ length: 5 }, (_, i) => `0001045810-26-00000${i}`),
    primaryDocument: ["shares.htm", "exhibits.htm", "earnings.htm", "quarter.htm", "amended.htm"],
    acceptanceDateTime: Array(5).fill("2026-09-30T14:00:00Z"),
  } } };
}

test("SEC only keeps material filings, retains amendments and uses actual acceptance dates", () => {
  const got = fromSecSubmissions(submissions(), source);
  assert.equal(got.length, 3);
  assert.match(got[0]!.title, /业绩披露/);
  assert.equal(got[0]!.publishedAt!.toISOString(), "2026-09-30T14:00:00.000Z");
  assert.match(got[0]!.url, /1045810\/000104581026000002\/earnings.htm$/);
  assert.equal(got[0]!.bodyStatus, "pending");
  assert.match(got[2]!.title, /8-K\/A/);
  const routine = submissions(); routine.filings.recent.form.fill("4");
  assert.deepEqual(fromSecSubmissions(routine, source), []);
});

test("SEC rejects wrong company, broken columns and unsafe document paths", () => {
  const wrong = submissions(); wrong.cik = "0000000001";
  assert.throws(() => fromSecSubmissions(wrong, source), /identity mismatch/);
  const broken = submissions(); broken.filings.recent.items.pop();
  assert.throws(() => fromSecSubmissions(broken, source), /columns/);
  const unsafe = submissions(); unsafe.filings.recent.primaryDocument[2] = "../other/earnings.htm";
  assert.throws(() => fromSecSubmissions(unsafe, source), /document identity/);
  const date = submissions(); date.filings.recent.acceptanceDateTime[2] = "2026-09-30";
  assert.throws(() => fromSecSubmissions(date, source), /timestamp/);
});

test("paper topic requirements and bounded new items preserve revisions and deduplicate", () => {
  const paper = { config: { ingestNoiseFilter: { requireAnyMarkers: ["language model"], keepIfMatches: ["agent"] } } } as never;
  assert.equal(noiseFiltered({ url: "https://example.com/a", title: "Agent geometry" }, paper), true);
  assert.equal(noiseFiltered({ url: "https://example.com/a", title: "Language Model inference" }, paper), false);
  const items = ["known", "new", "new", "deferred"].map(id => ({ url: `https://example.com/${id}`, title: id }));
  const known = new Set([candidateIdentity(items[0]!, "s")]);
  const bounded = limitNewCandidates(items, "s", known, 1);
  assert.deepEqual(bounded.candidates.map(c => c.title), ["known", "new"]);
  assert.equal(bounded.deferred, 1);
  assert.deepEqual(limitNewCandidates(items, "s", known, 0).candidates.map(c => c.title), ["known"]);
  assert.ok(unsupportedConfig("json_list", { adapter: "mimo_home" }).length);
  assert.ok(unsupportedConfig("rss", { _aihot: { maxNewItemsPerDay: 0 } }).length);
  assert.ok(unsupportedConfig("rss", { _aihot: { liveOnly: "true" } }).length);
});

test("live-only news keeps its activation through failure and never imports older or undated feed entries", async () => {
  const saved = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  const id = `stock-live-${tag()}`;
  let fail = true;
  let fresh: string | null = null;
  const server = http.createServer((_req,res) => {
    if (fail) { res.writeHead(503); res.end('local failure'); return; }
    const entry = (name: string, date: string | null) => `<item><title>${name}</title><link>https://example.com/${id}/${name}</link>${date ? `<pubDate>${date}</pubDate>` : ''}</item>`;
    res.writeHead(200, { 'content-type':'application/rss+xml' });
    res.end(`<rss version="2.0"><channel>${entry('old','2020-01-01T00:00:00Z')}${entry('undated',null)}${fresh ? entry('fresh',fresh) : ''}</channel></rss>`);
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const port = (server.address() as {port:number}).port;
    await sql`INSERT INTO sources(id,name,kind,config) VALUES(${id},'local live-only','rss',${sql.json({feedUrl:`http://127.0.0.1:${port}`, _aihot:{liveOnly:true,maxNewItemsPerDay:2}})})`;
    assert.equal((await collectSource(id)).status, 'failed');
    const [before] = await sql`SELECT cursor FROM sources WHERE id=${id}`;
    assert.ok(before.cursor.liveStartedAt);
    fail=false; fresh=new Date().toISOString();
    assert.equal((await collectSource(id)).created,1);
    const rows = await sql`SELECT title,backfill FROM articles WHERE source_id=${id}`;
    assert.deepEqual(rows.map(r=>[r.title,r.backfill]),[['fresh',false]]);
    assert.equal((await collectSource(id)).created,0);
    const [after] = await sql`SELECT cursor FROM sources WHERE id=${id}`;
    assert.equal(after.cursor.liveStartedAt,before.cursor.liveStartedAt);
  } finally { config.allowPrivateNetworkFetch=saved; await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

const mainUrl = "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/main.htm";
test("SEC exhibit selection cannot follow another filing, company or an external website", () => {
  const html = `<a href="https://evil.example/ex99-1.htm">99.1</a><a href="../000104581026000001/ex99-1.htm">99.1</a>`
    + `<a href="/Archives/edgar/data/1/000000000126000073/ex99-1.htm">99.1</a><a href="ex99-1.htm?token=x">99.1</a><a href="ex99-1.htm">99.1</a>`;
  assert.equal(secEarningsExhibit(html, mainUrl), mainUrl.replace("main.htm", "ex99-1.htm"));
  assert.equal(secEarningsExhibit(html, "https://evil.example/main.htm"), null);
});

test("SEC extraction includes one same-filing earnings exhibit, and marks missing evidence", async () => {
  const previous = getGlobalDispatcher();
  const saved = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const mainPath = new URL(mainUrl).pathname;
  const main = `<html><body><p>${"Synthetic earnings filing. ".repeat(20)}</p><a href="ex99-1.htm">Exhibit 99.1</a><a href="ex99-2.htm">99.2</a></body></html>`;
  const extra = `<html><body><p>${"Synthetic report for extraction testing. ".repeat(20)}</p><table><tr><td>Revenue</td><td>12345</td></tr></table></body></html>`;
  const pool = agent.get("https://www.sec.gov");
  try {
    pool.intercept({ path: mainPath }).reply(200, main, { headers: { "content-type": "text/html" } });
    pool.intercept({ path: mainPath.replace("main.htm", "ex99-1.htm") }).reply(200, extra, { headers: { "content-type": "text/html" } });
    const got = await extractSecFiling(mainUrl);
    assert.match(got!.text, /同一申报的附件原文/); assert.match(got!.text, /12345/);
    agent.assertNoPendingInterceptors();
    pool.intercept({ path: mainPath }).reply(200, main, { headers: { "content-type": "text/html" } });
    pool.intercept({ path: mainPath.replace("main.htm", "ex99-1.htm") }).reply(503, "Unavailable");
    const missing = await extractSecFiling(mainUrl);
    assert.match(missing!.text, /附件原文未取得/); assert.doesNotMatch(missing!.text, /12345/);
    agent.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(previous); config.allowPrivateNetworkFetch = saved; await agent.close(); }
});

test("daily collection caps retain RSS deferred items across day rollover", async () => {
  const saved = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  const id = `cap-${tag()}`;
  const server = http.createServer((req, res) => {
    if (req.headers["if-none-match"] === '"same"') { res.writeHead(304); res.end(); return; }
    res.setHeader("content-type", "application/rss+xml"); res.setHeader("etag", '"same"');
    res.end(`<rss><channel><title>Local</title>${[1, 2, 3].map(i => `<item><title>Local ${i}</title><link>https://example.com/${id}/${i}</link><pubDate>${new Date().toUTCString()}</pubDate></item>`).join("")}</channel></rss>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await sql`INSERT INTO sources(id,name,kind,config) VALUES(${id},'local cap','rss',${sql.json({ feedUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/rss`, _aihot: { maxNewItemsPerDay: 2, initialBackfillLimit: 2 } })})`;
    assert.equal((await collectSource(id, { force: true })).created, 2);
    assert.equal((await collectSource(id, { force: true })).created, 0);
    const [s] = await sql`SELECT cursor FROM sources WHERE id=${id}`; assert.equal(s!.cursor.rss, undefined);
    await sql`UPDATE articles SET created_at = now() - interval '2 days' WHERE source_id=${id}`;
    assert.equal((await collectSource(id, { force: true })).created, 1);
    assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${id}`)[0]!.n, 3);
  } finally { config.allowPrivateNetworkFetch = saved; await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("date-only live sources baseline every initial identity and accept a later new section on the same day", async () => {
  const T = tag(), at = new Date(), date = at.toISOString().slice(0,10);
  let fresh = false;
  const server = http.createServer((_req,res) => { res.writeHead(200, {"content-type":"application/rss+xml"}); res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>dated changes</title>
    <item><title>Initial dated update</title><link>https://example.com/dated-old-${T}</link><pubDate>${date}T00:00:00Z</pubDate></item>
    <item><title>Archive update</title><link>https://example.com/dated-archive-${T}</link><pubDate>2020-01-01T00:00:00Z</pubDate></item>
    ${fresh ? `<item><title>Later dated update</title><link>https://example.com/dated-new-${T}</link><pubDate>${date}T00:00:00Z</pubDate></item>` : ''}
    </channel></rss>`); });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address() as { port: number };
  const local = { base: `http://127.0.0.1:${address.port}/feed`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
  const saved = config.allowPrivateNetworkFetch; config.allowPrivateNetworkFetch = true;
  const id = `dated-live-${T}`;
  try {
    await sql`INSERT INTO sources(id,name,kind,config,participation_mode) VALUES(${id},'dated live','rss',${sql.json({feedUrl:local.base,_aihot:{liveOnly:true,liveOnlyByIdentity:true,maxNewItemsPerDay:1}})},'editorial')`;
    assert.equal((await collectSource(id)).created, 0);
    const [source] = await sql`SELECT cursor FROM sources WHERE id=${id}`;
    assert.equal(source.cursor.liveBaselineKeys.length, 2);
    fresh = true;
    assert.equal((await collectSource(id)).created, 1);
    const [article] = await sql`SELECT url,backfill,published_at FROM articles WHERE source_id=${id}`;
    assert.match(article.url, /dated-new/); assert.equal(article.backfill, false);
    assert.equal(article.published_at.toISOString().slice(0,10), date);
    assert.equal((await collectSource(id)).created, 0);
    const [again] = await sql`SELECT cursor FROM sources WHERE id=${id}`;
    assert.deepEqual(again.cursor.liveBaselineKeys, source.cursor.liveBaselineKeys);
  } finally { config.allowPrivateNetworkFetch = saved; await local.close(); }
});
