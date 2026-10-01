import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";

// Install the transport before importing the sender. No external HTTP requests leave this test.
let sends = 0;
let uncertain = false;
const original = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('/token?')) return Response.json({ access_token: 'local-test-token', expires_in: 7200 });
  sends++;
  if (uncertain) return new Response('', { status: 500 });
  return Response.json({ errcode: 0, msgid: 1 });
};
const { deliverRuntimeNotice } = await import('@aihot/backend/operations/runtime-notices');
const { ensureContentTargets } = await import('@aihot/backend/notify/deliver');
after(async () => { globalThis.fetch = original; config.wechatPushEnabled = false; await sql`UPDATE notify_targets SET enabled=false WHERE key='wechat-personal'`; await closeDb(); });

test("disabled operations notices leave the key available; enabled notices send once", async () => {
  await ensureContentTargets();
  await sql`UPDATE notify_targets SET enabled=true,enabled_at=now() WHERE key='wechat-personal'`;
  const notice = { id: tag(), key: 'disk.free', level: 'critical' as const, detail: 'D 盘剩余不足 10 GiB', at: 1 };
  config.wechatPushEnabled = false;
  assert.deepEqual(await deliverRuntimeNotice(notice), []);
  assert.equal((await sql`SELECT 1 FROM deliveries WHERE dedupe_key=${`operation:${notice.id}`}`).length, 0);
  for (const key of ['WECHAT_APP_ID','WECHAT_APP_SECRET','WECHAT_OPEN_ID','WECHAT_TEMPLATE_ID']) process.env[key] = 'local-test-value';
  config.wechatPushEnabled = true;
  assert.equal((await deliverRuntimeNotice(notice))[0]?.status, 'sent');
  await deliverRuntimeNotice(notice);
  assert.equal(sends, 1);
  const [row] = await sql`SELECT subject_kind,status FROM deliveries WHERE dedupe_key=${`operation:${notice.id}`}`;
  assert.equal(row.subject_kind, 'operation'); assert.equal(row.status, 'sent');
});

test("ambiguous operation deliveries are never automatically resent", async () => {
  uncertain = true;
  const notice = { id: tag(), key: 'backup.failed', level: 'critical' as const, detail: '本地备份失败', at: 1 };
  assert.equal((await deliverRuntimeNotice(notice))[0]?.status, 'unknown');
  await deliverRuntimeNotice(notice);
  assert.equal(sends, 2);
});
