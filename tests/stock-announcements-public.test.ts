import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { StockAnnouncementsResponse } from "@aihot/contracts/stock";
import { sql, closeDb } from "@aihot/backend/db";
import { stockAnnouncements } from "@aihot/backend/publication/stock-announcements";
import { ANNOUNCEMENT_SOURCES } from "@aihot/backend/sources/stock-announcements";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { setVisibility } from "@aihot/backend/admin/content";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag(), sourceId = ANNOUNCEMENT_SOURCES.sh;
const now = new Date("2024-04-11T12:00:00+08:00"), day = "2024-04-11";
const query = { market: "sh" as const, code: "600036", from: "2024-04-10", to: day, limit: 50, cursor: null };
const path = `/api/v1/stock/announcements?market=sh&code=600036&from=${query.from}&to=${day}`;
const app = await buildApp();
const articleIds: string[] = [];
let originalSources: Awaited<ReturnType<typeof sources>>;
function sources() { return sql`SELECT * FROM sources WHERE id IN (${sourceId},${ANNOUNCEMENT_SOURCES.sz},${ANNOUNCEMENT_SOURCES.bj})`; }

async function announcement(suffix: string, code = "600036", source: string = sourceId, date = day) {
  const id = `${T}-${suffix}`;
  await sql`INSERT INTO stock_announcements(id,source_id,day,code,name,title,pdf_url,published_at,baseline,priority,first_seen_at)
    VALUES (${id},${source},${date},${code},'公司','普通公告',${`https://static.cninfo.com.cn/finalpage/${date}/123.pdf`},
      ${new Date(`${date}T09:00:00+08:00`)},true,0,${now})`;
  return id;
}

before(async () => {
  originalSources = await sources();
  for (const id of Object.values(ANNOUNCEMENT_SOURCES)) {
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES (${id},'公告测试','external','T1','editorial') ON CONFLICT DO NOTHING`;
    await sql`UPDATE sources SET enabled=true,health='ok',participation_mode='editorial',last_ok_at=${now},last_fetch_at=${now} WHERE id=${id}`;
  }
  await announcement("a");
  await announcement("b");
  await announcement("c", "600036", sourceId, query.from);
  await announcement("other", "600001");
  await announcement("other2", "600002");
  await announcement("sz", "000001", ANNOUNCEMENT_SOURCES.sz);
  await sql`UPDATE stock_announcements SET state='failed',error='private PDF diagnostic' WHERE id=${`${T}-c`}`;
  await sql`INSERT INTO stock_announcement_scans(source_id,day,expected_count,complete,updated_at)
    VALUES (${sourceId},${day},4,true,${now}),(${sourceId},${query.from},3,false,${now})`;
});
after(async () => {
  await app.close();
  await sql`DELETE FROM stock_announcements WHERE id LIKE ${`${T}-%`}`;
  await sql`DELETE FROM stock_announcement_scans WHERE source_id=${sourceId} AND day IN (${day},${query.from})`;
  for (const id of articleIds) await sql`DELETE FROM articles WHERE id=${id}`;
  for (const id of Object.values(ANNOUNCEMENT_SOURCES)) {
    const original = originalSources.find((s) => s.id === id);
    if (original) await sql`UPDATE sources SET enabled=${original.enabled},health=${original.health},participation_mode=${original.participation_mode},
      last_ok_at=${original.last_ok_at},last_fetch_at=${original.last_fetch_at} WHERE id=${id}`;
    else await sql`DELETE FROM sources WHERE id=${id}`;
  }
  await closeDb();
});

test("public lookup includes baseline and unselected indexes, filters exact code, and performs no processing", async () => {
  const before = await sql`SELECT state,article_id,promoted_at FROM stock_announcements WHERE id LIKE ${`${T}-%`} ORDER BY id`;
  const receipts = (await sql`SELECT count(*)::int AS n FROM receipts`)[0].n;
  const response = await app.inject(path);
  assert.equal(response.statusCode, 200);
  const body: StockAnnouncementsResponse = response.json();
  assert.equal(body.items.length, 3);
  assert.ok(body.items.every((i) => i.code === "600036" && i.baseline && i.bodyStatus === null && i.article === null));
  assert.equal(body.items.find((i) => i.id === `${T}-c`)?.processingState, "failed");
  assert.ok(!response.body.includes("private PDF diagnostic"));
  assert.equal(body.items[0].title, "普通公告");
  assert.equal(body.items[0].firstSeenAt, now.toISOString());
  assert.match(body.items[0].links.original, /^https:\/\/static\.cninfo\.com\.cn\//);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, receipts);
  assert.deepEqual(await sql`SELECT state,article_id,promoted_at FROM stock_announcements WHERE id LIKE ${`${T}-%`} ORDER BY id`, before);
  assert.equal(body.coverage.days[1].indexedCount, 4, "scan counts describe the market, not this security");
  const sz = await app.inject(`/api/v1/stock/announcements?market=sz&code=000001&from=${day}&to=${day}`);
  assert.equal(sz.json().items[0].code, "000001", "leading zeros survive");
});

test("coverage distinguishes complete scans, unfinished scans, missing dates, stale sources and retention", async () => {
  const body = await stockAnnouncements({ ...query, from: "2024-04-09" }, now);
  assert.deepEqual(body.coverage.days[0].gaps, ["not_scanned"]);
  assert.equal(body.coverage.days[0].scanComplete, null);
  assert.equal(body.coverage.days[1].scanComplete, false);
  assert.deepEqual(body.coverage.days[1].gaps, ["scan_incomplete", "count_mismatch"]);
  assert.equal(body.coverage.days[2].scanComplete, true);
  assert.deepEqual(body.coverage.days[2].gaps, ["open_day"]);
  const empty = await stockAnnouncements({ ...query, code: "600099" }, now);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.coverage.days[0].scanComplete, false, "an empty security result retains coverage gaps");
  const old = await stockAnnouncements({ ...query, from: "2024-03-01", to: "2024-03-01" }, now);
  assert.ok(old.coverage.days[0].gaps.includes("outside_retention"));
  await sql`UPDATE sources SET enabled=false,health='degraded',last_ok_at=${new Date(now.getTime() - 31 * 60_000)} WHERE id=${sourceId}`;
  const stale = await stockAnnouncements(query, now);
  assert.equal(stale.items.length, 3, "pausing collection keeps public history readable");
  for (const gap of ["source_disabled", "source_degraded", "source_stale"] as const) assert.ok(stale.coverage.days[1].gaps.includes(gap));
  await sql`UPDATE sources SET enabled=true,health='ok',last_ok_at=${now} WHERE id=${sourceId}`;
});

test("keyset pagination handles equal timestamps and binds cursors to market, code and dates", async () => {
  const first = await app.inject(`${path}&limit=1`);
  const page: StockAnnouncementsResponse = first.json();
  assert.equal(page.page.hasMore, true);
  const next = await app.inject(`${path}&limit=2&cursor=${encodeURIComponent(page.page.nextCursor!)}`);
  assert.equal(next.statusCode, 200);
  const rest: StockAnnouncementsResponse = next.json();
  assert.equal(rest.page.hasMore, false);
  assert.equal(new Set([...page.items, ...rest.items].map((i) => i.id)).size, 3);
  for (const changed of [path.replace("600036", "600001"), path.replace(query.from, "2024-04-09"), path.replace("market=sh&code=600036", "market=sz&code=000001")]) {
    const bad = await app.inject(`${changed}&cursor=${encodeURIComponent(page.page.nextCursor!)}`);
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, "invalid_cursor");
  }
});

test("public source scope hides isolated and heat-only indexes and does not leak private diagnostics", async () => {
  for (const mode of ["isolated", "hot_signal"]) {
    await sql`UPDATE sources SET participation_mode=${mode},last_error='private collector diagnostic' WHERE id=${sourceId}`;
    const response = await app.inject(path);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items.length, 0);
    assert.equal(response.json().coverage.source.name, null);
    assert.ok(response.json().coverage.days.every((d: { gaps: string[] }) => d.gaps.includes("source_unavailable")));
    assert.ok(!response.body.includes("private collector diagnostic"));
  }
  await sql`UPDATE sources SET participation_mode='editorial',last_error=NULL WHERE id=${sourceId}`;
});

test("body extraction and public article association remain separate and withdrawals hide the index", async () => {
  const url = `https://static.cninfo.com.cn/finalpage/${day}/456.pdf`;
  const { articleId } = await upsertMaterial({ sourceId, url, title: "已提取公告", bodyText: "正文", bodyStatus: "ok", via: "fetch", publishedAt: now });
  articleIds.push(articleId);
  await sql`UPDATE stock_announcements SET article_id=${articleId},state='queued' WHERE id=${`${T}-a`}`;
  const before = (await app.inject(path)).json().items.find((i: { id: string }) => i.id === `${T}-a`);
  assert.equal(before.processingState, "queued");
  assert.equal(before.bodyStatus, "ok");
  assert.equal(before.article, null, "extraction is not publication");
  await publishArticle(articleId);
  const published = (await app.inject(path)).json().items.find((i: { id: string }) => i.id === `${T}-a`);
  assert.equal(published.article.id, articleId);
  await sql`UPDATE publications SET selected=true,visible_after='2100-01-01' WHERE article_id=${articleId}`;
  const unreleased = (await app.inject(path)).json().items.find((i: { id: string }) => i.id === `${T}-a`);
  assert.equal(unreleased.article, null, "the associated article obeys its release gate");
  await sql`UPDATE publications SET selected=false WHERE article_id=${articleId}`;
  const first = await app.inject(path);
  const unchanged = await app.inject({ url: path, headers: { "if-none-match": String(first.headers.etag) } });
  assert.equal(unchanged.statusCode, 304);
  await setVisibility(articleId, { visibility: "withdrawn", reason: "test withdrawal", version: 0 }, "test");
  const withdrawn = await app.inject({ url: path, headers: { "if-none-match": String(first.headers.etag) } });
  assert.equal(withdrawn.statusCode, 200);
  assert.ok(!withdrawn.json().items.some((i: { id: string }) => i.id === `${T}-a`));
});

test("invalid queries use Problem JSON and OpenAPI describes the new operation", async () => {
  for (const q of ["", "code=600036", "market=xx&code=600036", "market=sz&code=600036", "market=sh&code=60036",
    "market=sh&code=600036&to=invalid", "market=sh&code=600036&to=2024-02-30", "market=sh&code=600036&from=2024-04-12&to=2024-04-11",
    "market=sh&code=600036&from=2024-01-01&to=2024-04-11", "market=sh&code=600036&to=2100-01-01",
    "market=sh&code=600036&limit=0", "market=sh&code=600036&code=600001", "market=sh&code=600036&unknown=x", "market=sh&code=600036&cursor="]) {
    const bad = await app.inject(`/api/v1/stock/announcements?${q}`);
    assert.equal(bad.statusCode, 400, q);
    assert.match(String(bad.headers["content-type"]), /application\/problem\+json/);
  }
  assert.equal((await app.inject({ method: "POST", url: path })).statusCode, 405);
  const doc = (await app.inject("/openapi-v1.json")).json();
  assert.equal(doc.paths["/api/v1/stock/announcements"].get.operationId, "stockAnnouncements");
});
