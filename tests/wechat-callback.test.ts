import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { sql, closeDb } from "@aihot/backend/db";
import { registerWechatCallback } from "../apps/api/src/routes/wechat.ts";
import { parseWechatCallback, applyWechatDeliveryEvent, recordWechatSend, validWechatSignature } from "@aihot/backend/notify/wechat-callback";
import { createWechatSender } from "@aihot/backend/notify/wechat";
import { configureWechatMenu, wechatMenu } from "@aihot/backend/notify/wechat-menu";
import { answerWechatQuery } from "@aihot/backend/notify/wechat-query";
import { listPersonalDailies } from "@aihot/backend/publication/personal-daily";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { buildReadingApp } from "../apps/api/src/daily/app.ts";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

const token = "testCallbackToken0123456789";
Object.assign(process.env, { WECHAT_CALLBACK_TOKEN: token, WECHAT_CALLBACK_ENABLED: "true", WECHAT_OPEN_ID: "test-owner", WECHAT_APP_ID: "test-app", WECHAT_APP_SECRET: "test-secret", WECHAT_TEMPLATE_ID: "test-template", DAILY_PUBLIC_BASE_URL: "https://news.example.com" });
const app = Fastify();
let queries = 0;
registerWechatCallback(app, async command => { queries++; return `已保存结果 ${command} ]]>`; });
const signed = (timestamp = String(Math.floor(Date.now() / 1000))) => {
  const nonce = "test-nonce";
  return new URLSearchParams({ timestamp, nonce, signature: createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex") }).toString();
};
const xml = (fields: Record<string, string> = {}) => `<xml>${Object.entries({ ToUserName: "test-account", FromUserName: "test-owner", CreateTime: String(Math.floor(Date.now() / 1000)), MsgType: "text", MsgId: "12345", Content: "AI", ...fields }).map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`).join("")}</xml>`;
const inject = (body: string, query = signed()) => app.inject({ method: "POST", url: `/wechat/callback?${query}`, headers: { "content-type": "text/xml" }, payload: body });
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("verification checks secret signature, expiry and opt-in without exposing credentials", async () => {
  const r = await app.inject({ url: `/wechat/callback?${signed()}&echostr=wxcheck` });
  assert.equal(r.statusCode, 200); assert.equal(r.body, "wxcheck"); assert.equal(r.headers["cache-control"], "no-store");
  assert.equal((await app.inject({ url: "/wechat/callback?signature=no&echostr=x" })).statusCode, 403);
  assert.equal(validWechatSignature(Object.fromEntries(new URLSearchParams(signed("1000000000")))), false);
  process.env.WECHAT_CALLBACK_ENABLED = "false";
  assert.equal((await app.inject({ url: `/wechat/callback?${signed()}&echostr=x` })).statusCode, 404);
  process.env.WECHAT_CALLBACK_ENABLED = "true";
});

test("only owner queries run, retries reuse reply and XML cannot inject entities or duplicate fields", async () => {
  const before = queries;
  assert.equal((await inject(xml({ FromUserName: "other-user" }))).body, "success"); assert.equal(queries, before);
  const first = await inject(xml()); const retry = await inject(xml());
  assert.equal(first.statusCode, 200); assert.equal(retry.body, first.body); assert.equal(queries, before + 1);
  assert.match(first.body, /\]\]\]\]><!\[CDATA\[>/);
  assert.equal((await inject(xml(), "signature=bad")).statusCode, 403);
  assert.equal((await inject('<!DOCTYPE xml [<!ENTITY x SYSTEM "file:///etc/passwd">]><xml>&x;</xml>')).statusCode, 400);
  assert.equal(parseWechatCallback(xml().replace('</xml>', '<FromUserName>other</FromUserName></xml>')), null);
  assert.equal(parseWechatCallback(xml({ Encrypt: "ciphertext" })), null);
  assert.equal((await inject("x".repeat(17000))).statusCode, 413);
});

test("menu click and unknown events do not create paid requests", async () => {
  const [before] = await sql`SELECT count(*)::int AS n FROM receipts`;
  const r = await inject(xml({ MsgType: "event", Event: "CLICK", EventKey: "NEWS_STATUS", MsgId: "22222" }));
  assert.match(r.body, /NEWS_STATUS/);
  assert.equal((await inject(xml({ MsgType: "event", Event: "VIEW" }))).body, "success");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n, before!.n);
});

test("a slow lookup returns within WeChat's response deadline", async () => {
  const slow = Fastify();
  let timer: ReturnType<typeof setTimeout>;
  registerWechatCallback(slow, () => new Promise(resolve => { timer = setTimeout(() => resolve("late result"), 10_000); }));
  try {
    const start = Date.now();
    const r = await slow.inject({ method: "POST", url: `/wechat/callback?${signed()}`, headers: { "content-type": "text/xml" }, payload: xml({ MsgId: "33333" }) });
    assert.equal(r.statusCode, 200); assert.match(r.body, /查询暂时较慢/);
    assert.ok(Date.now() - start < 4800);
  } finally { clearTimeout(timer!); await slow.close(); }
});

async function delivery(messageId: string) {
  const target = `callback-${tag()}`;
  await sql`INSERT INTO notify_targets(key,purpose,kind,enabled) VALUES(${target},'content','wechat_template',false)`;
  const [row] = await sql`INSERT INTO deliveries(target_key,subject_kind,subject_id,dedupe_key,status)
    VALUES(${target},'daily_report','test',${tag()},'sending') RETURNING id`;
  return { id: Number(row!.id), messageId };
}
const event = (messageId: string, status = "success") => parseWechatCallback(xml({ MsgType: "event", Event: "TEMPLATESENDJOBFINISH", MsgID: messageId, Status: status }))!;

test("64-bit IDs survive API parsing and receipts reconcile before or after acceptance", async () => {
  const messageId = "18446744073709551615";
  const send = createWechatSender(async url => String(url).includes("/token?") ? new Response('{"access_token":"test-token","expires_in":7200}')
    : new Response(`{"errcode":0,"msgid":${messageId}}`));
  const result = await send({ title: "测试", summary: "正文", source: "本地", time: "现在" });
  assert.equal(result.messageId, messageId); assert.match(result.response, new RegExp(messageId));
  const early = await delivery(messageId);
  await applyWechatDeliveryEvent(event(messageId));
  await recordWechatSend(early.id, result);
  const [saved] = await sql`SELECT status,wechat_message_id,wechat_delivery_status FROM deliveries WHERE id=${early.id}`;
  assert.equal(saved!.status, "sent"); assert.equal(saved!.wechat_message_id, messageId); assert.equal(saved!.wechat_delivery_status, "success");
  await applyWechatDeliveryEvent(event(messageId, "failed:user block"));
  assert.equal((await sql`SELECT wechat_delivery_status FROM deliveries WHERE id=${early.id}`)[0]!.wechat_delivery_status, "success");
  const late = await delivery("200163840");
  await recordWechatSend(late.id, { status: "sent", messageId: late.messageId, response: "accepted" });
  const r = await inject(xml({ MsgType: "event", Event: "TEMPLATESENDJOBFINISH", MsgID: late.messageId, Status: "failed:user block" }));
  assert.equal(r.body, "success");
  assert.equal((await sql`SELECT wechat_delivery_status FROM deliveries WHERE id=${late.id}`)[0]!.wechat_delivery_status, "user_block");
  assert.equal((await sql`SELECT count(*)::int AS n FROM wechat_delivery_events WHERE message_id=${messageId}`)[0]!.n, 1);
});

test("a new send replaces the prior attempt's callback and reconciles an early new callback", async () => {
  const oldId = "200163841", newId = "200163842";
  const row = await delivery(oldId);
  await recordWechatSend(row.id, { status: "sent", messageId: oldId, response: "accepted" });
  await applyWechatDeliveryEvent(event(oldId, "failed:user block"));
  await applyWechatDeliveryEvent(event(newId));
  await recordWechatSend(row.id, { status: "sent", messageId: newId, response: "accepted again" });
  const [saved] = await sql`SELECT wechat_message_id,wechat_delivery_status FROM deliveries WHERE id=${row.id}`;
  assert.equal(saved.wechat_message_id, newId);
  assert.equal(saved.wechat_delivery_status, "success");
  await recordWechatSend(row.id, { status: "unknown", response: "delivery uncertain" });
  const [unknown] = await sql`SELECT wechat_message_id,wechat_delivery_status,wechat_delivery_at FROM deliveries WHERE id=${row.id}`;
  assert.deepEqual({ ...unknown }, { wechat_message_id: null, wechat_delivery_status: null, wechat_delivery_at: null });
});

test("unknown recipients or unknown status cannot alter a delivery", async () => {
  const other = event("1111111"); other.from = "another-user";
  await applyWechatDeliveryEvent(other); await applyWechatDeliveryEvent(event("1111112", "unexpected"));
  assert.equal((await sql`SELECT 1 FROM wechat_delivery_events WHERE message_id IN ('1111111','1111112')`).length, 0);
});

test("menu configuration backs up old state, verifies new links and does not send messages", async () => {
  const paths: string[] = []; let backedUp = false;
  const menu = wechatMenu("https://news.example.com");
  await configureWechatMenu("private-app", "private-secret", "https://news.example.com", async () => { backedUp = true; }, async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (url.pathname.endsWith("stable_token")) return new Response('{"access_token":"private-token"}');
    if (url.pathname.endsWith("menu/create")) { assert.equal(backedUp, true); assert.deepEqual(JSON.parse(String(init!.body)), menu); return new Response('{"errcode":0}'); }
    return new Response(JSON.stringify({ menu: paths.length < 4 ? { button: [] } : menu }));
  });
  assert.deepEqual(paths, ["/cgi-bin/stable_token", "/cgi-bin/menu/get", "/cgi-bin/menu/create", "/cgi-bin/menu/get"]);
  await assert.rejects(configureWechatMenu("private-app", "private-secret", "https://news.example.com", async () => {}, async () => new Response('{"errcode":48001,"errmsg":"private-secret private-token"}')), /code=48001/);
  assert.throws(() => wechatMenu("http://localhost:3002"));
});

test("latest, archive and keyword replies share publication checks, exclude future editions and make no model calls", async () => {
  const id = `callback-reading-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${id},'测试来源','rss')`;
  const { articleId } = await upsertMaterial({ sourceId: id, url: `https://example.com/${id}`, title: "原文", bodyText: "原始内容", bodyStatus: "ok", via: "fetch", discoveredAt: new Date("2021-08-01T00:00:00Z"), publishedAt: new Date("2021-08-01T00:00:00Z") });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','ai-models','公开标题','公开摘要',90,true)`;
  await publishArticle(articleId, { now: new Date("2021-08-01T00:00:00Z"), releasedAt: new Date("2021-08-01T00:00:00Z") });
  const content = { entries: [{ itemId: articleId }], supplements: [{ key: "1", windowStart: "2021-08-01T00:00:00Z", windowEnd: "2021-08-02T00:00:00Z", entries: [{ itemId: articleId }] }] };
  await sql`INSERT INTO notification_reports(channel,key,window_start,window_end,content) VALUES('ai','2021-08-01','2021-07-31','2021-08-02',${sql.json(content)})`;
  await sql`INSERT INTO notification_reports(channel,key,window_start,window_end,content) VALUES('ai','2099-08-01:morning','2099-07-31','2099-08-02',${sql.json(content)})`;
  const reader = buildReadingApp();
  try {
    const [before] = await sql`SELECT count(*)::int AS n FROM receipts`;
    const list = await listPersonalDailies("ai"); assert.equal(list.find(e => e.key === "2021-08-01" && e.supplement)?.supplement, "1"); assert.equal(list.some(e => e.key.startsWith("2099")), false);
    const latest = await reader.inject({ url: "/daily/ai/latest" }); assert.equal(latest.statusCode, 302); assert.equal(latest.headers.location, list[0]!.path);
    const history = await reader.inject({ url: "/daily/ai/history" }); assert.equal(history.statusCode, 200); assert.match(history.body, /2021-08-01/);
    assert.equal((await reader.inject({ url: "/daily/private/history" })).statusCode, 404);
    assert.match(await answerWechatQuery("AI"), /https:\/\/news.example.com\/daily\/ai\//);
    assert.match(await answerWechatQuery("历史"), /\/daily\/stock\/history/);
    await getBoss();
    assert.match(await answerWechatQuery("状态"), /心跳/);
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleId}`;
    assert.equal((await listPersonalDailies("ai")).some(e => e.key === "2021-08-01"), false);
    assert.doesNotMatch(await answerWechatQuery("AI"), /2021-08-01/);
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0]!.n, before!.n);
  } finally { await reader.close(); await sql`DELETE FROM notification_reports WHERE key IN ('2021-08-01','2099-08-01:morning')`; }
});
