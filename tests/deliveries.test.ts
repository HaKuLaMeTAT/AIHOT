// Manual delivery recovery must claim one version before sending or changing its outcome.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const T = tag();
const TARGET = `test-delivery-${T}`;
const WECHAT_TARGET = `test-wechat-delivery-${T}`;
const WEBHOOK = "https://delivery.invalid/test";
const ids: number[] = [];
const requests: number[] = [];
const accepted = async (id: number) => Response.json({ code: 0, errcode: 0, msgid: String(1_000_000 + id) });
let answer = accepted;
const realFetch = globalThis.fetch;
// Install before importing the sender, which captures its transport on initialization.
globalThis.fetch = (async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://api.weixin.qq.com/cgi-bin/token?")) {
    return Response.json({ access_token: "test-token", expires_in: 7200 });
  }
  const body = JSON.parse(String(init?.body));
  let id: number;
  if (url === WEBHOOK) id = body.card.id;
  else {
    assert.ok(url.startsWith("https://api.weixin.qq.com/cgi-bin/message/template/send?"));
    assert.equal(body.touser, "test-user");
    id = Number(body.data.title.value);
  }
  requests.push(id);
  return answer(id);
}) as typeof fetch;
const { resendDelivery } = await import("@aihot/backend/notify/deliver");
const { buildApp } = await import("../apps/api/src/app.ts");
const app = await buildApp();

before(async () => {
  config.devAdmin = { displayName: T };
  process.env.TEST_DELIVERY_WEBHOOK = WEBHOOK;
  Object.assign(process.env, { WECHAT_APP_ID: "test-app", WECHAT_APP_SECRET: "test-secret", WECHAT_OPEN_ID: "test-user", WECHAT_TEMPLATE_ID: "test-template" });
  config.feishuContentPushEnabled = true;
  config.wechatPushEnabled = true;
  await sql`INSERT INTO notify_targets (key, purpose, kind, config_ref)
    VALUES (${TARGET}, 'content', 'feishu_webhook', 'TEST_DELIVERY_WEBHOOK')`;
  await sql`INSERT INTO notify_targets (key, purpose, kind) VALUES (${WECHAT_TARGET}, 'content', 'wechat_template')`;
});
after(async () => {
  globalThis.fetch = realFetch;
  config.feishuContentPushEnabled = false;
  config.wechatPushEnabled = false;
  await app.close();
  await sql`DELETE FROM audit_log WHERE actor = ${`dev:${T}`}`;
  await sql`DELETE FROM deliveries WHERE target_key IN (${TARGET}, ${WECHAT_TARGET})`;
  await sql`DELETE FROM notify_targets WHERE key IN (${TARGET}, ${WECHAT_TARGET})`;
  await closeDb();
});

async function delivery(status = "unknown", kind = "feishu_webhook") {
  const [row] = await sql<{ id: number }[]>`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status)
    VALUES (${kind === "wechat_template" ? WECHAT_TARGET : TARGET}, 'selected', 'test', ${`${T}-${ids.length}`}, ${status}) RETURNING id`;
  ids.push(row.id);
  const payload = kind === "wechat_template" ? { title: String(row.id), summary: "test", source: "local", time: "now" } : { id: row.id };
  await sql`UPDATE deliveries SET payload = ${sql.json(payload)} WHERE id = ${row.id}`;
  return row.id;
}
const state = async (id: number) => (await sql<{ status: string; attempts: number; version: string }[]>`
  SELECT status, attempts, updated_at::text AS version FROM deliveries WHERE id = ${id}`)[0];
const resolve = (id: number, outcome = "resend") => app.inject({
  method: "POST", url: `/api/admin/deliveries/${id}/resolve`, headers: { "x-csrf-token": "dev" },
  payload: { outcome, note: "checked the group" },
});

/** Hold writes, but allow both requests to read the same version before their updates race. */
async function hold(id: number) {
  const acquired = gate<number>();
  const release = gate();
  const done = sql.begin(async (tx) => {
    await tx`SELECT id FROM deliveries WHERE id = ${id} FOR UPDATE`;
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    acquired.open(row.pid);
    await release.promise;
  });
  const pid = await acquired.promise;
  return {
    release: async () => { release.open(); await done; },
    blocked: async (count: number) => {
      const deadline = performance.now() + 5000;
      // Include waiters queued behind the first blocked UPDATE, not just the direct lock holder.
      while (true) {
        const [row] = await sql<{ n: number }[]>`WITH RECURSIVE waiting(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
        ) SELECT count(*)::int AS n FROM waiting`;
        if (row.n >= count) return;
        assert.ok(performance.now() < deadline, `expected ${count} blocked delivery updates, got ${row.n}`);
        await delay(10);
      }
    },
  };
}

for (const kind of ["feishu_webhook", "wechat_template"]) {
  test(`${kind}: two concurrent retries send once and return a conflict for the losing admin request`, async () => {
    const id = await delivery("unknown", kind);
    const lock = await hold(id);
    const pending = [resolve(id), resolve(id)];
    // Start Fastify's lazy injection promises while the row is locked.
    const done = Promise.all(pending);
    try { await lock.blocked(2); } finally { await lock.release(); }
    const replies = await done;
    assert.deepEqual(replies.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal(replies.find((r) => r.statusCode === 409)!.json().code, "conflict");
    assert.equal(requests.filter((n) => n === id).length, 1);
    assert.equal((await state(id)).attempts, 1);
    assert.equal((await state(id)).status, "sent");
    const audits = await sql`SELECT id FROM audit_log WHERE subject = ${`delivery:${id}`} AND action = 'delivery.resend'`;
    assert.equal(audits.length, 1, "only the winning recovery is audited");
    if (kind === "wechat_template") {
      const [receipt] = await sql`SELECT wechat_message_id, wechat_app_id FROM deliveries WHERE id = ${id}`;
      assert.deepEqual({ ...receipt }, { wechat_message_id: String(1_000_000 + id), wechat_app_id: "test-app" });
    }
  });

  test(`${kind}: a stale version cannot resend after a fast failure returns the delivery to failed`, async () => {
    const id = await delivery("failed", kind);
    const version = (await state(id)).version;
    answer = async () => Response.json({ code: 99 }, { status: 429 });
    try {
      assert.equal((await resendDelivery(id, version)).status, "failed");
      await assert.rejects(resendDelivery(id, version), { code: "conflict" });
      assert.equal(requests.filter((n) => n === id).length, 1);
      assert.equal((await state(id)).attempts, 1);
      assert.equal((await resolve(id)).statusCode, 200, "a fresh explicit retry remains possible");
      assert.equal((await state(id)).attempts, 2);
    } finally { answer = accepted; }
  });

  for (const outcome of ["sent", "drop"]) {
    test(`${kind}: a stale ${outcome} cannot overwrite a retry in flight; another delivery remains independent`, async () => {
      const id = await delivery("unknown", kind);
      const other = await delivery("unknown", kind);
      const lock = await hold(id);
      const arrived = gate();
      const finish = gate();
      answer = async (sentId) => {
        if (sentId === id) { arrived.open(); await finish.promise; }
        return accepted(sentId);
      };
      const retry = resolve(id).then((r) => r);
      let marking: ReturnType<typeof resolve> | undefined;
      try {
        await lock.blocked(1);
        marking = resolve(id, outcome).then((r) => r);
        await lock.blocked(2);
        await lock.release();
        await arrived.promise;
        assert.equal((await marking).statusCode, 409);
        assert.equal((await state(id)).status, "sending");
        assert.equal((await resolve(other)).statusCode, 200);
      } finally {
        await lock.release();
        finish.open();
        await Promise.allSettled([retry, marking]);
        answer = accepted;
      }
      assert.equal((await retry).statusCode, 200);
      assert.equal((await state(id)).status, "sent");
      assert.equal((await state(id)).attempts, 1);
    });
  }
}

test("disabled WeChat leaves the retry available without sending", async () => {
  const id = await delivery("unknown", "wechat_template");
  const before = await state(id);
  config.wechatPushEnabled = false;
  try { await assert.rejects(resendDelivery(id), /disabled/); }
  finally { config.wechatPushEnabled = true; }
  assert.deepEqual(await state(id), before);
  assert.equal(requests.filter((n) => n === id).length, 0);
});

test("disabled pushes and missing credentials leave the retry available without sending", async () => {
  const id = await delivery();
  const before = await state(id);
  config.feishuContentPushEnabled = false;
  try { await assert.rejects(resendDelivery(id), /disabled/); }
  finally { config.feishuContentPushEnabled = true; }
  delete process.env.TEST_DELIVERY_WEBHOOK;
  try { await assert.rejects(resendDelivery(id), /webhook not configured/); }
  finally { process.env.TEST_DELIVERY_WEBHOOK = WEBHOOK; }
  assert.deepEqual(await state(id), before);
  assert.equal(requests.filter((n) => n === id).length, 0);
});
