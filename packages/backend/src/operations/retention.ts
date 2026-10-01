// Daily housekeeping: expired leases, old run history, files past their life and derived caches.
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { STOCK } from "@aihot/industry/stock";
import { addDays, beijingDate } from "@aihot/contracts/time";

/** Derived caches (proxied images, share cards and posters) are rebuilt on demand; drop ones older than a month. */
async function pruneCache(dir: string, maxAgeMs: number, now: number): Promise<number> {
  let removed = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      const info = await stat(p).catch(() => null);
      if (info && now - info.mtimeMs > maxAgeMs) {
        await unlink(p).catch(() => {});
        removed += 1;
      }
    }
  };
  await walk(dir);
  return removed;
}

export async function dailyRetention(now = new Date()) {
  const retiredBodies = config.bodyRetentionEnabled ? await retireArticleBodies(now) : 0;
  const today = beijingDate(now);
  await sql`DELETE FROM stock_announcements WHERE day < ${addDays(today,-STOCK.indexRetentionDays)} AND state <> 'preparing'`;
  await sql`DELETE FROM stock_announcement_scans WHERE day < ${addDays(today,-STOCK.indexRetentionDays)}`;
  await sql`DELETE FROM stock_market_events WHERE day < ${addDays(today,-STOCK.eventRetentionDays)}`;
  await sql`DELETE FROM stock_market_boards WHERE day < ${addDays(today,-STOCK.eventRetentionDays)}`;
  const leases = await sql`DELETE FROM delivery_leases WHERE expires_at < ${now}`;
  // Scheduled-task history: 30 days (failures 90) is enough for the runs view.
  const runs = await sql`DELETE FROM job_runs WHERE started_at < ${new Date(now.getTime() - 30 * 86400_000)} AND (status IS DISTINCT FROM 'failed' OR started_at < ${new Date(now.getTime() - 90 * 86400_000)})`;
  // Raw files with a bounded life.
  const files = await sql<{ key: string }[]>`DELETE FROM stored_files WHERE expires_at < ${now} RETURNING key`;
  for (const f of files) await unlink(path.join(config.dataDir, f.key)).catch(() => {});
  const monthMs = 30 * 86400_000;
  const prunedCache = (await pruneCache(path.join(config.dataDir, "imgcache"), monthMs, now.getTime())) + (await pruneCache(path.join(config.dataDir, "ogcache"), monthMs, now.getTime()));
  return { deletedLeases: leases.count, deletedJobRuns: runs.count, deletedFiles: files.length, prunedCache, retiredBodies };
}

/** Retire payloads, never identities or paid receipts. Small batches avoid a long vacuum/lock burst. */
export async function retireArticleBodies(now = new Date()): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '2s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    const rows = await tx<{ id: string }[]>`
      WITH candidates AS (
        SELECT a.id FROM articles a
        LEFT JOIN publications p ON p.article_id = a.id
        WHERE a.raw_retired_at IS NULL AND a.processing_state IN ('analyzed','skipped','blocked')
          AND a.processing_queued_at IS NULL AND a.processing_retry_at IS NULL
          AND coalesce(p.body_mode,'summary') <> 'full'
          AND greatest(a.discovered_at,a.updated_at) < ${now}::timestamptz -
            CASE WHEN coalesce(p.selected,false) OR EXISTS (
              SELECT 1 FROM analyses n WHERE n.article_id=a.id AND n.selected
            ) THEN interval '180 days' ELSE interval '90 days' END
          AND NOT EXISTS (SELECT 1 FROM editorial_overrides o WHERE o.article_id=a.id)
          AND NOT EXISTS (SELECT 1 FROM selectbench_results b WHERE b.case_id=a.id)
          AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.status IN ('pending','received','unknown')
            AND (r.subject='article:'||a.id OR r.subject LIKE 'article:'||a.id||'@%'))
          AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.state IN ('created','retry','active')
            AND j.data->>'articleId'=a.id)
        ORDER BY a.updated_at LIMIT 500 FOR UPDATE OF a SKIP LOCKED
      )
      UPDATE articles a SET body_text=NULL, body_html=NULL, raw=NULL, x_article=NULL, raw_retired_at=${now}
      FROM candidates c WHERE a.id=c.id RETURNING a.id`;
    if (!rows.length) return 0;
    const ids = rows.map((r) => r.id);
    await tx`UPDATE article_revisions SET body_text=NULL WHERE article_id IN ${tx(ids)}`;
    await tx`UPDATE translations SET body_text=NULL,body_html=NULL WHERE article_id IN ${tx(ids)}`;
    await tx`UPDATE pool_search SET body='' WHERE article_id IN ${tx(ids)}`;
    return rows.length;
  });
}
