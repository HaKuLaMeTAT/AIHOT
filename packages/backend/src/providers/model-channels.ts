import { processingChannel } from "@aihot/industry/processing";
import { sql } from "../db.ts";

export type ModelChannel = "ai" | "stock";
const MODEL_SERVICES = new Set(["codex", "llm", "deepseek", "zhipu", "dashscope", "mimo"]);

export function splitModelBudget(service: string): boolean {
  return process.env.MODEL_CHANNEL_BUDGETS_ENABLED === "true" && MODEL_SERVICES.has(service);
}

/** Source ownership remains stable through analysis, grouping and urgent judgement. */
export async function modelChannelFor(subject?: string | null): Promise<ModelChannel> {
  const article = /^(?:article|urgent):([^:@#]+)/.exec(subject ?? "");
  if (article) {
    const [row] = await sql<{ source_id: string }[]>`SELECT source_id FROM articles WHERE id=${article[1]!}`;
    if (row) return processingChannel(row.source_id);
  }
  const story = /^story:(\d+)/.exec(subject ?? "");
  if (story) {
    const [row] = await sql<{ source_id: string }[]>`SELECT a.source_id FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id
      JOIN articles a ON a.id=fa.article_id WHERE f.story_id=${Number(story[1])}
      ORDER BY a.discovered_at,a.id LIMIT 1`;
    if (row) return processingChannel(row.source_id);
  }
  // Connection checks and other unattributed model work also consume a share; never bypass quotas.
  return "ai";
}
