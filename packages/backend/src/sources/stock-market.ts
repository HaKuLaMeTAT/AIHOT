// Small provider event windows, not a second full-market quote engine.
import { STOCK } from "@aihot/industry/stock";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { stockJson, type StockJsonFetch } from "./stock-http.ts";
import { FetchError } from "./types.ts";

export const MARKET_SOURCE = "stock-eastmoney-events";
const UT = "7eea3edcaed734bea9cbfc24409ed989"; // Public website client identifier, not a credential.
export function marketSession(now: Date): boolean {
  const weekday = new Date(`${beijingDate(now)}T00:00:00Z`).getUTCDay();
  const time = beijingTime(now);
  return weekday !== 0 && weekday !== 6 && ((time >= "09:30" && time <= "11:30") || (time >= "13:00" && time <= "15:05"));
}

export function quoteTimestamp(text: string): Date {
  const fields = /v_sh000001="([^"]*)"/.exec(text)?.[1].split("~");
  const stamp = fields?.[30];
  if (fields?.[2] !== "000001" || !stamp || !/^\d{14}$/.test(stamp)) throw new FetchError("Index quote has no trading timestamp");
  const date = new Date(`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}+08:00`);
  if (!Number.isFinite(date.getTime())) throw new FetchError("Invalid index quote date");
  return date;
}
export async function tradingQuote(): Promise<Date> {
  const r = await guardedFetch("https://qt.gtimg.cn/q=sh000001", { timeoutMs: 8000, maxBytes: 100_000 });
  if (r.status !== 200) throw new FetchError("Trading-date verification unavailable");
  return quoteTimestamp(new TextDecoder("gb18030").decode(r.body));
}

export function eventTime(value: unknown, day: string): Date | null {
  const text = String(value).padStart(6, "0");
  if (!/^(09|10|11|13|14|15)[0-5]\d[0-5]\d$/.test(text)) return null;
  return new Date(`${day}T${text.slice(0,2)}:${text.slice(2,4)}:${text.slice(4,6)}+08:00`);
}

export async function collectMarket(now = new Date(), fetcher: StockJsonFetch = stockJson, quote: () => Promise<Date> = tradingQuote) {
  if (!marketSession(now)) return { status: "skipped", reason: "outside session" };
  const [source] = await sql<{ enabled: boolean; cursor: { marketDay?: string } | null }[]>`SELECT enabled,cursor FROM sources WHERE id=${MARKET_SOURCE}`;
  if (!source?.enabled) return { status: "skipped", reason: "disabled" };
  const day = beijingDate(now);
  const baseline = source.cursor?.marketDay !== day;
  let events = 0, truncated = 0;
  try {
    const timestamp = await quote();
    if (beijingDate(timestamp) !== day || now.getTime() - timestamp.getTime() > 15 * 60_000 || timestamp.getTime() - now.getTime() > 60_000) {
      return { status: "skipped", reason: "closed holiday, stale or future index quote" };
    }
    for (const type of Object.keys(STOCK.eventTypes)) {
      for (let page = 0; page < 2; page++) {
        const url = `https://push2ex.eastmoney.com/getAllStockChanges?${new URLSearchParams({ type, ut: UT, dpt: "wzchanges", pagesize: "100", pageindex: String(page) })}`;
        const data = await fetcher(url);
        if (data?.rc !== 0 || !Number.isInteger(data.data?.tc) || !Array.isArray(data.data?.allstock)) throw new FetchError("Invalid market event response");
        let older = false;
        const rows = data.data.allstock;
        for (const row of rows) {
          if (String(row.t) !== type || !/^(00|30|60|68|43|83|87|92)\d{4}$/.test(row.c) || typeof row.n !== "string" || typeof row.i !== "string") continue;
          const at = eventTime(row.tm, day);
          if (!at || at > now) continue;
          if (now.getTime() - at.getTime() > 10 * 60_000) { older = true; continue; }
          const inserted = await sql`INSERT INTO stock_market_events (day,event_key,code,name,type,occurred_at,info,baseline)
            VALUES (${day},${`${row.c}:${type}:${row.tm}`},${row.c},${row.n},${type},${at},${row.i},${baseline}) ON CONFLICT DO NOTHING RETURNING event_key`;
          events += inserted.length;
        }
        if (older || rows.length < 100 || (page + 1) * 100 >= data.data.tc) break;
        if (page === 1) truncated++;
      }
    }
    const boards = await fetcher(`https://push2ex.eastmoney.com/getAllBKChanges?${new URLSearchParams({ ut: UT, dpt: "wzchanges", pagesize: "30", pageindex: "0" })}`);
    if (boards?.rc !== 0 || !Array.isArray(boards.data?.allbk)) throw new FetchError("Invalid board response");
    for (const board of boards.data.allbk.slice(0,30)) {
      if (!/^BK\d+$/.test(board.c) || typeof board.n !== "string" || !Number.isFinite(Number(board.u)) || !Number.isInteger(board.ct)) continue;
      await sql`INSERT INTO stock_market_boards (day,code,name,change_pct,event_count,observed_at)
        VALUES (${day},${board.c},${board.n},${Number(board.u)},${board.ct},${now}) ON CONFLICT (day,code)
        DO UPDATE SET change_pct=EXCLUDED.change_pct,event_count=EXCLUDED.event_count,observed_at=EXCLUDED.observed_at`;
    }
    await sql`UPDATE sources SET cursor=jsonb_set(coalesce(cursor,'{}'),'{marketDay}',${sql.json(day)}),last_fetch_at=${now},last_ok_at=${now},
      fail_count=0,last_error=NULL,health=${truncated ? "degraded" : "ok"} WHERE id=${MARKET_SOURCE}`;
    return { status: "ok", events, baseline, truncated, dateVerification: "independent index quote; provider events have time only" };
  } catch (error) {
    await sql`UPDATE sources SET last_fetch_at=${now},fail_count=fail_count+1,last_error=${String(error).slice(0,500)},health='degraded' WHERE id=${MARKET_SOURCE}`;
    throw error;
  }
}
