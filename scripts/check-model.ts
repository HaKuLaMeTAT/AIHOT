// One production connectivity check, through the same receipt and budget path as the worker.
import { z } from "zod";
import { chatJson, markReceiptsCompleted, MODELS } from "@aihot/backend/providers/llm";
import { closeDb } from "@aihot/backend/db";
import { ProviderRejectedError, BudgetExceededError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";
import { credential } from "@aihot/backend/config";

const providerIndex = process.argv.indexOf("--provider");
const provider = providerIndex >= 0 ? process.argv[providerIndex + 1] : undefined;
if (provider && !["deepseek", "codex"].includes(provider)) throw new Error("Use --provider deepseek or codex");
if (provider) process.env.LLM_PROVIDER = provider === "codex" ? "codex" : "api";
if (provider === "deepseek" && (process.env.LLM_MODEL !== "deepseek-flash" || process.env.LLM_BASE_URL !== "https://api.deepseek.com/v1")) {
  throw new Error("Configure the official DeepSeek channel locally first");
}
try {
  const result = await chatJson({ model: "default", purpose: "deployment_connectivity", subject: "deployment:model:v1", promptVersion: "deployment-v1",
    system: '仅输出 JSON {"ok":true,"message":"连接正常"}，不调用工具。', user: "验证结构化中文输出。",
    schema: z.object({ ok: z.literal(true), message: z.string() }), timeoutMs: 90_000,
    ...(process.argv.includes("--fresh") ? { attemptTag: `connectivity:${randomUUID()}` } : {}) });
  await markReceiptsCompleted([result.receiptId]);
  const verificationIndex = process.argv.indexOf("--verification-file");
  if (provider === "deepseek" && !result.reused && verificationIndex >= 0) {
    const file = process.argv[verificationIndex + 1];
    if (!file) throw new Error("Verification file missing");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ at: new Date().toISOString(), receiptId: result.receiptId,
        model: process.env.LLM_MODEL, baseUrl: process.env.LLM_BASE_URL,
        keyHash: createHash("sha256").update(credential("models", "LLM_API_KEY")!).digest("hex") }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  console.log(JSON.stringify({ ...result.data, receiptId: result.receiptId, reused: result.reused, model: MODELS[result.model]?.model ?? result.model, usage: result.usage }));
} catch (error) {
  // Provider bodies and exceptions may echo credentials; only report classified, safe diagnostics.
  const detail = error instanceof ProviderRejectedError ? `模型接口拒绝，HTTP ${error.status ?? "未发出请求"}`
    : error instanceof BudgetExceededError ? "模型预算已达到上限，请稍后再试"
    : error instanceof ReceiptUnknownError ? `回执 ${error.receiptId} 结果未知，请先检查回执再决定是否重试`
    : "连接未验证，请检查本地配置、网络和模型回执；不要连续重复测试";
  console.error(JSON.stringify({ ok: false, detail }));
  process.exitCode = 1;
} finally { await closeDb(); }
