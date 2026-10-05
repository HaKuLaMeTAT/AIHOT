// Public index metadata, independent of editorial selection. Reads never fetch PDFs or enqueue work.
import type { StockAnnouncementsQuery, StockAnnouncementsResponse } from "@aihot/contracts/stock";
import { addDays, beijingDate } from "@aihot/contracts/time";
import { STOCK } from "@aihot/industry/stock";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { ANNOUNCEMENT_SOURCES } from "../sources/stock-announcements.ts";
import { listedCondition } from "./items.ts";
import { itemUrl } from "./links.ts";

type ResponseItem = StockAnnouncementsResponse["items"][number];
type CoverageDay = StockAnnouncementsResponse["coverage"]["days"][number];
interface IndexRow {
  id: string; code: string; name: string; title: string; pdf_url: string; published_at: Date; first_seen_at: Date;
  baseline: boolean; state: ResponseItem["processingState"]; body_status: ResponseItem["bodyStatus"]; public_article_id: string | null;
}

export async function stockAnnouncements(q: StockAnnouncementsQuery, now = new Date()): Promise<StockAnnouncementsResponse> {
  const sourceId = ANNOUNCEMENT_SOURCES[q.market];
  const binding = queryBinding({ market: q.market, code: q.code, from: q.from, to: q.to });
  let after: { at: Date; id: string } | null = null;
  if (q.cursor !== null) {
    const c = decodeCursor<{ b: string; t: number; i: string }>("sa1", q.cursor);
    if (c.b !== binding || !Number.isSafeInteger(c.t) || !Number.isFinite(new Date(c.t).getTime()) ||
        typeof c.i !== "string" || c.i.length < 1 || c.i.length > 200) throw new InvalidCursorError("cursor does not belong to this query");
    const date = beijingDate(c.t);
    if (date < q.from || date > q.to) throw new InvalidCursorError("cursor is outside the requested dates");
    after = { at: new Date(c.t), id: c.i };
  }
  // Keep rows and coverage counts in the same read-only snapshot while the worker commits pages.
  return await sql.begin("isolation level repeatable read read only", async (tx) => {
    const [source] = await tx<{ id: string; name: string; enabled: boolean; health: string; participation_mode: string;
      last_fetch_at: Date | null; last_ok_at: Date | null }[]>`
      SELECT id,name,enabled,health,participation_mode,last_fetch_at,last_ok_at FROM sources WHERE id=${sourceId}`;
    const available = source?.participation_mode === "editorial";
    const rows = available ? await tx<IndexRow[]>`
      SELECT a.id,a.code,a.name,a.title,a.pdf_url,a.published_at,a.first_seen_at,a.baseline,a.state,ar.body_status,
        CASE WHEN ${listedCondition(now)} AND ps.participation_mode='editorial' THEN p.article_id END AS public_article_id
      FROM stock_announcements a JOIN sources s ON s.id=a.source_id
      LEFT JOIN articles ar ON ar.id=a.article_id LEFT JOIN publications p ON p.article_id=a.article_id
      LEFT JOIN sources ps ON ps.id=p.source_id
      WHERE a.source_id=${sourceId} AND a.code=${q.code} AND a.day >= ${q.from} AND a.day <= ${q.to}
        AND s.participation_mode='editorial' AND p.visibility IS DISTINCT FROM 'withdrawn'
        ${after ? tx`AND (a.published_at,a.id) < (${after.at},${after.id})` : tx``}
      ORDER BY a.published_at DESC,a.id DESC LIMIT ${q.limit + 1}` : [];
    const scans = available ? await tx<{ day: string; expected_count: number; complete: boolean; updated_at: Date }[]>`
      SELECT day,expected_count,complete,updated_at FROM stock_announcement_scans
      WHERE source_id=${sourceId} AND day >= ${q.from} AND day <= ${q.to}` : [];
    // Counts describe the entire market/day scan, not the requested security or this result page.
    const counts = available ? await tx<{ day: string; n: number }[]>`
      SELECT day,count(*)::int AS n FROM stock_announcements
      WHERE source_id=${sourceId} AND day >= ${q.from} AND day <= ${q.to} GROUP BY day` : [];
    const scansByDay = new Map(scans.map((s) => [s.day, s]));
    const countsByDay = new Map(counts.map((c) => [c.day, c.n]));
    const today = beijingDate(now), retainedFrom = addDays(today, -STOCK.indexRetentionDays);
    const days: CoverageDay[] = [];
    for (let date = q.from; date <= q.to; date = addDays(date, 1)) {
      const scan = scansByDay.get(date), count = countsByDay.get(date) ?? 0;
      const gaps: CoverageDay["gaps"] = [];
      if (date < retainedFrom) gaps.push("outside_retention");
      if (!available) gaps.push("source_unavailable");
      if (!scan) gaps.push("not_scanned");
      else {
        if (!scan.complete) gaps.push("scan_incomplete");
        if (count < scan.expected_count) gaps.push("count_mismatch");
      }
      if (available && !source.enabled) gaps.push("source_disabled");
      if (available && source.health !== "ok") gaps.push("source_degraded");
      if (date === today) {
        gaps.push("open_day");
        if (available && (!source.last_ok_at || now.getTime() - source.last_ok_at.getTime() > 30 * 60_000)) gaps.push("source_stale");
      }
      days.push({ date, scanComplete: scan ? scan.complete && count >= scan.expected_count : null,
        expectedCount: scan?.expected_count ?? null, indexedCount: count, updatedAt: scan?.updated_at.toISOString() ?? null, gaps });
    }
    const page = rows.slice(0, q.limit), hasMore = rows.length > q.limit, last = page.at(-1);
    return {
      schemaVersion: 1, asOf: now.toISOString(),
      query: { market: q.market, code: q.code, from: q.from, to: q.to, ordering: "publishedAtDesc" },
      items: page.map((r) => ({ id: r.id, code: r.code, name: r.name, title: r.title,
        publishedAt: r.published_at.toISOString(), firstSeenAt: r.first_seen_at.toISOString(), baseline: r.baseline,
        processingState: r.state, bodyStatus: r.body_status,
        article: r.public_article_id ? { id: r.public_article_id, url: itemUrl(r.public_article_id) } : null,
        links: { original: r.pdf_url } })),
      page: { count: page.length, hasMore, nextCursor: hasMore && last ? encodeCursor("sa1", { b: binding, t: last.published_at.getTime(), i: last.id }) : null },
      coverage: {
        scope: "cninfo_market_index", retentionDays: STOCK.indexRetentionDays, retainedFrom, days,
        source: { id: sourceId, name: available ? source.name : null, enabled: available ? source.enabled : null,
          health: available ? source.health : null, lastAttemptAt: available ? source.last_fetch_at?.toISOString() ?? null : null,
          lastSuccessAt: available ? source.last_ok_at?.toISOString() ?? null : null },
      },
    };
  });
}
