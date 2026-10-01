// Run only after configuring and testing the account. No historical backlog is pushed.
import { credential } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WECHAT_TEMPLATES, wechatVerificationSignature } from "@aihot/backend/notify/wechat";
try {
  const enabled = process.argv.includes("--enable");
  if (!enabled && !process.argv.includes("--disable")) throw new Error("Use --enable or --disable");
  if (enabled && ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_OPEN_ID", ...(process.env.WECHAT_SEPARATE_TEMPLATES === "true" ? Object.values(WECHAT_TEMPLATES) : ["WECHAT_TEMPLATE_ID"])].some(k => !credential("integrations", k))) throw new Error("Configure WeChat credentials locally first");
  if (enabled) {
    const index = process.argv.indexOf("--env-file");
    const file = index >= 0 ? process.argv[index + 1] : undefined;
    if (!file) throw new Error("Specify --env-file for the private verification record");
    const verified = await readFile(path.join(path.dirname(file), "wechat-verified.json"), "utf8")
      .then((s) => JSON.parse(s) as { signature: string; status: string }, () => null);
    if (process.env.WECHAT_SEPARATE_TEMPLATES === "true" && Object.values(WECHAT_TEMPLATES).some((k) => !credential("integrations", k))) throw new Error("Configure all three templates first");
    const signature = wechatVerificationSignature();
    if (verified?.status !== "accepted" || verified.signature !== signature) throw new Error("Run wechat-test --send for the current credentials first");
  }
  await sql`UPDATE notify_targets SET enabled=${enabled},
    enabled_at=CASE WHEN ${enabled} THEN CASE WHEN enabled AND enabled_at IS NOT NULL THEN enabled_at ELSE now() END ELSE NULL END
    WHERE key='wechat-personal'`;
  console.log(enabled ? "微信目标已启用；仍需 WECHAT_PUSH_ENABLED=true 并重启 worker/API。" : "微信目标已关闭。");
} catch {
  console.error("微信目标未完成配置，请先填写本地凭据并运行 wechat-test --templates --send 验证三个模板（旧单模板模式省略 --templates），然后使用 wechat-enable。");
  process.exitCode = 1;
} finally { await closeDb(); }
