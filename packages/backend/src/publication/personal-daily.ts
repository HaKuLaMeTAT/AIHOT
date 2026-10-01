// A frozen edition's membership with current public text and withdrawal controls.
import { isValidDate } from "@aihot/contracts/time";
import { dailyEditionKey, validDailyEdition, type DailyEdition } from "@aihot/contracts/personal-daily";
import { sql } from "../db.ts";
import { personalEvents, type Candidate } from "./report-candidates.ts";

export interface DailyEntry {
  title: string;
  summary: string;
  category: string | null;
  sourceName: string;
  sourceUrl: string;
  publishedAt: string;
  relatedEntries?: DailyEntry[];
}
export interface PersonalDaily {
  channel: "ai" | "stock";
  key: string;
  windowStart: string;
  windowEnd: string;
  entries: DailyEntry[];
  manualSupplement?: boolean;
  supplement?: string;
  edition?: DailyEdition;
}

interface EditionItem { itemId: string; relatedEntries?: EditionItem[] }
interface EditionContent { entries: EditionItem[]; kind?: string }
interface Supplement extends EditionContent { key: string; windowStart: string; windowEnd: string }

function memberIds(entries: EditionItem[]): string[] {
  return entries.flatMap(e => [e.itemId, ...memberIds(e.relatedEntries ?? [])]);
}

function dailyEntry(entry: Candidate): DailyEntry {
  return { title: entry.title, summary: entry.summary, category: entry.category, sourceName: entry.sourceName,
    sourceUrl: entry.sourceUrl, publishedAt: entry.publishedAt,
    ...(entry.relatedEntries?.length ? { relatedEntries: entry.relatedEntries.map(dailyEntry) } : {}) };
}

export interface DailyArchiveEntry { channel: "ai" | "stock"; key: string; edition?: DailyEdition; supplement?: string; windowEnd: string; count: number; path: string }

/** All archive exits use the same current withdrawal and public-content checks as dated reading. */
export async function listPersonalDailies(channel: string, now = new Date(), limit = 30): Promise<DailyArchiveEntry[]> {
  if (channel !== "ai" && channel !== "stock") return [];
  const rows = await sql<{ key: string; content: { supplements?: Supplement[] } }[]>`
    SELECT key,content FROM notification_reports WHERE channel=${channel} AND window_end <= ${now}
    ORDER BY window_end DESC,key DESC LIMIT 30`;
  const entries: DailyArchiveEntry[] = [];
  for (const row of rows) {
    const [key, edition] = row.key.split(":");
    if (!key || !isValidDate(key) || (edition && !validDailyEdition(edition))) continue;
    const add = async (supplement?: string) => {
      const report = await loadPersonalDaily(channel, key, now, supplement, edition);
      if (!report?.entries.length) return;
      entries.push({ channel, key, ...(edition ? { edition: edition as DailyEdition } : {}), ...(supplement ? { supplement } : {}),
        windowEnd: report.windowEnd, count: report.entries.length,
        path: `/daily/${channel}/${key}${supplement ? `/supplement/${supplement}` : edition ? `/${edition}` : ""}` });
    };
    await add();
    for (const s of row.content.supplements ?? []) await add(s.key);
  }
  return entries.sort((a, b) => b.windowEnd.localeCompare(a.windowEnd) || Number(b.supplement ?? 0) - Number(a.supplement ?? 0))
    .slice(0, Math.max(1, Math.min(30, limit)));
}

export type PersonalDailyCandidates = Omit<PersonalDaily, "entries"> & { entries: Candidate[] };

/** A shared frozen-edition projection for delivery counts and all personal reading exits. */
export async function loadPersonalDailyCandidates(channel: string, key: string, now = new Date(), supplement?: string, edition?: string): Promise<PersonalDailyCandidates | null> {
  if ((channel !== "ai" && channel !== "stock") || !isValidDate(key) || (supplement !== undefined && !/^[1-9]\d{0,2}$/.test(supplement))) return null;
  if (edition !== undefined && !validDailyEdition(edition)) return null;
  const reportKey = dailyEditionKey(key, edition);
  const [report] = await sql<{ window_start: Date; window_end: Date; content: EditionContent & { supplements?: Supplement[] } }[]>`
    SELECT window_start,window_end,content FROM notification_reports WHERE channel=${channel} AND key=${reportKey}`;
  if (!report) return null;
  const extra = supplement ? report.content.supplements?.find((s) => s.key === supplement) : undefined;
  if (supplement && !extra) return null;
  const start = extra ? new Date(extra.windowStart) : report.window_start;
  const end = extra ? new Date(extra.windowEnd) : report.window_end;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end > now) return null;
  const content = extra ?? report.content;
  // Only an explicitly stored manual edition may show first-install historical material.
  const manualSupplement = content.kind === "manual_supplement";
  const ids = memberIds(content.entries);
  const rows = ids.length ? await sql<{ id: string; title: string; summary: string | null; category: string | null; source_name: string; url: string; at: Date;
    source_id: string; first_party: boolean; score: number | null; fact_id: string | null; story_id: string | null }[]>`
    SELECT p.article_id AS id,p.title,p.summary,p.category,s.name AS source_name,p.url,s.id AS source_id,p.first_party,p.score,
      f.public_id AS fact_id,st.public_id::text AS story_id,
      CASE WHEN ${manualSupplement} THEN coalesce(p.published_at,p.timeline_at) ELSE p.timeline_at END AS at
    FROM publications p JOIN sources s ON s.id=p.source_id LEFT JOIN editorial_overrides o ON o.article_id=p.article_id
    LEFT JOIN facts f ON f.id=p.fact_id LEFT JOIN stories st ON st.id=f.story_id
    WHERE p.article_id IN ${sql(ids)} AND p.visibility='public' AND p.eligible AND p.selected AND (NOT p.backfill OR ${manualSupplement})
      AND NOT coalesce((o.fields->>'silent')::boolean,false) AND p.visible_after <= ${now}` : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const members: Candidate[] = ids.flatMap(id => { const r = byId.get(id); return r ? [{ itemId: r.id, title: r.title, summary: r.summary ?? "",
    category: r.category, sourceName: r.source_name, sourceUrl: r.url, sourceId: r.source_id, firstParty: r.first_party,
    role: r.first_party ? "官方" : "媒体", score: r.score, publishedAt: r.at.toISOString(), factId: r.fact_id,
    storyPublicId: r.story_id, factKey: r.fact_id ?? `a:${r.id}` }] : []; });
  return { channel, key, windowStart: start.toISOString(), windowEnd: end.toISOString(),
    ...(manualSupplement ? { manualSupplement: true } : {}),
    ...(supplement ? { supplement } : {}),
    ...(edition ? { edition } : {}),
    entries: personalEvents(members) };
}

export async function loadPersonalDaily(channel: string, key: string, now = new Date(), supplement?: string, edition?: string): Promise<PersonalDaily | null> {
  const report = await loadPersonalDailyCandidates(channel, key, now, supplement, edition);
  return report ? { ...report, entries: report.entries.map(dailyEntry) } : null;
}
