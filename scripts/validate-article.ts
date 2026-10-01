// A single real article through extraction, receipts, analysis and publication. Production only;
// the worker must keep MODEL_CALLS_ENABLED=false while an operator runs this limited validation.
import { sql, closeDb } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { processArticle } from "@aihot/backend/jobs/content";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";
import { stopBoss } from "@aihot/backend/jobs/queue";
const id = process.argv[2];
try {
  if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Provide an existing article id");
  const [article] = await sql<{ body_status: string; processing_state: string }[]>`SELECT body_status, processing_state FROM articles WHERE id=${id}`;
  if (!article) throw new Error("Article not found");
  console.log(JSON.stringify({ articleId: id, extraction: article.body_status === "pending" ? await extractArticleBody(id, false) : "skipped" }));
  for (let attempt = 0; ; attempt++) {
    try { console.log(JSON.stringify({ articleId: id, result: await processArticle(id) })); break; }
    catch (error) {
      if (!(error instanceof BudgetExceededError) || error.retryAfterSeconds > 60 || attempt >= 2) throw error;
      console.log("等待一分钟预算窗口；已收到的结果将复用。");
      await new Promise(resolve => setTimeout(resolve, 60_000));
    }
  }
  const rows = await sql`SELECT a.source_id,a.processing_state,p.category,p.title,p.summary FROM articles a LEFT JOIN publications p ON p.article_id=a.id WHERE a.id=${id}`;
  console.log(JSON.stringify(rows));
} finally { await stopBoss(); await closeDb(); }
