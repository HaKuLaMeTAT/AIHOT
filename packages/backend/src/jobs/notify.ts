// Content pushes: selected items after their release gate, and the images they need prepared first.
import type { PgBoss } from "pg-boss";
import { pushSelected } from "../notify/selected.ts";
import { prepareArticleMedia, warmShareImage } from "../media/prepare.ts";
import { enqueue, ensureQueue, QUEUES } from "./queue.ts";
import { BudgetExceededError } from "../providers/receipts.ts";

const MAX_RETRIES = 6;

export async function registerNotifyJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.notifySelected);
  await boss.work<{ articleId: string; attempt?: number }>(QUEUES.notifySelected, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    // The push makes chat apps unfurl the link: have its share image ready (first attempt only).
    if (!job.data.attempt && process.env.MEDIA_PREPARE_ENABLED !== "false") await warmShareImage(job.data.articleId);
    let outcome;
    try { outcome = await pushSelected(job.data.articleId); }
    catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      await enqueue(QUEUES.notifySelected, job.data, { startAfter: error.retryAfterSeconds, singletonKey: `budget:${job.id}` });
      return { status: "waiting", reason: "urgent judgement budget" };
    }
    const attempt = job.data.attempt ?? 0;
    if (outcome.status === "retry" && attempt < MAX_RETRIES) {
      await enqueue(QUEUES.notifySelected, { articleId: job.data.articleId, attempt: attempt + 1 }, { startAfter: outcome.after });
    }
    return outcome;
  });

  await ensureQueue(QUEUES.prepareMedia);
  await boss.work<{ articleId: string }>(QUEUES.prepareMedia, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async ([job]) => {
    if (!job) return;
    if (process.env.MEDIA_PREPARE_ENABLED === "false") return { skipped: true };
    return prepareArticleMedia(job.data.articleId);
  });
}
