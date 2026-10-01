// Notification content is read from the same public projection as the site and API.
import { sql } from "../db.ts";
import type { CategoryKey } from "@aihot/contracts/taxonomy";

export interface SelectedNotification {
  article_id: string;
  selected: boolean;
  visibility: string;
  title: string;
  summary: string | null;
  reason: string | null;
  category: CategoryKey | null;
  source_name: string;
  url: string;
  timeline_at: Date;
  discovered_at: Date;
  visible_after: Date | null;
  backfill: boolean;
  fact_id: number | null;
  silent: boolean;
}

export async function selectedNotification(articleId: string) {
  const [r] = await sql<SelectedNotification[]>`
    SELECT p.article_id, p.selected, p.visibility, p.title, p.summary, p.reason, p.category, s.name AS source_name, p.url,
           p.timeline_at, p.discovered_at, p.visible_after, p.backfill, p.fact_id,
           coalesce((o.fields->>'silent')::boolean, false) AS silent
    FROM publications p JOIN sources s ON s.id = p.source_id LEFT JOIN editorial_overrides o ON o.article_id = p.article_id
    WHERE p.article_id = ${articleId} AND p.eligible`;
  return r;
}

/** Public single-event reading shares the selection, release and withdrawal controls. */
export async function publicNotification(articleId: string, now = new Date()): Promise<SelectedNotification | null> {
  if (!/^[a-z0-9]{1,64}$/.test(articleId)) return null;
  const row = await selectedNotification(articleId);
  if (!row || !row.selected || row.visibility !== "public" || row.silent || row.backfill ||
      !row.visible_after || row.visible_after > now) return null;
  return row;
}
