// Switch only the private deployment. A failed preflight leaves both config and worker untouched.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { credential } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

try {
  const provider = process.argv[2];
  const index = process.argv.indexOf("--env-file");
  const file = index >= 0 ? process.argv[index + 1] : undefined;
  if (!file || !["codex", "deepseek"].includes(provider ?? "")) throw new Error("Specify codex/deepseek and --env-file");
  if (provider === "deepseek") {
    const key = credential("models", "LLM_API_KEY");
    if (!key || process.env.LLM_MODEL !== "deepseek-flash" || process.env.LLM_BASE_URL !== "https://api.deepseek.com/v1") {
      throw new Error("Run configure-deepseek first");
    }
    const verified = await readFile(path.join(path.dirname(file), "deepseek-verified.json"), "utf8")
      .then((s) => JSON.parse(s) as { keyHash: string; receiptId: number; model: string; baseUrl: string }, () => null);
    if (!verified || verified.keyHash !== createHash("sha256").update(key).digest("hex")
      || verified.model !== process.env.LLM_MODEL || verified.baseUrl !== process.env.LLM_BASE_URL) {
      throw new Error("Run deepseek-check for the current credentials first");
    }
    const [receipt] = await sql`SELECT 1 FROM receipts WHERE id=${verified.receiptId}
      AND service='llm' AND model='deepseek-flash' AND purpose='deployment_connectivity' AND status='completed'`;
    if (!receipt) throw new Error("DeepSeek verification receipt is unavailable; run deepseek-check");
  } else if (!process.env.CODEX_MODEL) throw new Error("CODEX_MODEL is not configured");
  const [budget] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='llm'`;
  if (provider === "deepseek" && (!budget || budget.per_minute > 6 || budget.per_hour > 60 || budget.per_day > 300)) {
    throw new Error("Set the llm budget to at most 6/minute, 60/hour, 300/day before switching");
  }
  await promisify(execFile)("python3", [path.join(import.meta.dirname, "configure-integrations.py"), `use-${provider}`, "--config", file]);
  console.log(provider === "deepseek" ? "主通道已设为 DeepSeek；沿用 llm 预算，将重启个人热点 worker。" : "主通道已设为 Codex CLI；将重启个人热点 worker。");
} catch (error) {
  // Only errors deliberately created above are useful; never expose subprocess/provider details.
  const safe = error instanceof Error && /^(Run |Specify |CODEX_MODEL |DeepSeek verification |Set the llm budget)/.test(error.message);
  console.error(safe ? error.message : "切换失败，请检查本地配置与模型验证记录；配置未主动切换。");
  process.exitCode = 1;
} finally { await closeDb(); }
