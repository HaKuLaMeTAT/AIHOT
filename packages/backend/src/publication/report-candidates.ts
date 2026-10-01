// Shared public report candidate reader; release boundaries and withdrawals apply to every report.
import { sql } from "../db.ts";

export interface ReportEntry {
  itemId: string;
  factId: string | null;
  storyPublicId: string | null;
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  sourceId: string;
  firstParty: boolean;
  role: string;
  score: number | null;
  publishedAt: string;
}

export interface Candidate extends ReportEntry {
  category: string | null;
  factKey: string;
  relatedEntries?: Candidate[];
}

/** Flatten both legacy fact lists and personal editions containing grouped developments. */
export function personalFacts(entries: Candidate[]): Candidate[] {
  return entries.flatMap(({ relatedEntries, ...entry }) => [entry, ...personalFacts(relatedEntries ?? [])]);
}

/** One personal digest item per already-established story; never infer identity from names. */
export function personalEvents(entries: Candidate[]): Candidate[] {
  const events = new Map<string, Candidate>();
  const seen = new Set<string>();
  for (const entry of personalFacts(entries)) {
    if (seen.has(entry.itemId)) continue;
    seen.add(entry.itemId);
    const channel = entry.category?.startsWith("stock-") ? "stock" : "ai";
    const key = `${channel}:${entry.storyPublicId ? `story:${entry.storyPublicId}` : `fact:${entry.factKey}`}`;
    const event = events.get(key);
    if (event) (event.relatedEntries ??= []).push(entry);
    else events.set(key, { ...entry });
  }
  return [...events.values()];
}

function roleOf(kind: string, firstParty: boolean): string {
  if (firstParty) return kind === "x_search" ? "X·官方" : "官方";
  if (kind === "x_search") return "X·KOL";
  if (kind === "mp_account") return "公众号";
  return "媒体";
}

// First-install historical material is available only for an explicitly requested manual edition.
export async function candidates(start: Date, end: Date, discoveredAfter?: Date, options: { includeBackfill?: boolean } = {}): Promise<Candidate[]> {
  const rows = await sql.begin("isolation level read committed", async (tx) => {
    // Wait for in-flight releases and keep later ones outside this snapshot. The following SELECT
    // gets a fresh READ COMMITTED snapshot; model calls and report writes happen after the lock ends.
    await tx`SELECT pg_advisory_xact_lock(hashtext('report_candidates'))`;
    return tx<{
      id: string; title: string; summary: string | null; url: string; category: string | null; score: number | null; first_party: boolean;
      source_id: string; source_name: string; source_kind: string; fact_public_id: string | null; story_public_id: string | null; at: Date; backfill: boolean;
    }[]>`
      SELECT p.article_id AS id, p.title, p.summary, p.url, p.category, p.score, p.first_party, s.id AS source_id, s.name AS source_name,
             s.kind AS source_kind, f.public_id AS fact_public_id, st.public_id::text AS story_public_id, p.timeline_at AS at, p.backfill
      FROM publications p JOIN sources s ON s.id = p.source_id
      LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
      LEFT JOIN facts f ON f.id = p.fact_id LEFT JOIN stories st ON st.id = f.story_id
      -- Attribute each item by the later of arrival and release; either range can use its index.
      WHERE p.visibility = 'public' AND p.selected AND p.eligible AND (NOT p.backfill OR ${options.includeBackfill === true})
        AND NOT coalesce((o.fields->>'silent')::boolean, false)
        AND (${discoveredAfter ?? null}::timestamptz IS NULL OR p.discovered_at >= ${discoveredAfter ?? null})
        AND (
          (p.visible_after <= p.timeline_at AND p.timeline_at >= ${start} AND p.timeline_at < ${end})
          OR (p.visible_after > p.timeline_at AND p.visible_after >= ${start} AND p.visible_after < ${end})
        )`;
  });
  // One entry per fact: first-party first, then score.
  const byFact = new Map<string, Candidate>();
  for (const r of rows) {
    const key = r.fact_public_id ?? `a:${r.id}`;
    const c: Candidate = {
      itemId: r.id, factId: r.fact_public_id, storyPublicId: r.story_public_id, title: r.title, summary: r.summary ?? "",
      sourceName: r.source_name, sourceUrl: r.url, sourceId: r.source_id, firstParty: r.first_party, role: roleOf(r.source_kind, r.first_party),
      score: r.score === null ? null : Number(r.score), publishedAt: r.at.toISOString(), category: r.category, factKey: key,
    };
    const prev = byFact.get(key);
    if (!prev || Number(c.firstParty) - Number(prev.firstParty) > 0 || (c.firstParty === prev.firstParty && (c.score ?? 0) > (prev.score ?? 0))) byFact.set(key, c);
  }
  return [...byFact.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
