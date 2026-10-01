// A single tracked, clearly labelled functionality test; it never creates news or model work.
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { deliverContent } from "@aihot/backend/notify/deliver";
import { briefWechat } from "@aihot/backend/notify/wechat";

try {
  if (!process.argv.includes("--send")) {
    const [receipt] = await sql`SELECT count(*)::int AS count,max(received_at) AS latest FROM wechat_delivery_events`;
    console.log(JSON.stringify({ callbackEnabled: process.env.WECHAT_CALLBACK_ENABLED === "true", recordedReceipts: receipt?.count ?? 0, latestReceipt: receipt?.latest ?? null, sent: false }));
  } else {
    if (!config.wechatPushEnabled || process.env.WECHAT_CALLBACK_ENABLED !== "true") throw new Error("WeChat push/callback is disabled");
    const key = `wechat-callback-test:${randomUUID()}`;
    const at = new Date();
    const result = await deliverContent({ subjectKind: "operation", subjectId: "wechat-callback-verification", dedupeKey: key, contentAt: at, card: {},
      targetKind: "wechat_template", targetKey: "wechat-personal", wechat: briefWechat({ template: "urgent", title: "微信查询与回执测试",
        summary: "功能验证，不是新闻；可回复状态", source: "个人热点后台", time: at.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 16),
        url: new URL("/daily/ai/latest", process.env.DAILY_PUBLIC_BASE_URL).href }) });
    if (result[0]?.status !== "sent") throw new Error("WeChat did not definitively accept the test; it is not retried");
    for (let i = 0; i < 11; i++) {
      const [delivery] = await sql`SELECT status,wechat_delivery_status FROM deliveries WHERE target_key='wechat-personal' AND dedupe_key=${key}`;
      if (delivery?.wechat_delivery_status) {
        console.log(JSON.stringify({ apiAccepted: true, platformDelivery: delivery.wechat_delivery_status, readConfirmed: false }));
        if (delivery.wechat_delivery_status !== "success") process.exitCode = 1;
        break;
      }
      if (i === 10) { console.log(JSON.stringify({ apiAccepted: true, platformDelivery: "not_yet_received", readConfirmed: false })); process.exitCode = 1; }
      else await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
} catch { console.error("微信回调验证未完成；不自动重发，未输出任何凭据。可查看本地 status 及控制台接口配置。"); process.exitCode = 1; }
finally { await closeDb(); }
