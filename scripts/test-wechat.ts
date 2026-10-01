// Dry-run by default. --send is the explicit one-message connectivity test after local setup.
import { credential } from "@aihot/backend/config";
import { briefWechat, sendWechat, WECHAT_TEMPLATES, wechatVerificationSignature, type WechatMessage } from "@aihot/backend/notify/wechat";
import { randomUUID } from "node:crypto";
import { writeFile, rename, rm } from "node:fs/promises";

const separate = process.env.WECHAT_SEPARATE_TEMPLATES === "true";
const required = ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_OPEN_ID", ...(separate ? Object.values(WECHAT_TEMPLATES) : ["WECHAT_TEMPLATE_ID"])];
if (separate && !process.argv.includes("--templates")) throw new Error("Use wechat-test --templates to verify all three templates");
const missing = required.filter((name) => !credential("integrations", name));
if (missing.length) {
  console.error(`尚未配置：${missing.join(", ")}。在本地配置文件中填写，不要发送到聊天中。`);
  process.exitCode = 1;
} else {
  const previewIndex = process.argv.indexOf("--reading-preview");
  const previewUrl = previewIndex >= 0 ? process.argv[previewIndex + 1] : undefined;
  if (previewIndex >= 0 && (!previewUrl || !/^https:\/\/[^/?#]+\/daily\/preview\/ai$/.test(previewUrl))) throw new Error("Provide the HTTPS AI reading-preview URL");
  const message: WechatMessage = briefWechat({ title: previewUrl ? "日报阅读样式测试" : "个人热点推送测试",
    summary: previewUrl ? "点击查看 AI 和股市日报示例" : "连接验证，不是实际资讯",
    source: "个人热点后台", time: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 16), ...(previewUrl ? { url: previewUrl } : {}) });
  const messages = separate ? [
    { ...message, title: "AI 日报样式测试", summary: "演示 2 条，点击查看完整排版", template: "ai_daily" as const },
    { ...message, title: "股市日报样式测试", summary: "演示 2 条，点击查看完整排版", url: previewUrl?.replace(/ai$/, "stock"), template: "stock_daily" as const },
    { ...message, title: "重大事件提醒样式测试", summary: "虚构示例，不是实际新闻", url: "https://github.com/", template: "urgent" as const },
  ].map(briefWechat) : [message];
  if (!process.argv.includes("--send")) console.log(JSON.stringify({ configured: true, sent: false, messages }, null, 2));
  else {
    let accepted = true;
    for (const item of messages) {
      const result = await sendWechat(item);
      console.log(JSON.stringify({ template: item.template ?? "legacy", ...result }));
      if (result.status !== "sent") { accepted = false; process.exitCode = 1; break; }
    }
    const index = process.argv.indexOf("--verification-file");
    const file = index >= 0 ? process.argv[index + 1] : undefined;
    if (file && accepted) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const signature = wechatVerificationSignature();
        await writeFile(temporary, JSON.stringify({ at: new Date().toISOString(), signature, status: "accepted" }), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    }

  }
}
