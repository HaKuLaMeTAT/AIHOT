// Paged index collection: persist a page before advancing; reconcile completed days again nightly.
import { STOCK, announcementPriority } from "@aihot/industry/stock";
import { addDays, beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { stockJson, type StockJsonFetch } from "./stock-http.ts";
import { FetchError } from "./types.ts";

export const ANNOUNCEMENT_SOURCES = { sh: "stock-cninfo-sh", sz: "stock-cninfo-sz", bj: "stock-cninfo-bj" } as const;
type Market = keyof typeof ANNOUNCEMENT_SOURCES;
export interface Announcement {
  id: string; code: string; name: string; title: string; pdfUrl: string; publishedAt: Date;
}
export function announcementPage(data: any, market: Market, day: string): { total: number; items: Announcement[] } {
  if (!Number.isInteger(data?.totalAnnouncement) || data.totalAnnouncement < 0 || !Array.isArray(data.announcements)) {
    if (data?.totalAnnouncement === 0 && data.announcements === null) return { total: 0, items: [] };
    throw new FetchError("Invalid announcement page");
  }
  const items = data.announcements.map((r: any) => {
    const prefix = market === "sh" ? /^(60|68|90)\d{4}$/ : market === "sz" ? /^(00|20|30)\d{4}$/ : /^(43|83|87|92)\d{4}$/;
    const publishedAt = new Date(r.announcementTime);
    if (!/^\d+$/.test(String(r.announcementId)) || !prefix.test(r.secCode) || !r.announcementTitle ||
        !Number.isFinite(publishedAt.getTime()) || beijingDate(publishedAt) !== day ||
        !/^finalpage\/\d{4}-\d{2}-\d{2}\/\d+\.pdf$/i.test(r.adjunctUrl)) throw new FetchError("Invalid announcement identity/date/PDF path");
    return { id: `${r.announcementId}:${r.secCode}`, code: r.secCode, name: r.secName ?? "", title: collapseWhitespace(stripTags(r.announcementTitle)),
      pdfUrl: `https://static.cninfo.com.cn/${r.adjunctUrl}`, publishedAt };
  });
  if (data.totalAnnouncement > 0 && !items.length) throw new FetchError("Empty page before announcement scan completed");
  return { total: data.totalAnnouncement, items };
}

export async function collectAnnouncements(market: Market, now = new Date(), fetcher: StockJsonFetch = stockJson) {
  const sourceId = ANNOUNCEMENT_SOURCES[market];
  const [source] = await sql<{ enabled: boolean; cursor: { stockEnabledDay?: string } | null; next_fetch_at: Date | null }[]>`
    SELECT enabled,cursor,next_fetch_at FROM sources WHERE id=${sourceId}`;
  if (!source?.enabled || (source.next_fetch_at && source.next_fetch_at > now)) return { sourceId, status: "skipped", pages: 0 };
  const today = beijingDate(now);
  const enabledDay = source.cursor?.stockEnabledDay ?? today;
  // Initial day is an index baseline: date-only official publications cannot prove post-enable arrival.
  await sql`UPDATE sources SET cursor=jsonb_set(coalesce(cursor,'{}'),'{stockEnabledDay}',${sql.json(enabledDay)}) WHERE id=${sourceId}`;
  for (const day of [addDays(today, -1), today]) {
    await sql`INSERT INTO stock_announcement_scans (source_id,day) VALUES (${sourceId},${day}) ON CONFLICT DO NOTHING`;
  }
  let pages = 0, stored = 0;
  const readPage = async (day: string, page: number, checkpoint: boolean) => {
    const form = new URLSearchParams({ pageNum: String(page), pageSize: "30", column: "szse", tabName: "fulltext", plate: market,
      // Explicit date sorting makes equal-date rows unstable across pages. Keep the site's default order.
      stock: "", searchkey: "", secid: "", category: "", trade: "", seDate: `${day}~${day}`, sortName: "", sortType: "", isHLtitle: "true" });
    const data = await fetcher("https://www.cninfo.com.cn/new/hisAnnouncement/query", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: "https://www.cninfo.com.cn/" }, body: form.toString() });
    const result = Number.isInteger(data?.totalAnnouncement) && data.totalAnnouncement >= 0 && page > Math.ceil(data.totalAnnouncement / 30) && !data.announcements?.length
      ? { total: data.totalAnnouncement, items: [] } : announcementPage(data, market, day);
    const { total, items } = result;
    await sql.begin(async (tx) => {
      for (const item of items) {
        await tx`INSERT INTO stock_announcements (id,source_id,day,code,name,title,pdf_url,published_at,baseline,priority,first_seen_at)
          VALUES (${item.id},${sourceId},${day},${item.code},${item.name},${item.title},${item.pdfUrl},${item.publishedAt},${day <= enabledDay},${announcementPriority(item.title)},${now})
          ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,pdf_url=EXCLUDED.pdf_url,priority=EXCLUDED.priority,updated_at=now()`;
      }
      // Derive page count from actual rows (the site's totalpages can be rounded DOWN).
      const atEnd = total === 0 || page * 30 >= total;
      const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM stock_announcements WHERE source_id=${sourceId} AND day=${day}`;
      if (checkpoint) await tx`UPDATE stock_announcement_scans SET next_page=${atEnd && count.n < total ? 1 : page + 1},expected_count=${total},
        complete=${atEnd && count.n >= total},updated_at=${now} WHERE source_id=${sourceId} AND day=${day}`;
      else await tx`UPDATE stock_announcement_scans SET expected_count=${total},
        next_page=CASE WHEN complete AND ${count.n < total} THEN 2 ELSE next_page END,
        complete=complete AND ${count.n >= total},updated_at=${now} WHERE source_id=${sourceId} AND day=${day}`;
    });
    pages++; stored += items.length;
  };
  try {
    // A bounded head refresh discovers new IDs even while older pages are still catching up.
    const [head] = await sql<{ next_page: number }[]>`SELECT next_page FROM stock_announcement_scans WHERE source_id=${sourceId} AND day=${today}`;
    await readPage(today, 1, head?.next_page === 1);
    // Reset yesterday's finished scan once after 02:00, catching late insertions and moving pages.
    const dayBefore = addDays(today, -1);
    await sql`UPDATE stock_announcement_scans SET next_page=1,complete=false,updated_at=${now}
      WHERE source_id=${sourceId} AND day=${dayBefore} AND complete AND updated_at < ${new Date(`${today}T02:00:00+08:00`)}
      AND ${now} >= ${new Date(`${today}T02:00:00+08:00`)}`;
    let lastDay = today;
    while (pages < STOCK.announcementPagesPerRun) {
      const [scan] = await sql<{ day: string; next_page: number }[]>`SELECT day,next_page FROM stock_announcement_scans
        WHERE source_id=${sourceId} AND NOT complete AND day >= ${addDays(today, -2)} ORDER BY (day > ${lastDay}) DESC,day LIMIT 1`;
      if (!scan) break;
      await readPage(scan.day, scan.next_page, true);
      lastDay = scan.day;
    }
    await sql`UPDATE sources SET last_fetch_at=${now},last_ok_at=${now},fail_count=0,last_error=NULL,health='ok',
      next_fetch_at=${new Date(now.getTime() + 15 * 60_000)} WHERE id=${sourceId}`;
    return { sourceId, status: "ok", pages, stored };
  } catch (error) {
    await sql`UPDATE sources SET last_fetch_at=${now},fail_count=fail_count+1,last_error=${String(error).slice(0,500)},health='degraded',
      next_fetch_at=${new Date(now.getTime() + 15 * 60_000)} WHERE id=${sourceId}`;
    throw error;
  }
}
