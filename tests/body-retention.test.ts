import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { retireArticleBodies } from "@aihot/backend/operations/retention";
import { getBoss, stopBoss, enqueue, QUEUES } from "@aihot/backend/jobs/queue";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { logicalKeyFor, paidRequest } from "@aihot/backend/providers/receipts";

const source = `retention-${tag()}`;
const now = new Date();
before(async () => {
  await getBoss();
  await sql`INSERT INTO sources (id,name,kind,tier,enabled) VALUES (${source},'Retention tests','rss','T1',false)`;
});
after(async () => { await stopBoss(); await closeDb(); });

async function article(age: number, selected = false, suffix = tag()) {
  const date = new Date(now.getTime() - age * 86400_000);
  const input = { sourceId: source, url: `https://example.com/retention/${suffix}`, title: '原始标题',
    bodyText: '应到期清理的原始正文', bodyHtml: '<p>原始正文</p>', excerpt: '简短摘要', raw: { original: '采集原文' },
    bodyStatus: 'ok' as const, via: 'fetch' as const, discoveredAt: date };
  const { articleId } = await upsertMaterial(input);
  await sql`UPDATE articles SET processing_state='analyzed',updated_at=${date} WHERE id=${articleId}`;
  await sql`INSERT INTO publications (article_id,title,summary,source_id,channel,url,discovered_at,timeline_at,sort_at,selected)
    VALUES (${articleId},'中文标题','保留的中文摘要',${source},'news',${input.url},${date},${date},${date},${selected})`;
  await sql`INSERT INTO translations (article_id,revision,body_text,body_html) VALUES (${articleId},1,'译文正文','<p>译文正文</p>')`;
  return { id: articleId, input };
}

test("retirement keeps identities, summaries, versions and paid responses reusable", async () => {
  const { id, input } = await article(100);
  const request = { service: 'test-retention', purpose: 'score', subject: `article:${id}@1`, identity: { id } };
  await sql`INSERT INTO receipts (logical_key,service,purpose,subject,status,response,created_at)
    VALUES (${logicalKeyFor(request)},${request.service},'score',${request.subject},'completed',${sql.json({ preserved: true })},${new Date('2020-01-01')})`;
  await retireArticleBodies(now);
  const [row] = await sql`SELECT body_text,body_html,raw,raw_retired_at,revision,identity_key,content_hash FROM articles WHERE id=${id}`;
  assert.equal(row.body_text, null); assert.equal(row.body_html, null); assert.equal(row.raw, null);
  assert.ok(row.raw_retired_at); assert.equal(row.revision, 1); assert.ok(row.identity_key); assert.ok(row.content_hash);
  assert.equal((await sql`SELECT summary FROM publications WHERE article_id=${id}`)[0].summary, '保留的中文摘要');
  const [revision] = await sql`SELECT content_hash,body_text FROM article_revisions WHERE article_id=${id}`;
  assert.ok(revision.content_hash); assert.equal(revision.body_text, null);
  assert.equal((await sql`SELECT body_text FROM translations WHERE article_id=${id}`)[0].body_text, null);
  const repeated = await upsertMaterial({ ...input, bodyText: '旧信源再次返回的正文' });
  assert.equal(repeated.revised, false);
  assert.equal(await queueProcessing(id, { attemptTag: 'manual-retired' }), null);
  assert.equal(await loadAnalyzeInput(id), null);
  assert.equal(await extractArticleBody(id), 'skipped');
  const reused = await paidRequest(request, async () => { throw new Error('must reuse the old response'); });
  assert.equal(reused.reused, true); assert.deepEqual(reused.response, { preserved: true });
});

test("selected items get 180 days, and recent edits extend raw retention", async () => {
  const young = await article(89), selected = await article(100, true), old = await article(181, true);
  const edited = await article(190);
  await sql`UPDATE articles SET updated_at=${now} WHERE id=${edited.id}`;
  await retireArticleBodies(now);
  const rows = await sql`SELECT id,raw_retired_at FROM articles WHERE id IN ${sql([young.id, selected.id, old.id, edited.id])}`;
  assert.deepEqual(new Set(rows.filter((r) => r.raw_retired_at).map((r) => r.id)), new Set([old.id]));
});

test("active work, unresolved receipts, manual corrections and full-text publications are protected", async () => {
  const protectedIds: string[] = [];
  for (const status of ['pending','received','unknown']) {
    const a = await article(190); protectedIds.push(a.id);
    await sql`INSERT INTO receipts (logical_key,service,purpose,subject,status)
      VALUES (${`retention-${a.id}`},'test-retention','score',${`article:${a.id}@1`},${status})`;
  }
  const manual = await article(190); protectedIds.push(manual.id);
  await sql`INSERT INTO editorial_overrides (article_id,fields) VALUES (${manual.id},'{}')`;
  const full = await article(190); protectedIds.push(full.id);
  await sql`UPDATE publications SET body_mode='full' WHERE article_id=${full.id}`;
  const pending = await article(190); protectedIds.push(pending.id);
  await sql`UPDATE articles SET processing_state='new' WHERE id=${pending.id}`;
  const queued = await article(190); protectedIds.push(queued.id);
  await enqueue(QUEUES.analyze, { articleId: queued.id }, { singletonKey: queued.id });
  await retireArticleBodies(now);
  assert.equal((await sql`SELECT 1 FROM articles WHERE id IN ${sql(protectedIds)} AND raw_retired_at IS NOT NULL`).length, 0);
});

test("previously selected articles and calibration samples retain their material", async () => {
  const past = await article(100), sample = await article(190);
  await sql`INSERT INTO analyses (article_id,input_revision,origin,selected) VALUES (${past.id},1,'rule',true)`;
  const run = `retention-${tag()}`;
  await sql`INSERT INTO selectbench_runs (id,label,sample_size,models,summary) VALUES (${run},'retention',1,'{}','{}')`;
  await sql`INSERT INTO selectbench_results (run_id,model,case_id,title,gold)
    VALUES (${run},'local-test',${sample.id},'校准样本','keep')`;
  await retireArticleBodies(now);
  assert.equal((await sql`SELECT 1 FROM articles WHERE id IN ${sql([past.id,sample.id])} AND raw_retired_at IS NOT NULL`).length, 0);
});
