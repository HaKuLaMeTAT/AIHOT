// Operational messages use the same WeChat target, safety valve and delivery ledger as digests.
import { config } from "../config.ts";
import { deliverContent } from "../notify/deliver.ts";

export interface RuntimeNotice {
  id: string;
  key: string;
  level: "warning" | "critical" | "recovered";
  detail: string;
  at: number;
  previous_id?: string | null;
}

export async function deliverRuntimeNotice(notice: RuntimeNotice, now = new Date()) {
  // Do not consume a dedupe key while a transport is disabled.
  if (!config.wechatPushEnabled) return [];
  const label = { warning: "运行提醒", critical: "运行告警", recovered: "运行恢复" }[notice.level];
  return deliverContent({
    subjectKind: "operation", subjectId: notice.key, dedupeKey: `operation:${notice.id}`,
    // A currently active fault should be visible even when notification was enabled after it began.
    contentAt: now, targetKind: "wechat_template", targetKey: "wechat-personal", card: {},
    wechat: { template: "urgent", title: `个人热点｜${label}`, summary: notice.detail, source: "本地运行监控",
      time: now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) },
  });
}
