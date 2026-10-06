// HKEX's own latest-publications JSON; indexes share the bounded announcement reading queue.
import { STOCK, hongKongAnnouncementPriority } from "@aihot/industry/stock";
import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { stockJson, type StockJsonFetch } from "./stock-http.ts";
import { FetchError } from "./types.ts";
import type { Announcement } from "./stock-announcements.ts";

export const HKEX_ANNOUNCEMENT_SOURCES = { sehk: "stock-hkex-main", gem: "stock-hkex-gem" } as const;
type Board = keyof typeof HKEX_ANNOUNCEMENT_SOURCES;

export function hongKongAnnouncementPage(data: any, board: Board): { pages: number; items: Announcement[] } {
  if (!Number.isInteger(data?.maxNumOfFile) || data.maxNumOfFile < 0 || data.maxNumOfFile > 100
      || !Array.isArray(data.newsInfoLst) || data.newsInfoLst.length > 1000) throw new FetchError("Invalid HKEX announcement page");
  const items: Announcement[] = [];
  for (const row of data.newsInfoLst) {
    // Monthly returns, next-day buyback forms and structured products do not enter this queue.
    if (String(row?.t1Code) !== "10000" || row.ext !== "pdf") continue;
    const date = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(String(row.relTime));
    const publishedAt = date ? new Date(`${date[3]}-${date[2]}-${date[1]}T${date[4]}:${date[5]}:00+08:00`) : new Date(NaN);
    const expected = date ? `${date[3]}-${date[2]}-${date[1]}` : "";
    const code = row.stock?.[0]?.sc;
    if (!Number.isSafeInteger(row.newsId) || row.newsId <= 0 || !/^\d{5}$/.test(code ?? "")
        || typeof row.stock?.[0]?.sn !== "string" || typeof row.title !== "string" || !row.title.trim()
        || !Number.isFinite(publishedAt.getTime()) || beijingDate(publishedAt) !== expected
        || !new RegExp(`^/listedco/listconews/${board}/${date?.[3]}/${date?.[2]}${date?.[1]}/\\d{8}\\d+_c\\.pdf$`).test(String(row.webPath))) {
      throw new FetchError("Invalid HKEX announcement identity/date/PDF path");
    }
    items.push({ id: `hkex:${board}:${row.newsId}`, code, name: collapseWhitespace(stripTags(row.stock[0].sn)),
      title: collapseWhitespace(stripTags(row.title)), pdfUrl: `https://www1.hkexnews.hk${row.webPath}`, publishedAt });
  }
  return { pages: data.maxNumOfFile, items };
}

export async function collectHongKongAnnouncements(board: Board, now = new Date(), fetcher: StockJsonFetch = stockJson) {
  const sourceId = HKEX_ANNOUNCEMENT_SOURCES[board];
  const [source] = await sql<{ enabled: boolean; next_fetch_at: Date | null; cursor: Record<string, any> | null }[]>`
    SELECT enabled,next_fetch_at,cursor FROM sources WHERE id=${sourceId}`;
  if (!source?.enabled || (source.next_fetch_at && source.next_fetch_at > now)) return { sourceId, status: "skipped", pages: 0 };
  const start = source.cursor?.hkexEnabledAt ? new Date(source.cursor.hkexEnabledAt) : now;
  if (!Number.isFinite(start.getTime())) throw new FetchError("Invalid HKEX activation timestamp");
  // Persist activation before requesting a page: retries cannot turn old disclosures into new events.
  await sql`UPDATE sources SET cursor=jsonb_set(coalesce(cursor,'{}'),'{hkexEnabledAt}',${sql.json(start.toISOString())}) WHERE id=${sourceId}`;
  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs(source_id,started_at) VALUES(${sourceId},${now}) RETURNING id`;
  let pages = 0, found = 0;
  let nextPage = Number.isInteger(source.cursor?.hkexNextPage) && source.cursor!.hkexNextPage >= 2 ? source.cursor!.hkexNextPage : 2;
  const oldest = new Date(now.getTime() - STOCK.announcementLookbackHours * 3600_000);
  try {
    let maxPages = 1;
    const readPage = async (page: number) => {
      const data = await fetcher(`https://www1.hkexnews.hk/ncms/json/eds/lci${board}7relsdc_${page}.json`);
      const got = hongKongAnnouncementPage(data, board);
      maxPages = Math.max(1, got.pages);
      await sql.begin(async tx => {
        for (const item of got.items.filter(item => item.publishedAt >= oldest && item.publishedAt <= now)) {
          await tx`INSERT INTO stock_announcements(id,source_id,day,code,name,title,pdf_url,published_at,baseline,priority,first_seen_at)
            VALUES(${item.id},${sourceId},${beijingDate(item.publishedAt)},${item.code},${item.name},${item.title},${item.pdfUrl},${item.publishedAt},
              ${item.publishedAt <= start},${hongKongAnnouncementPriority(item.title)},${now})
            ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,pdf_url=EXCLUDED.pdf_url,priority=EXCLUDED.priority,updated_at=${now}`;
        }
        if (page !== 1) nextPage = page + 1 > maxPages ? 2 : page + 1;
        await tx`UPDATE sources SET cursor=jsonb_set(cursor,'{hkexNextPage}',${sql.json(nextPage)}),updated_at=${now} WHERE id=${sourceId}`;
      });
      pages++; found += got.items.length;
    };
    await readPage(1);
    if (nextPage > maxPages) nextPage = 2;
    const visited = new Set([1]);
    while (pages < STOCK.hongKongPagesPerRun && maxPages > 1 && !visited.has(nextPage)) {
      const page = nextPage; visited.add(page); await readPage(page);
    }
    await sql`UPDATE sources SET last_fetch_at=${now},last_ok_at=${now},health='ok',fail_count=0,last_error=NULL,
      next_fetch_at=${new Date(now.getTime()+30*60_000)},updated_at=${now} WHERE id=${sourceId}`;
    await sql`UPDATE fetch_runs SET status='ok',finished_at=now(),found_count=${found},detail=${sql.json({ pages, nextPage, maxPages, scope: "bounded_latest_seven_days", complete: false })} WHERE id=${run.id}`;
    return { sourceId, status: "ok", pages, found };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`UPDATE sources SET last_fetch_at=${now},fail_count=fail_count+1,health=CASE WHEN fail_count+1>=5 THEN 'failing' ELSE 'degraded' END,
      last_error=${message.slice(0,300)},next_fetch_at=${new Date(now.getTime()+30*60_000)},updated_at=${now} WHERE id=${sourceId}`;
    await sql`UPDATE fetch_runs SET status='failed',finished_at=now(),found_count=${found},error=${message.slice(0,300)},detail=${sql.json({ pages, nextPage })} WHERE id=${run.id}`;
    return { sourceId, status: "failed", pages, found, error: message };
  }
}
