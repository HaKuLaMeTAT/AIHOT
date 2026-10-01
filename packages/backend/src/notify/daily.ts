// Personal digests reuse stored editorial summaries. Aggregation itself makes no model calls.
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { SITE } from "@aihot/industry/site";
import { addDays, beijingDate, beijingMidnight, beijingTime } from "@aihot/contracts/time";
import { dailyEditionKey, dailyEditionLabel, type DailyEdition } from "@aihot/contracts/personal-daily";
import { sql } from "../db.ts";
import { candidates, personalEvents, personalFacts, type Candidate } from "../publication/report-candidates.ts";
import { loadPersonalDailyCandidates } from "../publication/personal-daily.ts";
import { deliverContent } from "./deliver.ts";
import { briefWechat, type WechatMessage } from "./wechat.ts";

export type DailyChannel = "ai" | "stock";
const HOUR = { ai: 8, stock: 18 };
const LABEL = { ai: "AI 日报", stock: "股市日报" };
const ORDER = new Map<string, number>(CATEGORIES.map((c, i) => [c.key, i]));
const CATEGORY = new Map<string, string>(CATEGORIES.map((c) => [c.key, c.label]));

export function dailyPageUrl(channel: DailyChannel, key: string, edition?: DailyEdition): string | null {
  try {
    const base = new URL(process.env.DAILY_PUBLIC_BASE_URL ?? "");
    if (base.protocol !== "https:" || base.username || base.password || base.port || base.pathname !== "/" || base.search || base.hash ||
        base.hostname === "localhost" || base.hostname.endsWith(".localhost") || !base.hostname.includes(".") || /^[\d.]+$/.test(base.hostname)) return null;
    return new URL(`/daily/${channel}/${key}${edition ? `/${edition}` : ""}`, base).href;
  } catch { return null; }
}

function label(channel: DailyChannel, edition?: DailyEdition) {
  return edition ? `${channel === "ai" ? "AI " : "股市"}${dailyEditionLabel(edition)}` : LABEL[channel];
}

export function dailyPageMessage(channel: DailyChannel, key: string, count: number, end: Date, edition?: DailyEdition): WechatMessage | null {
  const url = dailyPageUrl(channel, key, edition);
  if (!url) return null;
  return briefWechat({ title: `${label(channel, edition)} ${key}`, summary: count ? `精选 ${count} 条，点击阅读全文` : "本期暂无新增精选，点击查看",
    source: SITE.name, time: `${key} ${beijingTime(end)}`, url, template: channel === "ai" ? "ai_daily" : "stock_daily" });
}

export function dailyWindow(channel: DailyChannel, now: Date, edition?: DailyEdition) {
  let key = beijingDate(now);
  const twice = edition !== undefined || process.env.PERSONAL_DAILY_TWICE_ENABLED === "true";
  if (twice && !edition) edition = now.getTime() - beijingMidnight(key).getTime() >= 20 * 3600_000 ? "evening"
    : now.getTime() - beijingMidnight(key).getTime() >= 8 * 3600_000 ? "morning" : "evening";
  const hour = twice ? edition === "morning" ? 8 : 20 : HOUR[channel];
  let end = new Date(beijingMidnight(key).getTime() + hour * 3600_000);
  if (end > now) { key = addDays(key, -1); end = new Date(end.getTime() - 86400_000); }
  return { key, reportKey: dailyEditionKey(key, edition), edition, start: new Date(end.getTime() - (twice ? 12 : 24) * 3600_000), end };
}

function short(text: string, size: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= size ? line : `${line.slice(0, size - 1)}…`;
}

function block(e: Candidate, index: number): string {
  const category = CATEGORY.get(e.category ?? "") ?? "其他";
  const related = (e.relatedEntries ?? []).map(r => `同一事件的进展：${short(r.title, 90)}\n${short(r.summary, 200)}\n来源：${r.sourceName}\n原文：${r.sourceUrl}`);
  return [`${index + 1}.【${category}】${short(e.title, 90)}\n${short(e.summary, 200)}\n来源：${e.sourceName}\n原文：${e.sourceUrl}`, ...related].join("\n\n");
}

function parts(entries: Candidate[]): Candidate[][] {
  const ordered = [...entries].sort((a, b) => (ORDER.get(a.category ?? "") ?? 99) - (ORDER.get(b.category ?? "") ?? 99) || (b.score ?? 0) - (a.score ?? 0));
  const groups: Candidate[][] = [];
  for (const e of ordered) {
    let group = groups.at(-1);
    if (!group || group.length >= 4 || [...group, e].map(block).join("\n\n").length > 1800) { group = []; groups.push(group); }
    group.push(e);
  }
  return groups;
}

function message(channel: DailyChannel, key: string, entries: Candidate[], end: Date, part: number, total: number, count: number, edition?: DailyEdition): WechatMessage {
  return {
    title: `${label(channel, edition)}｜${key}${total > 1 ? `（${part}/${total}）` : ""}`,
    summary: count ? `过去 ${edition ? 12 : 24} 小时收录精选 ${count} 件事\n\n${entries.map(block).join("\n\n")}` : "本期暂无新增精选事件。",
    source: `${SITE.name} · ${new Set(personalFacts(entries).map((e) => e.sourceId)).size} 个信源`,
    time: `${key} ${beijingTime(end)}（北京时间）`,
    ...(count === 0 ? { template: channel === "ai" ? "ai_daily" as const : "stock_daily" as const } : {}),
    // A template has one whole-message jump. Multiple original links are included as plain text.
  };
}

/** Several items per message; unusually busy days get numbered digest parts. */
export function dailyMessages(channel: DailyChannel, key: string, entries: Candidate[], end: Date, edition?: DailyEdition): WechatMessage[] {
  if (process.env.WECHAT_DAILY_MODE === "page") {
    const card = dailyPageMessage(channel, key, entries.length, end, edition);
    return card ? [card] : [];
  }
  if (!entries.length) return [message(channel, key, [], end, 1, 1, 0, edition)];
  const groups = parts(entries);
  return groups.map((group, i) => message(channel, key, group, end, i + 1, groups.length, entries.length, edition));
}

export async function previewDaily(channel: DailyChannel, now = new Date(), floor?: Date, edition?: DailyEdition) {
  const window = dailyWindow(channel, now, edition);
  const start = floor && floor > window.start ? floor : window.start;
  const all = start < window.end ? await candidates(start, window.end, floor) : [];
  const entries = all.filter((e) => e.category && (channel === "stock" ? e.category.startsWith("stock-") : !e.category.startsWith("stock-")));
  const previous = await sql<{ content: { entries: Candidate[]; supplements?: { entries: Candidate[] }[] } }[]>`SELECT content FROM notification_reports
    WHERE channel = ${channel} AND window_end < ${window.end} AND window_end >= ${new Date(window.end.getTime() - 7 * 86400_000)}`;
  const covered = new Set(previous.flatMap((r) => personalFacts([...r.content.entries, ...(r.content.supplements ?? []).flatMap((s) => s.entries)]))
    .flatMap((e) => [e.factKey, `a:${e.itemId}`]));
  const fresh = personalEvents(entries.filter((e) => !covered.has(e.factKey) && !covered.has(`a:${e.itemId}`)));
  return { ...window, entries: fresh, messages: dailyMessages(channel, window.key, fresh, window.end, window.edition) };
}

export async function pushDaily(channel: DailyChannel, now = new Date(), edition?: DailyEdition) {
  const window = dailyWindow(channel, now, edition);
  const [existing] = await sql<{ content: { entries: Candidate[] } }[]>`SELECT content FROM notification_reports WHERE channel = ${channel} AND key = ${window.reportKey}`;
  // Freeze the edition on first composition. Re-read current public controls before any delivery.
  if (!existing) {
    const report = await previewDaily(channel, now, undefined, window.edition);
    await sql`INSERT INTO notification_reports (channel,key,window_start,window_end,content)
      VALUES (${channel},${window.reportKey},${window.start},${window.end},${sql.json({ entries: report.entries, ...(window.edition ? { edition: window.edition } : {}) } as never)}) ON CONFLICT DO NOTHING`;
  }
  const [stored] = await sql<{ content: { entries: Candidate[] } }[]>`SELECT content FROM notification_reports WHERE channel = ${channel} AND key = ${window.reportKey}`;
  const targets = await sql<{ key: string; enabled_at: Date | null }[]>`SELECT key, enabled_at FROM notify_targets
    WHERE purpose = 'content' AND kind = 'wechat_template' AND enabled`;
  const current = await loadPersonalDailyCandidates(channel, window.key, now, undefined, window.edition);
  const stillPublic = new Map(personalFacts(current?.entries ?? []).map((e) => [e.itemId, e]));
  const count = current?.entries.length ?? 0;
  const deliveries: Array<{ target: string; status: string }> = [];
  for (const target of targets) {
    if (target.enabled_at && target.enabled_at >= window.end) continue;
    // A withdrawn edition is not a newly empty report; never send it as an all-clear notice.
    if (count === 0 && stored!.content.entries.length > 0) continue;
    // Preserve part identities after withdrawals, so a later retry cannot reshuffle already sent parts.
    const groups = parts(stored!.content.entries);
    if (process.env.WECHAT_DAILY_MODE === "page" || groups.length === 0) {
      const payload = process.env.WECHAT_DAILY_MODE === "page" ? dailyPageMessage(channel, window.key, count, window.end, window.edition)
        : message(channel, window.key, [], window.end, 1, 1, 0, window.edition);
      // No address means no delivery reservation; configuring it later can send the latest due issue.
      if (!payload) continue;
      deliveries.push(...await deliverContent({ subjectKind: "daily_report", subjectId: `${channel}:${window.reportKey}`,
        dedupeKey: `daily:${channel}:${window.reportKey}:1`, contentAt: window.end, card: {}, wechat: payload,
        targetKind: "wechat_template", targetKey: target.key }));
      continue;
    }
    for (const [i, group] of groups.entries()) {
      const entries = personalEvents(personalFacts(group).flatMap(e => stillPublic.has(e.itemId) ? [stillPublic.get(e.itemId)!] : []));
      if (!entries.length) continue;
      const payload = message(channel, window.key, entries, window.end, i + 1, groups.length, count, window.edition);
      deliveries.push(...await deliverContent({ subjectKind: "daily_report", subjectId: `${channel}:${window.reportKey}`,
        dedupeKey: `daily:${channel}:${window.reportKey}:${i + 1}`, contentAt: window.end, card: {}, wechat: payload,
        targetKind: "wechat_template", targetKey: target.key }));
    }
  }
  return { channel, key: window.key, edition: window.edition, entries: count, deliveries };
}

/** Catch up only each channel's latest due edition; a long WSL sleep never sends a backlog of days. */
export async function catchUpDaily(now = new Date()) {
  const results = [];
  for (const channel of ["ai", "stock"] as const) results.push(await pushDaily(channel, now));
  return results;
}
