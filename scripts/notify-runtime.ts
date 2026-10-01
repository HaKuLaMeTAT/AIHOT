// No model requests. Current operational transitions are sent once through the delivery ledger.
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { deliverRuntimeNotice, type RuntimeNotice } from "@aihot/backend/operations/runtime-notices";

const directory = path.join(config.dataDir, "operations");
try {
  const state = JSON.parse(await readFile(path.join(directory, "runtime-state.json"), "utf8")) as {
    alerts?: Record<string, { level: string; since: number }>;
    notices?: RuntimeNotice[];
  };
  const now = new Date();
  const notices = (state.notices ?? []).filter((n) => {
    const active = state.alerts?.[n.key];
    return n.level !== "recovered" && active?.since === n.at && active.level === n.level;
  });
  // Recovery is only sent if the preceding alert was actually sent; no stale transitions on enable.
  if (config.wechatPushEnabled) {
    for (const n of (state.notices ?? []).filter((n) => n.level === "recovered" && !state.alerts?.[n.key] && now.getTime() / 1000 - n.at < 86400)) {
      if (!n.previous_id) continue;
      const [sent] = await sql`SELECT 1 FROM deliveries WHERE target_key='wechat-personal'
        AND dedupe_key=${`operation:${n.previous_id}`} AND status='sent' LIMIT 1`;
      if (sent) notices.push(n);
    }
  }
  const reviewFile = path.join(directory, "receipts-review.json");
  const review = await readFile(reviewFile, "utf8").then((s) => JSON.parse(s) as { checkedAt: number; count: number }, () => null);
  let count = review?.count ?? 0;
  if (!review || now.getTime() - review.checkedAt > 86400_000) {
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM receipts WHERE created_at < ${new Date(now.getTime() - 365 * 86400_000)}`;
    count = row!.count;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${reviewFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ checkedAt: now.getTime(), count }), { mode: 0o600, flag: "wx" });
      await rename(temporary, reviewFile);
    } finally { await rm(temporary, { force: true }); }
  }
  if (count) notices.push({ id: `receipts-review:${now.toISOString().slice(0, 7)}`, key: "receipts.review", level: "warning",
    detail: `${count} 条模型回执已保留超过一年，建议评估归档；完整回执及去重、费用记录仍保留，未自动删除。`, at: now.getTime() / 1000 });
  for (const n of notices) await deliverRuntimeNotice(n, now);
} finally {
  await closeDb();
}
