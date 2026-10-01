import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadPersonalDaily } from "@aihot/backend/publication/personal-daily";
import { renderDaily } from "../apps/api/src/daily/render.ts";
import { buildReadingApp } from "../apps/api/src/daily/app.ts";

const source = `reading-${tag()}`;
const app = buildReadingApp();
after(async () => { await app.close(); await sql`DELETE FROM notification_reports WHERE channel='ai' AND key LIKE '2020-08-01%'`; await closeDb(); });

test("the reading listener exposes no admin or generic API, and previews are opt-in", async () => {
  for (const url of ["/admin", "/api/health", "/api/site/items", "/.env", "/daily/ai/2020-02-30", "/daily/other/2020-08-01"]) {
    assert.equal((await app.inject({ url })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: "POST", url: "/daily/ai/2020-08-01" })).statusCode, 404);
  assert.equal((await app.inject({ url: "/daily/preview/ai" })).statusCode, 404);
  process.env.DAILY_PREVIEW_ENABLED = "true";
  try {
    const response = await app.inject({ url: "/daily/preview/ai" });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes("内容虚构"));
    assert.equal(response.headers["cache-control"], "no-store");
  } finally { delete process.env.DAILY_PREVIEW_ENABLED; }
});

test("daily reading retains full summaries, escapes text and respects withdrawals without model calls", async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${source},'测试来源','rss','T1','editorial','2100-01-01')`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/${source}`, title: "原文", bodyText: "原始正文", bodyStatus: "ok", via: "fetch", discoveredAt: new Date("2020-08-01T00:00:00Z"), publishedAt: new Date("2020-08-01T00:00:00Z") });
  const summary = "完整摘要，不节选。".repeat(80);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','ai-models','<script>alert(1)</script>',${summary},90,true)`;
  await publishArticle(articleId, { now: new Date("2020-08-01T00:00:00Z"), releasedAt: new Date("2020-08-01T00:00:00Z") });
  await sql`INSERT INTO notification_reports(channel,key,window_start,window_end,content)
    VALUES('ai','2020-08-01','2020-07-31','2020-08-02',${sql.json({ entries: [{ itemId: articleId }] })})`;
  const [before] = await sql`SELECT count(*)::int AS count FROM receipts`;
  const report = await loadPersonalDaily("ai", "2020-08-01");
  assert.equal(report!.entries[0].summary, summary);
  const html = renderDaily(report!);
  assert.ok(html.includes(summary));
  assert.ok(html.includes("&lt;script&gt;") && !html.includes("<script>"));
  assert.ok(!renderDaily({ ...report!, entries: [{ ...report!.entries[0], sourceUrl: "javascript:alert(1)" }] }).includes('href="javascript:'));
  assert.equal((await app.inject({ url: "/daily/ai/2020-08-01" })).statusCode, 200);
  const eventUrl = `/event/${articleId}`;
  const event = await app.inject({ url: eventUrl });
  assert.equal(event.statusCode, 200);
  assert.ok(event.body.includes("事件详情") && event.body.includes(summary));
  assert.ok(event.body.includes("&lt;script&gt;") && !event.body.includes("<script>"));
  assert.ok(!event.body.includes("过去 24 小时") && event.body.includes("阅读原文"));
  assert.equal(event.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ method: "POST", url: eventUrl })).statusCode, 404);
  await sql`UPDATE publications SET visible_after=now() + interval '1 hour' WHERE article_id=${articleId}`;
  assert.equal((await app.inject({ url: eventUrl })).statusCode, 404);
  await sql`UPDATE publications SET visible_after='2020-08-01T00:00:00Z' WHERE article_id=${articleId}`;
  await sql`UPDATE publications SET backfill=true, published_at='2020-07-31T12:00:00Z' WHERE article_id=${articleId}`;
  assert.equal((await app.inject({ url: eventUrl })).statusCode, 404);
  assert.equal((await loadPersonalDaily("ai", "2020-08-01"))!.entries.length, 0);
  await sql`UPDATE notification_reports SET content=content || '{"kind":"manual_supplement"}'::jsonb WHERE channel='ai' AND key='2020-08-01'`;
  const supplement = (await loadPersonalDaily("ai", "2020-08-01"))!;
  assert.equal(supplement.entries[0].publishedAt, "2020-07-31T12:00:00.000Z");
  assert.ok(renderDaily(supplement).includes("首日补发"));
  assert.ok(!renderDaily(supplement).includes("过去 24 小时精选"));
  await sql`UPDATE notification_reports SET content=content || ${sql.json({ supplements: [{ key: "1", kind: "manual_supplement",
    windowStart: "2020-08-01T00:00:00Z", windowEnd: "2020-08-02T00:00:00Z", entries: [{ itemId: articleId }] }] })}
    WHERE channel='ai' AND key='2020-08-01'`;
  assert.equal((await loadPersonalDaily("ai", "2020-08-01", new Date(), "1"))!.entries.length, 1);
  assert.equal(await loadPersonalDaily("ai", "2020-08-01", new Date(), "2"), null);
  assert.equal(await loadPersonalDaily("ai", "2020-08-01", new Date(), "../1"), null);
  assert.equal((await app.inject({ url: "/daily/ai/2020-08-01/supplement/1" })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/daily/ai/2020-08-01/supplement/1" })).statusCode, 404);
  assert.equal((await loadPersonalDaily("ai", "2020-08-01"))!.supplement, undefined);
  await sql`INSERT INTO editorial_overrides(article_id,fields) VALUES(${articleId},'{"silent":true}')`;
  assert.equal((await loadPersonalDaily("ai", "2020-08-01"))!.entries.length, 0);
  assert.equal((await loadPersonalDaily("ai", "2020-08-01", new Date(), "1"))!.entries.length, 0);
  await sql`UPDATE editorial_overrides SET fields='{}' WHERE article_id=${articleId}`;
  await sql`UPDATE publications SET backfill=false WHERE article_id=${articleId}`;
  assert.equal((await app.inject({ url: eventUrl })).statusCode, 200);
  await sql`UPDATE editorial_overrides SET fields='{"silent":true}' WHERE article_id=${articleId}`;
  assert.equal((await app.inject({ url: eventUrl })).statusCode, 404);
  await sql`UPDATE editorial_overrides SET fields='{}' WHERE article_id=${articleId}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleId}`;
  assert.equal((await app.inject({ url: eventUrl })).statusCode, 404);
  assert.equal((await loadPersonalDaily("ai", "2020-08-01"))!.entries.length, 0);
  assert.equal((await loadPersonalDaily("ai", "2020-08-01", new Date(), "1"))!.entries.length, 0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM receipts`)[0].count, before.count);
});

test("morning and evening reader addresses resolve independent stored editions", async () => {
  for (const edition of ["morning", "evening"]) {
    await sql`INSERT INTO notification_reports(channel,key,window_start,window_end,content)
      VALUES('ai',${`2020-08-01:${edition}`},'2020-07-31T12:00:00Z','2020-08-01T00:00:00Z','{"entries":[]}')`;
    const response = await app.inject({ url: `/daily/ai/2020-08-01/${edition}` });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes(edition === "morning" ? "AI 前沿早报" : "AI 前沿晚报"));
    assert.ok(!response.body.includes("过去 24 小时精选"));
    assert.equal((await app.inject({ method: "POST", url: `/daily/ai/2020-08-01/${edition}` })).statusCode, 404);
  }
  assert.equal((await app.inject({ url: "/daily/ai/2020-08-01/night" })).statusCode, 404);
  assert.equal((await app.inject({ url: "/daily/ai/2020-08-02/morning" })).statusCode, 404);
});
