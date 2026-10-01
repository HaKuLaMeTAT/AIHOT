import { enableLocalModelStub, stub, tag } from "./setup.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { urgentAssessment, urgentDecision, urgentEnabled, supportedUrgency } from "@aihot/backend/notify/urgent";
import { urgentWechat } from "@aihot/backend/notify/selected";
import { selectedNotification } from "@aihot/backend/publication/notification";
import { stopBoss } from "@aihot/backend/jobs/queue";
const T = tag();
const SOURCE = `urgent-${T}`;
const body = "正式实施资本市场重大制度调整，适用于全体市场参与者。";
const longQuote = body + "原文提供制度生效范围与执行依据。".repeat(20);
const provider = await stub((hit, req) => ({ id: `urgent-${hit}`,
  choices: [{ message: { content: JSON.stringify({ urgent: true, reason: "正式政策广泛影响市场", evidence: req.body.includes("长引用") ? longQuote : req.body.includes("捏造证据") ? "原文没有这段话" : body,
    cardTitle: req.body.includes("过长卡片") ? "很长的机构名称与标题".repeat(5) : "资本市场重大制度调整",
    cardSummary: "正式实施，覆盖全体参与者" }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
Object.assign(process.env, { URGENT_MODEL: "deepseek-flash", DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: `${provider.url}/v1` });
before(async () => {
  await enableLocalModelStub(provider.url);
  config.wechatPushEnabled = false;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,first_party,next_fetch_at)
    VALUES (${SOURCE},'官方','rss','T1','editorial',true,'2100-01-01')`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });
async function article(label: string, firstParty = true) {
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/urgent/${T}/${label}`, title: label,
    bodyText: label === "长引用" ? longQuote : body, bodyStatus: "ok", discoveredAt: new Date(), via: "fetch" });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','stock-policy',${label},'公开原文摘要',90,true)`;
  await publishArticle(articleId);
  await sql`UPDATE publications SET first_party=${firstParty} WHERE article_id=${articleId}`;
  return articleId;
}
test("urgency needs an exact nonempty original quote, even when the model says true", () => {
  assert.equal(supportedUrgency({ urgent: true, reason: "", evidence: "" }, body), false);
  assert.equal(supportedUrgency({ urgent: true, reason: "", evidence: "模型编造" }, body), false);
  assert.equal(supportedUrgency({ urgent: false, reason: "", evidence: body }, body), false);
  assert.equal(supportedUrgency({ urgent: true, reason: "", evidence: body }, body), true);
});
test("disabled WeChat never initiates paid urgency classification", async () => {
  assert.equal(await urgentEnabled(new Date()), false);
  assert.equal(provider.hits(), 0);
});
test("an unconfigured dedicated urgent template prevents extra model work", async () => {
  const separate = process.env.WECHAT_SEPARATE_TEMPLATES;
  const template = process.env.WECHAT_URGENT_TEMPLATE_ID;
  config.wechatPushEnabled = true;
  process.env.WECHAT_SEPARATE_TEMPLATES = "true";
  delete process.env.WECHAT_URGENT_TEMPLATE_ID;
  try { assert.equal(await urgentEnabled(new Date()), false); assert.equal(provider.hits(), 0); }
  finally {
    config.wechatPushEnabled = false;
    if (separate === undefined) delete process.env.WECHAT_SEPARATE_TEMPLATES; else process.env.WECHAT_SEPARATE_TEMPLATES = separate;
    if (template === undefined) delete process.env.WECHAT_URGENT_TEMPLATE_ID; else process.env.WECHAT_URGENT_TEMPLATE_ID = template;
  }
});
test("a verified decision is persisted with a receipt and reused without another model call", async () => {
  const id = await article("正式政策");
  assert.equal(await urgentDecision(id), true);
  const hits = provider.hits();
  assert.equal(await urgentDecision(id), true);
  assert.equal(provider.hits(), hits);
  const assessment = await urgentAssessment(id);
  assert.equal(provider.hits(), hits);
  assert.equal(assessment.cardTitle, "资本市场重大制度调整");
  const previousBase = process.env.DAILY_PUBLIC_BASE_URL;
  try {
    process.env.DAILY_PUBLIC_BASE_URL = "https://news.example.com";
    const message = urgentWechat((await selectedNotification(id))!, assessment);
    assert.equal(message.title, assessment.cardTitle);
    assert.equal(message.summary, assessment.cardSummary);
    assert.equal(message.url, `https://news.example.com/event/${id}`);
    assert.ok(!message.title.includes("重大事件｜") && !message.summary.includes("…"));
    delete process.env.DAILY_PUBLIC_BASE_URL;
    assert.equal(urgentWechat((await selectedNotification(id))!, assessment).url, `https://example.com/urgent/${T}/正式政策`);
  } finally { if (previousBase === undefined) delete process.env.DAILY_PUBLIC_BASE_URL; else process.env.DAILY_PUBLIC_BASE_URL = previousBase; }
  const [saved] = await sql<{ status: string; urgent: boolean }[]>`SELECT r.status,u.urgent FROM notification_urgency u JOIN receipts r ON r.id=u.receipt_id WHERE u.article_id=${id}`;
  assert.equal(saved.status, "completed");
  assert.equal(saved.urgent, true);
});
test("unsupported quotes and secondary sources cannot trigger an urgent interruption", async () => {
  assert.equal(await urgentDecision(await article("捏造证据")), false);
  const hits = provider.hits();
  assert.equal(await urgentDecision(await article("媒体转述", false)), false);
  assert.equal(provider.hits(), hits);
});

test("overlong card copy is rejected rather than silently truncated and saved", async () => {
  const id = await article("过长卡片");
  await assert.rejects(urgentAssessment(id));
  assert.equal((await sql`SELECT 1 FROM notification_urgency WHERE article_id=${id}`).length, 0);
});

test("a long exact quote is fully verified before storing its bounded excerpt", async () => {
  const id = await article("长引用");
  assert.equal((await urgentAssessment(id)).urgent, true);
  const [saved] = await sql`SELECT evidence FROM notification_urgency WHERE article_id=${id}`;
  assert.equal(saved.evidence.length, 180);
  assert.ok(longQuote.includes(saved.evidence));
  const forged = saved.evidence + "伪造的后半段";
  assert.equal(supportedUrgency({ urgent: true, reason: "", evidence: forged }, longQuote), false);
});
