import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { dailyWindow, dailyMessages, dailyPageMessage, previewDaily, pushDaily, catchUpDaily } from "@aihot/backend/notify/daily";
import { pushSelected } from "@aihot/backend/notify/selected";
import { stopBoss } from "@aihot/backend/jobs/queue";
import type { Candidate } from "@aihot/backend/publication/report-candidates";
import { personalEvents, personalFacts } from "@aihot/backend/publication/report-candidates";
import { loadPersonalDaily, listPersonalDailies } from "@aihot/backend/publication/personal-daily";
import { renderDaily } from "../apps/api/src/daily/render.ts";
import { randomUUID } from "node:crypto";

const T = tag();
const SOURCE = `daily-${T}`;
const TARGET = `daily-target-${T}`;
const DAY = new Date("2021-03-02T00:00:00Z"); // Beijing 08:00

test("a page card needs a public HTTPS origin and carries no multi-item long summary", () => {
  const previous = process.env.DAILY_PUBLIC_BASE_URL;
  try {
    for (const value of ["", "http://news.example.com", "https://localhost", "https://127.0.0.1", "https://user:secret@news.example.com", "https://news.example.com/admin"]) {
      process.env.DAILY_PUBLIC_BASE_URL = value;
      assert.equal(dailyPageMessage("ai", "2021-03-02", 9, DAY), null);
    }
    process.env.DAILY_PUBLIC_BASE_URL = "https://news.example.com";
    const card = dailyPageMessage("ai", "2021-03-02", 9, DAY)!;
    assert.equal(card.url, "https://news.example.com/daily/ai/2021-03-02");
    assert.ok([...card.summary].length <= 20);
    assert.ok(card.summary.includes("9"));
    const empty = dailyPageMessage("ai", "2021-03-02", 0, DAY)!;
    assert.ok(empty.summary.includes("本期暂无新增精选"));
    assert.equal(empty.url, card.url);
    assert.ok([...empty.summary].length <= 20);
  } finally { if (previous === undefined) delete process.env.DAILY_PUBLIC_BASE_URL; else process.env.DAILY_PUBLIC_BASE_URL = previous; }
});
before(async () => {
  config.wechatPushEnabled = false;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,first_party,next_fetch_at)
    VALUES (${SOURCE},'官方测试源','rss','T1','editorial',true,'2100-01-01')`;
  await sql`INSERT INTO notify_targets (key,purpose,kind,enabled,enabled_at) VALUES (${TARGET},'content','wechat_template',true,'2021-03-01T00:00:00Z')`;
});
after(async () => {
  await sql`UPDATE notify_targets SET enabled=false WHERE key=${TARGET}`;
  await sql`DELETE FROM notification_reports WHERE key IN ('2021-03-01','2021-03-02','2021-03-03','2021-03-05','2021-05-20','2021-05-21','2021-07-02:morning','2021-07-02:evening','2021-07-03:morning','2022-03-02','2022-03-03','2023-03-02:morning','2024-07-02:evening','2024-07-03:evening')`;
  await stopBoss();
  await closeDb();
});

async function article(label: string, category = "ai-models", discovered = "2021-03-01T23:00:00Z", released = discovered, published: string | null = discovered) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}/${label}`, title: label,
    bodyText: "原始公告正文", bodyStatus: "ok", discoveredAt: new Date(discovered), publishedAt: published ? new Date(published) : undefined, via: "fetch" });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES (${articleId},1,'rule','pass',${category},${label},'测试摘要',90,true)`;
  await publishArticle(articleId, { now: new Date(released), releasedAt: new Date(released) });
  return articleId;
}

test("daily slots use Beijing 08:00 / 18:00 and catch up only the latest due day", () => {
  assert.equal(dailyWindow("ai", new Date("2026-09-30T00:00:00Z")).key, "2026-09-30");
  assert.equal(dailyWindow("ai", new Date("2026-09-29T23:59:59Z")).key, "2026-09-29");
  assert.equal(dailyWindow("stock", new Date("2026-09-30T09:59:59Z")).key, "2026-09-29");
  const stock = dailyWindow("stock", new Date("2026-09-30T10:00:00Z"));
  assert.equal(stock.end.toISOString(), "2026-09-30T10:00:00.000Z");
  assert.equal(stock.end.getTime() - stock.start.getTime(), 86400_000);
});

test("daily projection excludes backfill, silent, withdrawn and ineligible items and keeps delayed releases for tomorrow", async () => {
  const keep = await article("正常 AI");
  const stock = await article("股市新政策", "stock-policy");
  const backfill = await article("历史补采");
  await sql`UPDATE publications SET backfill=true WHERE article_id=${backfill}`;
  const silent = await article("静默资料");
  await sql`INSERT INTO editorial_overrides (article_id,fields) VALUES (${silent},'{"silent":true}')`;
  const withdrawn = await article("撤稿");
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${withdrawn}`;
  const ineligible = await article("排除");
  await sql`UPDATE publications SET eligible=false WHERE article_id=${ineligible}`;
  const delayed = await article("跨期公开", "ai-models", "2021-03-01T23:59:00Z", "2021-03-02T00:00:00Z");
  const ai = await previewDaily("ai", DAY);
  assert.deepEqual(ai.entries.map((e) => e.itemId), [keep]);
  assert.equal(ai.messages[0].url, undefined);
  assert.ok(ai.messages[0].summary.includes(`https://example.com/${T}/正常 AI`));
  assert.deepEqual((await previewDaily("stock", new Date("2021-03-02T10:00:00Z"))).entries.map((e) => e.itemId), [stock]);
  assert.ok((await previewDaily("ai", new Date("2021-03-03T00:00:00Z"))).entries.some((e) => e.itemId === delayed));
});

test("digests aggregate several summaries and preserve every original link across numbered parts", () => {
  const entries = Array.from({ length: 9 }, (_, i) => ({ itemId: `${i}`, category: "ai-models", title: `消息 ${i}`, summary: "摘要",
    sourceName: "官方", sourceUrl: `https://example.com/item/${i}`, sourceId: "source", score: 90 } as Candidate));
  const messages = dailyMessages("ai", "2021-03-02", entries, DAY);
  assert.equal(messages.length, 3);
  assert.ok(messages[0].title.endsWith("（1/3）"));
  for (const e of entries) assert.equal(messages.filter((m) => m.summary.includes(e.sourceUrl)).length, 1);
});

test("a digest is idempotent, transport specific, and retains part identity after withdrawal", async () => {
  for (let i = 0; i < 5; i++) await article(`增量 ${i}`);
  const other = `feishu-daily-${T}`;
  await sql`INSERT INTO notify_targets (key,purpose,kind,enabled) VALUES (${other},'content','feishu_webhook',true)`;
  const result = await pushDaily("ai", DAY);
  assert.ok(result.deliveries.filter((d) => d.target === TARGET).length >= 2);
  const initial = await sql<{ id: number; dedupe_key: string; payload: unknown }[]>`SELECT id,dedupe_key,payload FROM deliveries WHERE target_key=${TARGET} AND subject_kind='daily_report' ORDER BY id`;
  await sql`UPDATE deliveries SET status='unknown' WHERE id=${initial[0].id}`;
  const [stored] = await sql<{ content: { entries: Candidate[] } }[]>`SELECT content FROM notification_reports WHERE channel='ai' AND key='2021-03-02'`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${stored.content.entries[0].itemId}`;
  assert.equal((await pushDaily("ai", DAY)).deliveries.length, 0);
  const later = await sql<{ id: number; dedupe_key: string; payload: unknown }[]>`SELECT id,dedupe_key,payload FROM deliveries WHERE target_key=${TARGET} AND subject_kind='daily_report' ORDER BY id`;
  assert.deepEqual(later, initial);
  assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key=${other} AND subject_kind='daily_report'`).length, 0);
  await sql`UPDATE notify_targets SET enabled=false WHERE key=${other}`;
});

test("a target does not receive articles discovered before it was enabled, including late releases", async () => {
  const old = await article("启用前已采集", "stock-policy", "2021-03-02T01:00:00Z", "2021-03-02T09:00:00Z");
  const after = await article("启用后新增", "stock-policy", "2021-03-02T09:01:00Z");
  const floor = new Date("2021-03-02T08:00:00Z");
  const preview = await previewDaily("stock", new Date("2021-03-02T10:00:00Z"), floor);
  assert.equal(preview.entries.some((e) => e.itemId === old), false);
  assert.equal(preview.entries.some((e) => e.itemId === after), true);
});

test("ordinary selected articles do not create individual WeChat deliveries", async () => {
  const id = await article("普通精选", "ai-models", "2021-03-02T00:30:00Z");
  await pushSelected(id, new Date("2021-03-02T00:40:00Z"));
  assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key=${TARGET} AND subject_kind='selected' AND subject_id=${id}`).length, 0);
});

test("empty catch-up sends one notice per channel, no models, and only the latest due editions", async () => {
  const [before] = await sql`SELECT count(*)::int AS count FROM receipts`;
  const results = await catchUpDaily(new Date("2021-05-21T01:00:00Z"));
  assert.deepEqual(results.map((r) => [r.channel,r.key]), [["ai","2021-05-21"],["stock","2021-05-20"]]);
  assert.ok(results.every((r) => r.entries === 0 && r.deliveries.filter(d => d.target === TARGET).length === 1));
  assert.ok((await catchUpDaily(new Date("2021-05-21T01:00:00Z"))).every(r => r.deliveries.length === 0));
  const deliveries = await sql`SELECT payload FROM deliveries WHERE target_key=${TARGET} AND subject_id IN ('ai:2021-05-21','stock:2021-05-20')`;
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every(d => d.payload.summary.includes("本期暂无新增精选")));
  assert.equal((await sql`SELECT count(*)::int AS count FROM receipts`)[0].count, before.count);
});

test("personal deployment registers only the two daily slots and latest-edition recovery", async () => {
  process.env.PERSONAL_REPORTS_ENABLED = "true";
  const { SCHEDULES } = await import("../apps/worker/src/schedules.ts");
  assert.equal(SCHEDULES.find((s) => s.name === "notify.ai-daily")?.cron, "0 8 * * *");
  assert.equal(SCHEDULES.find((s) => s.name === "notify.stock-daily")?.cron, "0 18 * * *");
  assert.equal(SCHEDULES.some((s) => s.name === "reports.daily" || s.name === "reports.catch-up"), false);
});

test("missing page address reserves no delivery, and configuring it creates only one aggregate card", async () => {
  const mode = process.env.WECHAT_DAILY_MODE;
  const base = process.env.DAILY_PUBLIC_BASE_URL;
  const date = new Date("2021-03-05T00:00:00Z");
  await article("阅读页新内容", "ai-products", "2021-03-04T12:00:00Z");
  try {
    process.env.WECHAT_DAILY_MODE = "page";
    delete process.env.DAILY_PUBLIC_BASE_URL;
    assert.equal((await pushDaily("ai", date)).deliveries.length, 0);
    process.env.DAILY_PUBLIC_BASE_URL = "https://news.example.com";
    const result = await pushDaily("ai", date);
    assert.equal(result.deliveries.filter((r) => r.target === TARGET).length, 1);
    const [row] = await sql<{ payload: { url: string; summary: string } }[]>`SELECT payload FROM deliveries WHERE target_key=${TARGET} AND subject_id='ai:2021-03-05'`;
    assert.equal(row.payload.url, "https://news.example.com/daily/ai/2021-03-05");
    assert.ok([...row.payload.summary].length <= 20);
    assert.equal((await pushDaily("ai", date)).deliveries.length, 0);
  } finally {
    if (mode === undefined) delete process.env.WECHAT_DAILY_MODE; else process.env.WECHAT_DAILY_MODE = mode;
    if (base === undefined) delete process.env.DAILY_PUBLIC_BASE_URL; else process.env.DAILY_PUBLIC_BASE_URL = base;
  }
});

test("both channels use twelve-hour 08:00 and 20:00 editions and latest-only recovery", async () => {
  process.env.PERSONAL_DAILY_TWICE_ENABLED = "true";
  const mode = process.env.WECHAT_DAILY_MODE;
  const base = process.env.DAILY_PUBLIC_BASE_URL;
  try {
    process.env.WECHAT_DAILY_MODE = "page";
    process.env.DAILY_PUBLIC_BASE_URL = "https://news.example.com";
    for (const channel of ["ai", "stock"] as const) {
      const early = dailyWindow(channel, new Date("2021-07-02T07:59:59+08:00"));
      assert.equal(early.reportKey, "2021-07-01:evening");
      const morning = dailyWindow(channel, new Date("2021-07-02T08:00:00+08:00"));
      assert.equal(morning.reportKey, "2021-07-02:morning");
      assert.equal(morning.start.toISOString(), "2021-07-01T12:00:00.000Z");
      assert.equal(morning.end.getTime() - morning.start.getTime(), 12 * 3600_000);
      assert.equal(dailyWindow(channel, new Date("2021-07-02T19:59:59+08:00")).edition, "morning");
      const evening = dailyWindow(channel, new Date("2021-07-02T20:00:00+08:00"));
      assert.equal(evening.reportKey, "2021-07-02:evening");
      assert.equal(evening.start.toISOString(), morning.end.toISOString());
    }
    const am = await article("早报独立内容", "ai-models", "2021-07-01T23:00:00Z");
    const pm = await article("晚报独立内容", "ai-models", "2021-07-02T04:00:00Z");
    const lag = await article("延迟完成进入晚报", "ai-models", "2021-07-01T23:30:00Z", "2021-07-02T01:00:00Z");
    const morning = await pushDaily("ai", new Date("2021-07-02T08:00:00+08:00"));
    assert.equal(morning.entries, 1);
    assert.equal(morning.edition, "morning");
    assert.equal((await pushDaily("ai", new Date("2021-07-02T09:00:00+08:00"))).deliveries.length, 0);
    const eveningPreview = await previewDaily("ai", new Date("2021-07-02T20:00:00+08:00"));
    assert.deepEqual(new Set(eveningPreview.entries.map((e) => e.itemId)), new Set([pm, lag]));
    assert.equal(eveningPreview.entries.some((e) => e.itemId === am), false);
    assert.ok(eveningPreview.messages[0].title.includes("晚报"));
    assert.ok(eveningPreview.messages[0].url!.endsWith("/2021-07-02/evening"));
    assert.equal((await pushDaily("ai", new Date("2021-07-02T20:00:00+08:00"))).entries, 2);
    assert.equal((await pushDaily("ai", new Date("2021-07-02T21:00:00+08:00"))).deliveries.length, 0);
    const reports = await sql`SELECT key FROM notification_reports WHERE channel='ai' AND key LIKE '2021-07-02:%'`;
    assert.equal(reports.length, 2);
    const catchup = await catchUpDaily(new Date("2021-07-03T19:00:00+08:00"));
    assert.ok(catchup.every((r) => r.key === "2021-07-03" && r.edition === "morning"));
    const scheduleModule = "../apps/worker/src/schedules.ts?twice";
    const { SCHEDULES } = await import(scheduleModule) as typeof import("../apps/worker/src/schedules.ts");
    assert.equal(SCHEDULES.find((s) => s.name === "notify.ai-morning")?.cron, "0 8 * * *");
    assert.equal(SCHEDULES.find((s) => s.name === "notify.stock-morning")?.cron, "0 8 * * *");
    assert.equal(SCHEDULES.find((s) => s.name === "notify.ai-evening")?.cron, "0 20 * * *");
    assert.equal(SCHEDULES.find((s) => s.name === "notify.stock-evening")?.cron, "0 20 * * *");
    assert.equal(SCHEDULES.some((s) => /notify\.(ai|stock)-daily/.test(s.name)), false);
  } finally {
    delete process.env.PERSONAL_DAILY_TWICE_ENABLED;
    if (mode === undefined) delete process.env.WECHAT_DAILY_MODE; else process.env.WECHAT_DAILY_MODE = mode;
    if (base === undefined) delete process.env.DAILY_PUBLIC_BASE_URL; else process.env.DAILY_PUBLIC_BASE_URL = base;
  }
});

test("personal grouping uses story identity, retains developments and never merges similar company names", () => {
  const item = (id: string, story: string | null, category = "ai-models") => ({ itemId: id, factKey: `f:${id}`,
    storyPublicId: story, category, title: "同一家公司的公告", summary: "内容", sourceUrl: `https://example.com/${id}` } as Candidate);
  const entries = [item("release", "launch"), item("cloud", "launch"), item("other", "different"), item("ungrouped", null), item("stock", "launch", "stock-company")];
  const events = personalEvents(entries);
  assert.equal(events.length, 4);
  assert.deepEqual(events[0].relatedEntries?.map(e => e.itemId), ["cloud"]);
  assert.deepEqual(personalFacts(events).map(e => e.itemId), entries.map(e => e.itemId));
  assert.deepEqual(personalEvents(events), events);
});

test("one event keeps all sources, promotes a surviving member, and permits a new development next issue", async () => {
  const at = "2022-03-01T23:00:00Z";
  const main = await article("模型发布事实", "ai-models", at);
  const cloud = await article("云端上线事实<script>bad</script>", "ai-models", at);
  const other = await article("同一公司另一个事件", "ai-models", at);
  const standalone = await article("尚未归组的独立事件", "ai-models", at);
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'模型发布与云端上线') RETURNING id`;
  const [separate] = await sql`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},'另一件事') RETURNING id`;
  async function attach(id: string, storyId: number, label: string, factId?: number) {
    const fact = factId ?? (await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${`${T}-${label}`},${storyId},${label}) RETURNING id`)[0].id;
    await sql`UPDATE publications SET fact_id=${fact},story_id=${storyId} WHERE article_id=${id}`;
    return fact as number;
  }
  await attach(main, story.id, "launch");
  const cloudFact = await attach(cloud, story.id, "cloud");
  await attach(other, separate.id, "other");
  const day = new Date("2022-03-02T00:00:00Z");
  const preview = await previewDaily("ai", day);
  assert.equal(preview.entries.length, 3);
  assert.equal(personalFacts(preview.entries).length, 4);
  const mode = process.env.WECHAT_DAILY_MODE, base = process.env.DAILY_PUBLIC_BASE_URL;
  const [receiptsBefore] = await sql`SELECT count(*)::int AS count FROM receipts`;
  try {
    process.env.WECHAT_DAILY_MODE = "page";
    process.env.DAILY_PUBLIC_BASE_URL = "https://news.example.com";
    await pushDaily("ai", day);
    const [delivery] = await sql`SELECT payload FROM deliveries WHERE target_key=${TARGET} AND subject_id='ai:2022-03-02'`;
    assert.ok(delivery.payload.summary.includes("精选 3 条"));
    let report = (await loadPersonalDaily("ai", "2022-03-02", day))!;
    assert.equal(report.entries.length, 3);
    const html = renderDaily(report);
    assert.equal((html.match(/<article>/g) ?? []).length, 3);
    assert.equal((html.match(/<details>/g) ?? []).length, 1);
    assert.ok(html.includes("&lt;script&gt;") && !html.includes("<script>"));
    for (const id of [main, cloud, other, standalone]) {
      const [p] = await sql`SELECT url FROM publications WHERE article_id=${id}`;
      assert.ok(html.includes(new URL(p.url).href.replace(/&/g, "&amp;")));
    }
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${main}`;
    report = (await loadPersonalDaily("ai", "2022-03-02", day))!;
    assert.equal(report.entries.length, 3);
    assert.ok(!renderDaily(report).includes("模型发布事实"));
    assert.ok(renderDaily(report).includes("云端上线事实"));
    assert.equal((await pushDaily("ai", day)).deliveries.length, 0);
    const [stored] = await sql`SELECT content FROM notification_reports WHERE channel='ai' AND key='2022-03-02'`;
    await sql`UPDATE notification_reports SET content=${sql.json({ entries: personalFacts(stored.content.entries) } as never)}
      WHERE channel='ai' AND key='2022-03-02'`;
    assert.equal((await loadPersonalDaily("ai", "2022-03-02", day))!.entries.length, 3);
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${cloud}`;
    assert.equal((await loadPersonalDaily("ai", "2022-03-02", day))!.entries.length, 2);

    const repeat = await article("云端上线的重复报道", "ai-models", "2022-03-02T23:00:00Z");
    await attach(repeat, story.id, "reprint", cloudFact);
    const update = await article("该模型后续新进展", "ai-models", "2022-03-02T23:00:00Z");
    await attach(update, story.id, "later");
    const next = await previewDaily("ai", new Date("2022-03-03T00:00:00Z"));
    assert.deepEqual(personalFacts(next.entries).map(e => e.itemId), [update]);
    assert.equal((await sql`SELECT count(*)::int AS count FROM receipts`)[0].count, receiptsBefore.count);
  } finally {
    if (mode === undefined) delete process.env.WECHAT_DAILY_MODE; else process.env.WECHAT_DAILY_MODE = mode;
    if (base === undefined) delete process.env.DAILY_PUBLIC_BASE_URL; else process.env.DAILY_PUBLIC_BASE_URL = base;
  }
});


test("page delivery counts the same frozen edition as reading, including members collected before enablement", async () => {
  const mode = process.env.WECHAT_DAILY_MODE;
  const base = process.env.DAILY_PUBLIC_BASE_URL;
  const [target] = await sql<{ enabled_at: Date }[]>`SELECT enabled_at FROM notify_targets WHERE key=${TARGET}`;
  try {
    process.env.WECHAT_DAILY_MODE = "page";
    process.env.DAILY_PUBLIC_BASE_URL = "https://news.example.com";
    await sql`UPDATE notify_targets SET enabled_at='2023-03-01T22:00:00Z' WHERE key=${TARGET}`;
    const old = await article("启用前采集但属于本期", "ai-models", "2023-03-01T21:00:00Z");
    await article("启用后采集且属于本期", "ai-models", "2023-03-01T23:00:00Z");
    const now = new Date("2023-03-02T00:00:00Z");
    const delivered = await pushDaily("ai", now, "morning");
    const read = await loadPersonalDaily("ai", "2023-03-02", now, undefined, "morning");
    assert.equal(delivered.entries, 2);
    assert.equal(read!.entries.length, delivered.entries);
    const [delivery] = await sql<{ payload: { summary: string } }[]>`SELECT payload FROM deliveries WHERE target_key=${TARGET} AND subject_id='ai:2023-03-02:morning'`;
    assert.ok(delivery.payload.summary.includes("2 条"));
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${old}`;
    const later = await pushDaily("ai", now, "morning");
    assert.equal(later.entries, 1);
    assert.equal(later.deliveries.length, 0);
    assert.deepEqual((await loadPersonalDaily("ai", "2023-03-02", now, undefined, "morning"))!.entries.map(e=>e.title), ["启用后采集且属于本期"]);
    await sql`UPDATE notify_targets SET enabled_at='2023-03-02T01:00:00Z' WHERE key=${TARGET}`;
    assert.equal((await pushDaily("stock", now, "morning")).deliveries.length, 0);
  } finally {
    await sql`UPDATE notify_targets SET enabled_at=${target.enabled_at} WHERE key=${TARGET}`;
    if (mode === undefined) delete process.env.WECHAT_DAILY_MODE; else process.env.WECHAT_DAILY_MODE = mode;
    if (base === undefined) delete process.env.DAILY_PUBLIC_BASE_URL; else process.env.DAILY_PUBLIC_BASE_URL = base;
  }
});

test("dated reading separates original, collection and inclusion times and identifies delayed analysis", async () => {
  const delayed = await article("旧稿补分析", "ai-models", "2024-07-01T23:50:00Z", "2024-07-02T02:30:00Z", "2024-07-01T04:00:00Z");
  await article("本期新稿", "ai-models", "2024-07-02T02:00:00Z", "2024-07-02T02:01:00Z", "2024-07-02T01:00:00Z");
  await article("本期采集的较早原文", "ai-models", "2024-07-02T02:02:00Z", "2024-07-02T02:03:00Z", "2024-07-01T04:00:00Z");
  await article("没有原文日期", "ai-models", "2024-07-02T02:04:00Z", "2024-07-02T02:05:00Z", null);
  const now = new Date("2024-07-02T12:00:00Z");
  const preview = await previewDaily("ai", now, undefined, "evening");
  const candidate = preview.entries.find(e => e.itemId === delayed)!;
  assert.equal(candidate.originalPublishedAt, "2024-07-01T04:00:00.000Z");
  assert.equal(candidate.discoveredAt, "2024-07-01T23:50:00.000Z");
  assert.equal(candidate.includedAt, "2024-07-02T02:30:00.000Z");
  assert.equal(candidate.delayedAnalysis, true);
  await pushDaily("ai", now, "evening");
  const report = (await loadPersonalDaily("ai", "2024-07-02", now, undefined, "evening"))!;
  const entry = report.entries.find(e => e.title === "旧稿补分析")!;
  assert.equal(entry.publishedAt, candidate.originalPublishedAt);
  assert.equal(entry.discoveredAt, candidate.discoveredAt);
  assert.equal(entry.includedAt, candidate.includedAt);
  assert.equal(entry.delayedAnalysis, true);
  assert.equal(report.entries.find(e => e.title === "本期新稿")!.delayedAnalysis, false);
  assert.equal(report.entries.find(e => e.title === "本期采集的较早原文")!.delayedAnalysis, false);
  assert.equal(report.entries.find(e => e.title === "没有原文日期")!.publishedAt, null);
  const html = renderDaily(report);
  assert.ok(html.includes("原文发布时间 2024-07-01 12:00"));
  assert.ok(html.includes("采集时间 2024-07-02 07:50"));
  assert.ok(html.includes("收录时间 2024-07-02 10:30"));
  assert.equal((html.match(/跨期补分析/g) ?? []).length, 1);
  assert.ok(html.includes("较早发布 · 本期收录"));
  assert.ok(html.includes("原文发布时间 信源未提供"));
});

test("a previously populated edition becoming withdrawn does not send a no-news notice", async () => {
  const mode = process.env.WECHAT_DAILY_MODE, base = process.env.DAILY_PUBLIC_BASE_URL;
  const now = new Date("2024-07-03T12:00:00Z");
  const id = await article("待撤回事件", "ai-models", "2024-07-03T02:00:00Z");
  try {
    process.env.WECHAT_DAILY_MODE = "page";
    delete process.env.DAILY_PUBLIC_BASE_URL;
    assert.equal((await pushDaily("ai", now, "evening")).deliveries.length, 0);
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${id}`;
    process.env.DAILY_PUBLIC_BASE_URL = "https://news.example.com";
    const result = await pushDaily("ai", now, "evening");
    assert.equal(result.entries, 0);
    assert.equal(result.deliveries.length, 0);
    assert.equal((await listPersonalDailies("ai", now)).some(e => e.key === "2024-07-03"), false);
  } finally {
    if (mode === undefined) delete process.env.WECHAT_DAILY_MODE; else process.env.WECHAT_DAILY_MODE = mode;
    if (base === undefined) delete process.env.DAILY_PUBLIC_BASE_URL; else process.env.DAILY_PUBLIC_BASE_URL = base;
  }
});

test("page-mode empty editions send one short card per channel and remain idempotent", async () => {
  const mode = process.env.WECHAT_DAILY_MODE, base = process.env.DAILY_PUBLIC_BASE_URL;
  const now = new Date("2024-07-04T00:00:00Z");
  const [before] = await sql`SELECT count(*)::int AS count FROM receipts`;
  try {
    process.env.WECHAT_DAILY_MODE = "page";
    process.env.DAILY_PUBLIC_BASE_URL = "https://news.example.com";
    for (const channel of ["ai", "stock"] as const) {
      const first = await pushDaily(channel, now, "morning");
      assert.equal(first.entries, 0);
      assert.equal(first.deliveries.filter(d => d.target === TARGET).length, 1);
      assert.equal((await pushDaily(channel, now, "morning")).deliveries.length, 0);
      const [delivery] = await sql`SELECT payload FROM deliveries WHERE target_key=${TARGET} AND subject_id=${`${channel}:2024-07-04:morning`}`;
      assert.ok(delivery.payload.summary.includes("本期暂无新增精选"));
      assert.equal(delivery.payload.url, `https://news.example.com/daily/${channel}/2024-07-04/morning`);
      const readable = (await loadPersonalDaily(channel, "2024-07-04", now, undefined, "morning"))!;
      assert.equal(readable.noNewSelection, true);
      assert.equal(readable.entries.length, 0);
    }
    assert.equal((await sql`SELECT count(*)::int AS count FROM receipts`)[0].count, before.count);
  } finally {
    await sql`DELETE FROM notification_reports WHERE key='2024-07-04:morning'`;
    if (mode === undefined) delete process.env.WECHAT_DAILY_MODE; else process.env.WECHAT_DAILY_MODE = mode;
    if (base === undefined) delete process.env.DAILY_PUBLIC_BASE_URL; else process.env.DAILY_PUBLIC_BASE_URL = base;
  }
});
