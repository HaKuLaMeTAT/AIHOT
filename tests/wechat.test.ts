import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { briefWechat, createWechatSender, wechatVerificationSignature } from "@aihot/backend/notify/wechat";
import { deliverContent } from "@aihot/backend/notify/deliver";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
const msg = { title: "公开政策", summary: "核对公告原文", source: "官方", time: "2026-09-30", url: "https://example.com/news" };
Object.assign(process.env, { WECHAT_APP_ID: "test-app", WECHAT_APP_SECRET: "test-secret", WECHAT_OPEN_ID: "test-user", WECHAT_TEMPLATE_ID: "test-template" });
const response = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

test("instant fields are short Unicode text while the original jump remains intact", () => {
  const result = briefWechat({ ...msg, title: "重大事件｜" + "模型更新😀".repeat(10), summary: "摘要\n".repeat(20) });
  assert.ok([...result.title].length <= 20 && [...result.summary].length <= 20);
  assert.ok(!result.summary.includes("\n"));
  assert.equal(result.url, msg.url);
  assert.ok(!result.title.includes("\ufffd"));
});

test("each purpose selects its own template and a missing template reserves no delivery", async () => {
  const keys = ["WECHAT_SEPARATE_TEMPLATES", "WECHAT_AI_DAILY_TEMPLATE_ID", "WECHAT_STOCK_DAILY_TEMPLATE_ID", "WECHAT_URGENT_TEMPLATE_ID"];
  const previous = keys.map((k) => process.env[k]);
  const used: string[] = [];
  try {
    Object.assign(process.env, { WECHAT_SEPARATE_TEMPLATES: "true", WECHAT_AI_DAILY_TEMPLATE_ID: "test-ai", WECHAT_STOCK_DAILY_TEMPLATE_ID: "test-stock", WECHAT_URGENT_TEMPLATE_ID: "test-urgent" });
    const signature = wechatVerificationSignature();
    const send = createWechatSender(async (url, init) => {
      if (String(url).includes("/token?")) return response({ access_token: "test-token", expires_in: 7200 });
      const body = JSON.parse(String(init!.body));
      used.push(body.template_id);
      assert.ok(!("template" in body.data));
      return response({ errcode: 0, msgid: used.length });
    });
    for (const template of ["ai_daily", "stock_daily", "urgent"] as const) assert.equal((await send({ ...msg, template })).status, "sent");
    assert.deepEqual(used, ["test-ai", "test-stock", "test-urgent"]);
    delete process.env.WECHAT_URGENT_TEMPLATE_ID;
    assert.notEqual(wechatVerificationSignature(), signature);
    assert.equal((await send({ ...msg, template: "urgent" })).status, "failed");
    assert.equal(used.length, 3);
    const target = `templates-${tag()}`;
    await sql`INSERT INTO notify_targets(key,purpose,kind,enabled) VALUES(${target},'content','wechat_template',true)`;
    await deliverContent({ subjectKind: "selected", subjectId: tag(), dedupeKey: tag(), contentAt: new Date(), card: {}, wechat: { ...msg, template: "urgent" }, targetKey: target });
    assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key=${target}`).length, 0);
    await sql`UPDATE notify_targets SET enabled=false WHERE key=${target}`;
  } finally { keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; }); }
});

test("token refusals report only a safe code and never provider text or secrets", async () => {
  const send = createWechatSender(async () => response({ errcode: 40164, errmsg: 'private-token test-secret reflected by upstream' }));
  const result = await send({ title: '测试', summary: '正文', source: '本地', time: '现在' });
  assert.equal(result.status, 'failed');
  assert.match(result.response, /40164/);
  assert.ok(!result.response.includes('private-token') && !result.response.includes('test-secret'));
});
after(closeDb);
test("token is reused and the template points to the original article", async () => {
  let tokens = 0, sends = 0;
  const send = createWechatSender(async (url, init) => {
    if (String(url).includes("/token?")) { tokens++; return response({ access_token: "private-token", expires_in: 7200 }); }
    sends++;
    const body = JSON.parse(String(init!.body));
    assert.equal(body.url, msg.url);
    assert.equal(body.data.title.value, msg.title);
    assert.equal(body.touser, "test-user");
    return response({ errcode: 0, msgid: sends });
  });
  assert.equal((await send(msg)).status, "sent");
  assert.equal((await send(msg)).status, "sent");
  assert.equal(tokens, 1); assert.equal(sends, 2);
});
test("only a definitive invalid-token rejection refreshes and resends", async () => {
  let tokens = 0, sends = 0;
  const send = createWechatSender(async (url) => {
    if (String(url).includes("/token?")) { tokens++; return response({ access_token: `t${tokens}`, expires_in: 7200 }); }
    return response({ errcode: ++sends === 1 ? 40001 : 0, msgid: 1 });
  });
  assert.equal((await send(msg)).status, "sent");
  assert.equal(tokens, 2); assert.equal(sends, 2);
});
test("ambiguous sends are not retried and errors do not leak secrets", async () => {
  let sends = 0;
  const send = createWechatSender(async (url) => {
    if (String(url).includes("/token?")) return response({ access_token: "private-token", expires_in: 7200 });
    sends++; throw new Error("private-token test-secret");
  });
  const r = await send(msg);
  assert.equal(r.status, "unknown"); assert.equal(sends, 1);
  assert.ok(!r.response.includes("private-token") && !r.response.includes("test-secret"));
});
test("disabled valve records one skipped delivery; earlier items are excluded", async () => {
  config.wechatPushEnabled = false;
  const key = `wechat-${tag()}`;
  await sql`INSERT INTO notify_targets (key,purpose,kind,enabled,enabled_at) VALUES (${key},'content','wechat_template',true,now() - interval '1 minute')`;
  const req = { subjectKind: "selected" as const, subjectId: tag(), dedupeKey: tag(), contentAt: new Date(), card: {}, wechat: msg };
  assert.ok((await deliverContent(req)).some(r => r.target === key && r.status === "skipped"));
  assert.equal((await deliverContent(req)).filter(r => r.target === key).length, 0);
  const old = { ...req, dedupeKey: tag(), contentAt: new Date(0) };
  assert.equal((await deliverContent(old)).filter(r => r.target === key).length, 0);
  await sql`UPDATE notify_targets SET enabled=false WHERE key=${key}`;
});
