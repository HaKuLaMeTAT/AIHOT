import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "../db.ts";
import { config } from "../config.ts";
import { listPersonalDailies } from "../publication/personal-daily.ts";
import { dailyEditionLabel } from "@aihot/contracts/personal-daily";
import { beijingDate, beijingTime } from "@aihot/contracts/time";

const time = (date: Date | string | null | undefined) => date ? `${beijingDate(date)} ${beijingTime(date)}` : "暂无记录";

export async function wechatStatus(): Promise<string> {
  let system = "服务状态未取得";
  try {
    const { stdout } = await promisify(execFile)("systemctl", ["--user", "show", "news-db.service", "news-api.service", "news-worker.service", "news-runtime.slice",
      "-p", "Id", "-p", "ActiveState", "-p", "MemoryCurrent", "-p", "MemoryMax"], { encoding: "utf8", timeout: 750, maxBuffer: 8192 });
    const units = stdout.trim().split(/\n\n/).map(s => Object.fromEntries(s.split("\n").map(l => l.split("="))));
    const services = units.filter(u => u.Id !== "news-runtime.slice");
    const slice = units.find(u => u.Id === "news-runtime.slice");
    system = `服务：${services.every(u => u.ActiveState === "active") ? "均在运行" : "需要检查"}`;
    if (slice && /^\d+$/.test(slice.MemoryCurrent)) system += `；内存 ${Math.round(Number(slice.MemoryCurrent) / 1024 ** 2)} MiB`;
  } catch { /* The reply must not contain shell errors or paths. */ }
  return sql.begin(async tx => {
    await tx`SET LOCAL statement_timeout='1200ms'`;
    const [heartbeat] = await tx`SELECT value->>'at' AS at FROM settings WHERE key='heartbeat.worker'`;
    const [sources] = await tx`SELECT count(*) FILTER(WHERE enabled)::int AS enabled,count(*) FILTER(WHERE enabled AND fail_count>0)::int AS failing FROM sources`;
    const [fetch] = await tx`SELECT max(finished_at) AS at FROM fetch_runs WHERE status='ok'`;
    const [analysis] = await tx`SELECT max(created_at) AS at FROM analyses`;
    const queues = await tx`SELECT name,count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state IN('created','retry'))::int AS waiting
      FROM pgboss.job WHERE name IN('content.analyze.ai','content.analyze.stock','content.analyze') AND state IN('created','retry','active') GROUP BY name`;
    const [delivery] = await tx`SELECT status,wechat_delivery_status,created_at FROM deliveries WHERE target_key='wechat-personal' ORDER BY id DESC LIMIT 1`;
    const fresh = heartbeat?.at && Math.abs(Date.now() - Date.parse(heartbeat.at)) <= 180_000;
    const queueText = (channel: string) => { const q = queues.find(q => q.name === `content.analyze.${channel}`); return `${q?.waiting ?? 0} 待处理／${q?.active ?? 0} 正在分析`; };
    const state = delivery?.wechat_delivery_status === "success" ? "微信平台已确认投递（非已读）"
      : delivery?.wechat_delivery_status ? "微信平台报告投递失败"
      : delivery?.status === "sent" ? "接口已接受，等待平台回执"
      : delivery?.status === "unknown" ? "结果未知，不自动重发" : delivery?.status === "failed" ? "发送失败" : "暂无已发送记录";
    return [`个人热点状态 · ${time(new Date())}`, system, `Worker 心跳：${fresh ? "正常" : "缺失或过期"}`,
      `采集：${sources?.enabled ?? 0} 个来源，${sources?.failing ?? 0} 个最近失败；最近成功 ${time(fetch?.at)}`,
      `AI 队列：${queueText("ai")}`, `股市队列：${queueText("stock")}`, `最近分析：${time(analysis?.at)}`,
      `微信推送：${config.wechatPushEnabled ? "已开启" : "未开启"}；最近 ${time(delivery?.created_at)}，${state}`,
      "早报 08:00／晚报 20:00（北京时间，无新增精选不发）。排队数量不等于故障。"].join("\n");
  }) as Promise<string>;
}

export async function answerWechatQuery(command: string): Promise<string> {
  const text = command.trim().toLowerCase();
  if (["状态", "status", "news_status"].includes(text)) return wechatStatus();
  const base = process.env.DAILY_PUBLIC_BASE_URL;
  if (!base || !/^https:\/\/[a-z0-9.-]+\/?$/i.test(base)) return "日报阅读地址尚未配置。";
  const url = (path: string) => new URL(path, base).href;
  if (["历史", "历史日报", "news_history"].includes(text)) return `历史日报\nAI：${url("/daily/ai/history")}\n股市：${url("/daily/stock/history")}`;
  const channel = ["ai", "ai日报", "ai 日报", "人工智能", "news_ai"].includes(text) ? "ai"
    : ["股市", "股票", "股市日报", "stock", "news_stock"].includes(text) ? "stock" : null;
  if (!channel) return "回复 AI 或 股市 查看最新日报；回复 历史 查看归档；回复 状态 查看服务和推送情况。查询只读取已有数据。";
  const [latest] = await listPersonalDailies(channel, new Date(), 1);
  if (!latest) return `${channel === "ai" ? "AI" : "股市"}暂无已生成且可显示的日报。`;
  return `${channel === "ai" ? "AI" : "股市"}${dailyEditionLabel(latest.edition)}${latest.supplement ? " · 补充" : ""} · ${latest.key}\n精选 ${latest.count} 条，截止 ${time(latest.windowEnd)}\n${url(latest.path)}\n这是最近一期已生成内容，不会重新分析或补发通知。`;
}
