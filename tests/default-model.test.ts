// The open-source default: one OpenAI-compatible model (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL) runs every
// step of the analysis, with no per-step configuration.
import { enableLocalModelStub, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { stopBoss } from "@aihot/backend/jobs/queue";

// Nothing chosen per step: every capability falls back to the `default` model.
for (const name of Object.keys(process.env)) if (/_MODEL$/.test(name) && name !== "LLM_MODEL" && name !== "EMBEDDING_MODEL") delete process.env[name];

const T = tag();
const SOURCE = `test-default-model-${T}`;
const seen: Array<{ model: string; system: string }> = [];
let failScore = false;
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { model: string; messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const user = String(body.messages.at(-1)!.content);
  seen.push({ model: body.model, system });
  const content =
    system.includes("宽召回") ? { label: "PASS", reason: "测试" }
    : system.includes("事件注意力评分器") ? { attentionScore: failScore ? "invalid" : 80 }
    : system.includes("内容理解编辑") ? { itemType: "product_launch", authorRole: "principal", tags: ["产品更新"], editorialJudgment: "理由", titleZh: "一个模型的标题", summaryZh: "一个模型写的摘要。第二句。" }
    : system.includes("资料结构化助手") ? { category: "ai-products", tags: ["产品更新"], subjects: [], fact: null }
    : user.includes("title_zh") ? "title_zh: 标题\nsummary_zh: 摘要。"
    : null;
  if (content === null) throw new Error("unexpected request");
  return { id: `stub-${seen.length}`, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});

test("serial personal analysis keeps both scores and defers structure until writing succeeds", async () => {
  process.env.EDITORIAL_SERIAL_STEPS = "true";
  const start = seen.length;
  try {
    const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}-serial`, title: "New model release",
      bodyText: "A company launched a model with pricing and availability. ".repeat(6), bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    const res = await analyzeArticle(articleId);
    assert.equal(res!.output!.selected, true);
    const calls = seen.slice(start);
    assert.equal(calls.length, 5);
    assert.ok(calls[1]!.system.includes("事件注意力评分器") && calls[2]!.system.includes("事件注意力评分器"));
    assert.ok(calls[3]!.system.includes("内容理解编辑") && calls[4]!.system.includes("资料结构化助手"));
    failScore = true;
    const failing = await upsertMaterial({ sourceId: SOURCE, url: `https://example.com/${T}-serial-failure`, title: "Another model release",
      bodyText: "A new model was released with technical specifications. ".repeat(6), bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
    const failedStart = seen.length;
    await assert.rejects(analyzeArticle(failing.articleId));
    assert.ok(!seen.slice(failedStart).some((r) => r.system.includes("资料结构化助手")), "failed scoring must not spend a structure call");
  } finally { failScore = false; delete process.env.EDITORIAL_SERIAL_STEPS; }
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "one-model", MODEL_CALLS_ENABLED: "true" });

before(async () => {
  await enableLocalModelStub(provider.url);
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Test default model', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("one model runs the prefilter, both scores, the writing and the structure", async () => {
  const start = seen.length;
  const { articleId } = await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}`, title: `A product launch ${T}`, bodyText: `A company launched a product with pricing and availability. ${T} `.repeat(6),
    bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  } as never);
  const res = await analyzeArticle(articleId);
  assert.equal(res!.output!.selected, true);
  assert.equal(res!.output!.titleZh, "一个模型的标题");
  assert.equal(seen.length - start, 5, "prefilter, two scores, understand, structure");
  assert.ok(seen.every((r) => r.model === "one-model"), "every request names the configured model");
  const services = await sql<{ service: string }[]>`SELECT DISTINCT service FROM receipts WHERE subject LIKE ${`article:${articleId}%`}`;
  assert.deepEqual(services.map((s) => s.service), ["llm"]);
});
