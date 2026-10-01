// A separate semantic decision, cached and billed through the same receipts/budgets as editorial work.
import { z } from "zod";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";

const shortText = z.string().trim().max(20).refine(s => !/[\r\n]/.test(s));
// Models sometimes quote a whole English sentence despite the 180-character instruction.
// Verify the entire returned quote verbatim first, then store a bounded continuous excerpt.
const Schema = z.object({ urgent: z.boolean(), reason: z.string().max(300), evidence: z.string().max(2000),
  cardTitle: shortText, cardSummary: shortText }).refine(data => !data.urgent || !!(data.cardTitle && data.cardSummary),
  { message: "An urgent event needs a complete short title and key point" });
const VERSION = promptVersion("notification-urgent");
export interface UrgentAssessment { urgent: boolean; cardTitle: string; cardSummary: string }
const NOT_URGENT: UrgentAssessment = { urgent: false, cardTitle: "", cardSummary: "" };

export async function urgentEnabled(contentAt: Date): Promise<boolean> {
  if (!config.wechatPushEnabled || !config.modelCallsEnabled || process.env.WECHAT_URGENT_ENABLED === "false") return false;
  if (process.env.WECHAT_SEPARATE_TEMPLATES === "true" && !credential("integrations", "WECHAT_URGENT_TEMPLATE_ID")) return false;
  return !!(await sql`SELECT 1 FROM notify_targets WHERE purpose = 'content' AND kind = 'wechat_template' AND enabled
    AND (enabled_at IS NULL OR enabled_at <= ${contentAt}) LIMIT 1`)[0];
}

export function supportedUrgency(data: { urgent: boolean; evidence: string; reason: string }, body: string): boolean {
  return data.urgent && data.evidence.trim().length > 0 && body.includes(data.evidence);
}

export async function urgentDecision(articleId: string): Promise<boolean> {
  return (await urgentAssessment(articleId)).urgent;
}

export async function urgentAssessment(articleId: string): Promise<UrgentAssessment> {
  const [row] = await sql<{ title: string; category: string | null; body_text: string | null; body_status: string; first_party: boolean }[]>`
    SELECT p.title, p.category, a.body_text, a.body_status, p.first_party
    FROM publications p JOIN articles a ON a.id = p.article_id WHERE p.article_id = ${articleId}`;
  // Only original sources with readable evidence can interrupt a digest. Other selected items stay in it.
  if (!row?.first_party || row.body_status !== "ok" || !row.body_text ||
      !["ai-models", "ai-products", "stock-policy", "stock-company"].includes(row.category ?? "")) return NOT_URGENT;
  const model = await modelFor("urgent");
  const body = row.body_text.slice(0, 16_000);
  const inputKey = sha256(JSON.stringify([VERSION, model, row.title, row.category, body]));
  const [cached] = await sql<{ urgent: boolean; card_title: string; card_summary: string }[]>`
    SELECT urgent,card_title,card_summary FROM notification_urgency WHERE article_id = ${articleId} AND input_key = ${inputKey}`;
  if (cached) return { urgent: cached.urgent, cardTitle: cached.card_title, cardSummary: cached.card_summary };
  const result = await chatJson({ model, purpose: "notification_urgent", subject: `urgent:${articleId}:${inputKey}`,
    promptVersion: VERSION, system: promptText("notification-urgent"),
    user: JSON.stringify({ title: row.title, category: row.category, original: body }), schema: Schema, temperature: 0, maxTokens: 500 });
  const urgent = supportedUrgency(result.data, body);
  await sql`INSERT INTO notification_urgency (article_id,input_key,urgent,reason,evidence,receipt_id,card_title,card_summary)
    VALUES (${articleId},${inputKey},${urgent},${result.data.reason},${result.data.evidence.slice(0, 180)},${result.receiptId},${result.data.cardTitle},${result.data.cardSummary}) ON CONFLICT DO NOTHING`;
  await completeReceipt(sql, result.receiptId);
  return { urgent, cardTitle: result.data.cardTitle, cardSummary: result.data.cardSummary };
}
