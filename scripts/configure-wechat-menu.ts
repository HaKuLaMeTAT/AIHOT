import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, credential } from "@aihot/backend/config";
import { configureWechatMenu, wechatMenu } from "@aihot/backend/notify/wechat-menu";

const base = process.env.DAILY_PUBLIC_BASE_URL ?? "";
try {
  if (!process.argv.includes("--apply")) console.log(JSON.stringify(wechatMenu(base), null, 2));
  else {
    const appId = credential("integrations", "WECHAT_APP_ID"), secret = credential("integrations", "WECHAT_APP_SECRET");
    if (!appId || !secret) throw new Error("WeChat credentials are missing");
    await configureWechatMenu(appId, secret, base, async previous => {
      const dir = path.join(config.dataDir, "operations"); await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(dir, `wechat-menu-before-${Date.now()}.json`), JSON.stringify(previous), { flag: "wx", mode: 0o600 });
    });
    console.log("公众号菜单已保存并通过接口复查。未发送消息；微信客户端可能需要重新进入或稍后刷新。");
  }
} catch (error) { console.error(error instanceof Error ? error.message : "Menu setup failed"); process.exitCode = 1; }
