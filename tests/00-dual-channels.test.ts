import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { PgBoss } from "pg-boss";
import { sql, closeDb } from "@aihot/backend/db";
import { paidRequest, BudgetExceededError } from "@aihot/backend/providers/receipts";
import { modelChannelFor } from "@aihot/backend/providers/model-channels";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { registerContentJobs, queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
after(async () => { await stopBoss(); await closeDb(); });

test("channel budgets reserve half, cannot borrow, and still reuse a paid receipt", async () => {
  const [saved] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='codex'`;
  const previous = process.env.MODEL_CHANNEL_BUDGETS_ENABLED;
  process.env.MODEL_CHANNEL_BUDGETS_ENABLED = "true";
  let calls = 0;
  const ask = (channel: "ai" | "stock", id: number) => paidRequest({ service: "codex", purpose: "dual_budget",
    subject: `${T}:${channel}:${id}`, identity: { T, channel, id }, budgetChannel: channel }, async () => { calls++; return { response: { ok: true } }; });
  try {
    await sql`UPDATE budgets SET per_minute=4,per_hour=4,per_day=4 WHERE service='codex'`;
    const ai = await Promise.allSettled([ask("ai", 1), ask("ai", 2), ask("ai", 3)]);
    assert.equal(ai.filter((r) => r.status === "fulfilled").length, 2);
    const rejected = ai.find((r) => r.status === "rejected");
    assert.ok(rejected?.status === "rejected" && rejected.reason instanceof BudgetExceededError);
    assert.equal(calls, 2, "stock's unused half remains reserved");
    const stock = await Promise.allSettled([ask("stock", 1), ask("stock", 2), ask("stock", 3)]);
    assert.equal(stock.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal(calls, 4);
    const used = await sql`SELECT budget_channel,count(*)::int AS n FROM receipt_attempts
      WHERE service='codex' AND origin='live' GROUP BY budget_channel ORDER BY budget_channel`;
    assert.deepEqual([...used], [{ budget_channel: "ai", n: 2 }, { budget_channel: "stock", n: 2 }]);
    const success = ai.findIndex((r) => r.status === "fulfilled") + 1;
    assert.equal((await ask("ai", success)).reused, true);
    assert.equal(calls, 4);
  } finally {
    await sql`UPDATE budgets SET per_minute=${saved!.per_minute},per_hour=${saved!.per_hour},per_day=${saved!.per_day} WHERE service='codex'`;
    // Test attempts must not consume the next file's small default budget.
    await sql`DELETE FROM receipts WHERE purpose='dual_budget' AND subject LIKE ${T + ':%'}`;
    if (previous === undefined) delete process.env.MODEL_CHANNEL_BUDGETS_ENABLED; else process.env.MODEL_CHANNEL_BUDGETS_ENABLED = previous;
  }
});

test("waiting legacy work migrates by source into two single-concurrency queues", async () => {
  const stockSource = `stock-dual-${T}`, aiSource = `ai-dual-${T}`;
  const ids: string[] = [];
  for (const source of [aiSource, stockSource]) {
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
      VALUES(${source},${source},'external','T1','editorial','2100-01-01')`;
    const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.com/${source}`,
      title: "真实流程的本地测试资料", bodyText: "测试原文", bodyStatus: "ok", via: "fetch" });
    ids.push(articleId);
    await queueProcessing(articleId);
  }
  assert.equal(await modelChannelFor(`article:${ids[0]}@1`), "ai");
  assert.equal(await modelChannelFor(`urgent:${ids[1]}:input`), "stock");
  const previous = process.env.ANALYZE_CHANNELS_ENABLED;
  process.env.ANALYZE_CHANNELS_ENABLED = "true";
  const workers: Array<{ name: string; concurrency: number }> = [];
  const { getBoss } = await import("@aihot/backend/jobs/queue");
  const boss = await getBoss();
  const fake = { cancel: boss.cancel.bind(boss), work: async (name: string, options: { localConcurrency: number }) => {
    workers.push({ name, concurrency: options.localConcurrency });
  } } as unknown as PgBoss;
  try {
    await registerContentJobs(fake, 10);
    assert.ok(workers.some((w) => w.name === QUEUES.analyzeAi && w.concurrency === 1));
    assert.ok(workers.some((w) => w.name === QUEUES.analyzeStock && w.concurrency === 1));
    const jobs = await sql`SELECT name,data->>'articleId' AS article FROM pgboss.job WHERE state='created' AND data->>'articleId' IN ${sql(ids)} ORDER BY name`;
    assert.deepEqual(jobs.map((j) => [j.name,j.article]), [[QUEUES.analyzeAi,ids[0]],[QUEUES.analyzeStock,ids[1]]]);
    assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.analyze} AND state='created' AND data->>'articleId' IN ${sql(ids)}`).length, 0);
  } finally {
    await sql`DELETE FROM pgboss.job WHERE data->>'articleId' IN ${sql(ids)}`;
    if (previous === undefined) delete process.env.ANALYZE_CHANNELS_ENABLED; else process.env.ANALYZE_CHANNELS_ENABLED = previous;
  }
});
