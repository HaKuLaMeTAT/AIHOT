// All stock tasks share one scheduled handler. Index collection stays outside the editorial queue.
import { freemem } from "node:os";
import { STOCK } from "@aihot/industry/stock";
import { beijingDate, beijingMidnight, beijingTime } from "@aihot/contracts/time";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { upsertMaterial } from "../content/materials.ts";
import { extractStockPdf } from "../content/stock-pdf.ts";
import { queueProcessing } from "../jobs/content.ts";
import { collectAnnouncements, ANNOUNCEMENT_SOURCES } from "./stock-announcements.ts";
import { collectMarket, MARKET_SOURCE } from "./stock-market.ts";
import { collectHongKongAnnouncements, HKEX_ANNOUNCEMENT_SOURCES } from "./hkex-announcements.ts";

interface IndexedAnnouncement { id: string; source_id: string; title: string; name: string; code: string; pdf_url: string; published_at: Date }

/** Reading quotas share the report boundaries; midnight does not reset the rolling limit. */
export async function announcementUsage(now = new Date(), db: Db = sql) {
  const midnight = beijingMidnight(beijingDate(now)).getTime();
  const hour = (now.getTime() - midnight) / 3600_000;
  const windowStart = new Date(midnight + (hour >= 20 ? 20 : hour >= 8 ? 8 : -4) * 3600_000);
  const windowEnd = new Date(windowStart.getTime() + 12 * 3600_000);
  const rollingStart = new Date(now.getTime() - 24 * 3600_000);
  const [used] = await db<{ window: number; rolling: number }[]>`SELECT
    count(*) FILTER(WHERE promoted_at >= ${windowStart})::int AS window,count(*)::int AS rolling
    FROM stock_announcements WHERE promoted_at > ${rollingStart} AND promoted_at < ${windowEnd}`;
  return { windowStart, windowEnd, windowUsed: used.window, rollingUsed: used.rolling,
    windowLimit: STOCK.announcementsPerWindow, rollingLimit: STOCK.announcementsPerDay };
}

export async function promoteAnnouncement(now = new Date(), extractor: (url: string) => Promise<string> = extractStockPdf) {
  if (!config.modelCallsEnabled) return { status: "skipped", reason: "model calls disabled" };
  // Reserve real attempts under one lock, so failures and simultaneous dispatches share the cap.
  const oldest = new Date(now.getTime() - STOCK.announcementLookbackHours * 3600_000);
  await sql`UPDATE stock_announcements SET state='failed',error='interrupted PDF preparation; index retained'
    WHERE state='preparing' AND updated_at < ${new Date(now.getTime()-30*60_000)}`;
  const r = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('stock_document_dispatch'))`;
    const used = await announcementUsage(now, tx);
    if (used.windowUsed >= used.windowLimit || used.rollingUsed >= used.rollingLimit) return null;
    const [hk] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM stock_announcements
      WHERE source_id IN ${sql(Object.values(HKEX_ANNOUNCEMENT_SOURCES))} AND promoted_at > ${new Date(now.getTime()-24*3600_000)}`;
    const [row] = await tx<IndexedAnnouncement[]>`SELECT a.id,a.source_id,a.title,a.name,a.code,a.pdf_url,a.published_at
      FROM stock_announcements a JOIN sources s ON s.id=a.source_id
      WHERE a.state='indexed' AND NOT a.baseline AND a.priority>0 AND a.published_at >= ${oldest} AND a.published_at <= ${now}
        AND s.enabled AND s.participation_mode='editorial'
        AND (a.source_id NOT IN ${sql(Object.values(HKEX_ANNOUNCEMENT_SOURCES))} OR ${hk.n < STOCK.hongKongDocumentsPerDay})
      ORDER BY a.priority DESC,a.published_at DESC,a.id LIMIT 1 FOR UPDATE OF a`;
    if (row) await tx`UPDATE stock_announcements SET state='preparing',promoted_at=${now},updated_at=${now} WHERE id=${row.id}`;
    return row ?? null;
  });
  if (!r) return { status: "skipped", reason: "no recent candidate or document quota reached" };
  try {
    const body = await extractor(r.pdf_url);
    const material = await upsertMaterial({ sourceId: r.source_id, url: r.pdf_url, title: `${r.name}（${r.code}）：${r.title}`,
      publishedAt: r.published_at, discoveredAt: now, bodyText: body, bodyStatus: "ok", via: "fetch",
      raw: { announcementId: r.id, securityCode: r.code, indexOnlySelection: true } });
    // Save identity before enqueueing, so recovery can reuse the same material after a queue error.
    await sql`UPDATE stock_announcements SET article_id=${material.articleId},promoted_at=${now},updated_at=${now} WHERE id=${r.id}`;
    await queueProcessing(material.articleId);
    await sql`UPDATE stock_announcements SET state='queued',error=NULL WHERE id=${r.id}`;
    return { status: "queued", id: r.id, articleId: material.articleId };
  } catch (error) {
    await sql`UPDATE stock_announcements SET state='failed',error=${String(error).slice(0,300)},updated_at=${now} WHERE id=${r.id}`;
    return { status: "failed", id: r.id, reason: String(error).slice(0,200) };
  }
}

export async function composeMarketMaterial(now = new Date()) {
  if (!config.modelCallsEnabled || beijingTime(now) < "15:05") return { status: "skipped" };
  const day = beijingDate(now);
  const [source] = await sql`SELECT 1 FROM sources WHERE id=${MARKET_SOURCE} AND enabled AND participation_mode='editorial'`;
  if (!source) return { status: "skipped" };
  const [existing] = await sql<{ article_id: string }[]>`SELECT article_id FROM stock_market_reports WHERE day=${day}`;
  if (existing) return { status: "existing", articleId: existing.article_id };
  const events = await sql<{ code: string; name: string; type: keyof typeof STOCK.eventTypes; occurred_at: Date; info: string }[]>`
    SELECT code,name,type,occurred_at,info FROM stock_market_events WHERE day=${day} AND NOT baseline ORDER BY occurred_at DESC LIMIT 30`;
  if (!events.length) return { status: "skipped", reason: "no new observed events" };
  const counts = await sql<{ type: keyof typeof STOCK.eventTypes; n: number; companies: number }[]>`SELECT type,count(*)::int AS n,count(DISTINCT code)::int AS companies
    FROM stock_market_events WHERE day=${day} AND NOT baseline GROUP BY type ORDER BY n DESC`;
  const boards = await sql<{ name: string; change_pct: number; event_count: number; observed_at: Date }[]>`
    SELECT name,change_pct,event_count,observed_at FROM stock_market_boards WHERE day=${day} ORDER BY abs(change_pct) DESC LIMIT 8`;
  const body = [
    `${day} A 股市场异动观察。来源：东方财富盘口/板块异动，交易日期用腾讯上证指数报价交叉核对。`,
    "仅为采样观察：每5分钟取近期窗口，每类最多200条；并非完整逐笔行情。提供方异动只含时分秒，不含交易日期。不能由盘口标签推断消息原因、主力意图或交易建议。",
    "去重后的已观察事件（不代表全市场总数）：",
    ...counts.map((r) => `${STOCK.eventTypes[r.type]}：${r.n} 次，${r.companies} 只股票。`),
    "最近样本（相关信息保留接口原始字符串，不猜测字段含义）：",
    ...events.map((r) => `${beijingTime(r.occurred_at)} ${r.name}（${r.code}） ${STOCK.eventTypes[r.type]}；原始信息：${r.info}`),
    "板块快照（提供方排名前30中的样本，截至各自抓取时间）：",
    ...boards.map((r) => `${r.name} 涨跌幅 ${r.change_pct}%，当日提供方异动次数 ${r.event_count}，抓取于${beijingTime(r.observed_at)}`),
    "原始查看：https://quote.eastmoney.com/changes/",
  ].join("\n");
  const material = await upsertMaterial({ sourceId: MARKET_SOURCE, identityKey: `market:${day}`, url: `https://quote.eastmoney.com/changes/#observed-${day}`,
    title: `${day} A 股盘口与板块异动观察汇总`, bodyText: body, bodyStatus: "ok", publishedAt: now, discoveredAt: now, via: "fetch" });
  await sql`INSERT INTO stock_market_reports (day,article_id) VALUES (${day},${material.articleId}) ON CONFLICT DO NOTHING`;
  await queueProcessing(material.articleId);
  return { status: "queued", articleId: material.articleId };
}

export async function pollStockSources(now = new Date()) {
  if (process.env.COLLECT_ENABLED === "false" || process.env.STOCK_SOURCES_ENABLED !== "true") return { status: "disabled" };
  if (freemem() < 1024 * 1024 * 1024) return { status: "skipped", reason: "WSL free memory below 1 GiB" };
  const results: Record<string, unknown> = {};
  try { results.market = await collectMarket(now); } catch (error) { results.market = { status: "failed", error: String(error).slice(0,300) }; }
  for (const market of Object.keys(ANNOUNCEMENT_SOURCES) as Array<keyof typeof ANNOUNCEMENT_SOURCES>) {
    try { results[market] = await collectAnnouncements(market, now); } catch (error) { results[market] = { status: "failed", error: String(error).slice(0,300) }; }
  }
  for (const board of Object.keys(HKEX_ANNOUNCEMENT_SOURCES) as Array<keyof typeof HKEX_ANNOUNCEMENT_SOURCES>) {
    try { results[board] = await collectHongKongAnnouncements(board, now); } catch (error) { results[board] = { status: "failed", error: String(error).slice(0,300) }; }
  }
  results.announcement = await promoteAnnouncement(now);
  results.marketReport = await composeMarketMaterial(now);
  return results;
}
