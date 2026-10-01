// Selected-item pushes to the content groups. One card per new fact: a short same-title lease holds
// back concurrent duplicates until grouping settles the fact, and the fact (or the article when it
// has none) is the dedupe identity per target. Old, backfilled or silenced items are never pushed.
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { itemUrl } from "../publication/links.ts";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { deliverContent } from "./deliver.ts";
import { selectedNotification, type SelectedNotification } from "../publication/notification.ts";
import { urgentAssessment, urgentEnabled, type UrgentAssessment } from "./urgent.ts";
import { SITE } from "@aihot/industry/site";
import { briefWechat } from "./wechat.ts";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import type { WechatMessage } from "./wechat.ts";

const MAX_AGE_MS = 12 * 3600_000;
const LEASE_MS = 10 * 60_000;

export function urgentWechat(r: SelectedNotification, assessment: UrgentAssessment): WechatMessage {
  let url = r.url;
  try {
    const base = new URL(process.env.DAILY_PUBLIC_BASE_URL ?? "");
    if (base.protocol === "https:" && !base.username && !base.password) url = new URL(`/event/${encodeURIComponent(r.article_id)}`, base).href;
  } catch { /* Without a public reader, retain the original source link. */ }
  return briefWechat({ title: assessment.cardTitle, summary: assessment.cardSummary, source: r.source_name,
    time: `${beijingDate(r.timeline_at)} ${beijingTime(r.timeline_at)}`, url, template: "urgent" });
}

export type PushOutcome =
  | { status: "pushed" | "skipped"; reason?: string; targets?: Array<{ target: string; status: string }> }
  | { status: "retry"; after: Date; reason: string };

function normalizedTitle(t: string) {
  return t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function card(r: SelectedNotification) {
  const category = r.category ? CATEGORY_LABELS[r.category] : null;
  const lines = [r.summary, r.reason ? `**推荐理由**：${r.reason}` : null, `来源：${r.source_name}`].filter(Boolean);
  return {
    header: { title: { tag: "plain_text", content: r.title }, template: "turquoise" },
    elements: [
      ...(category ? [{ tag: "note", elements: [{ tag: "plain_text", content: category }] }] : []),
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n\n") } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: `${SITE.name} 查看` }, url: itemUrl(r.article_id), type: "primary" },
          { tag: "button", text: { tag: "plain_text", content: "原文" }, url: r.url, type: "default" },
        ],
      },
    ],
  };
}

export async function pushSelected(articleId: string, now = new Date()): Promise<PushOutcome> {
  let r = await selectedNotification(articleId);
  if (!r || !r.selected || r.visibility !== "public") return { status: "skipped", reason: "not public selected" };
  if (r.silent) return { status: "skipped", reason: "silenced" };
  if (r.backfill || now.getTime() - r.timeline_at.getTime() > MAX_AGE_MS) return { status: "skipped", reason: "not live" };
  if (r.visible_after && r.visible_after > now) return { status: "retry", after: new Date(r.visible_after.getTime() + 5_000), reason: "release gate" };

  // WeChat normally receives the digest; only a separately verified major event interrupts it.
  const assessment = await urgentEnabled(r.discovered_at) ? await urgentAssessment(articleId) : undefined;
  // Judging urgency may take a model round-trip. Recheck publication and release controls afterwards.
  r = await selectedNotification(articleId);
  if (!r || !r.selected || r.visibility !== "public" || r.silent || r.backfill) return { status: "skipped", reason: "publication changed" };
  if (r.visible_after && r.visible_after > now) return { status: "retry", after: new Date(r.visible_after.getTime() + 5_000), reason: "release gate" };

  // Same-title lease: a concurrent report with the same headline waits for grouping.
  const leaseKey = `selected-title:${sha256(normalizedTitle(r.title)).slice(0, 24)}`;
  const [lease] = await sql<{ holder: string }[]>`
    INSERT INTO delivery_leases (lease_key, holder, expires_at) VALUES (${leaseKey}, ${articleId}, ${new Date(now.getTime() + LEASE_MS)})
    ON CONFLICT (lease_key) DO UPDATE SET holder = CASE WHEN delivery_leases.expires_at < ${now} THEN EXCLUDED.holder ELSE delivery_leases.holder END,
      expires_at = CASE WHEN delivery_leases.expires_at < ${now} THEN EXCLUDED.expires_at ELSE delivery_leases.expires_at END
    RETURNING holder`;
  if (lease && lease.holder !== articleId && !r.fact_id) return { status: "retry", after: new Date(now.getTime() + 2 * 60_000), reason: "same title in flight" };

  const dedupeKey = r.fact_id ? `selected:fact:${r.fact_id}` : `selected:article:${articleId}`;
  const targets = await deliverContent({ subjectKind: "selected", subjectId: articleId, dedupeKey, contentAt: r.discovered_at, card: card(r),
    wechat: assessment?.urgent ? urgentWechat(r, assessment) : undefined });
  return { status: targets.some((t) => t.status === "sent") ? "pushed" : "skipped", targets, reason: targets.length ? undefined : "no new target" };
}
