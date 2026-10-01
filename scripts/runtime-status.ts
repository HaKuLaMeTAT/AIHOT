// Private operational summary: no prompts, provider responses or credentials are printed.
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runtimeIssues } from "./runtime-health.ts";
import { announcementUsage } from "@aihot/backend/sources/stock";

const json = process.argv.includes("--json");
const now = Date.now();
const stamp = (v: Date | string | number | null | undefined) => v == null ? "暂无记录" : new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const size = (v: number | undefined) => v == null ? "未知" : v < 1024 ** 3 ? `${(v / 1024 ** 2).toFixed(0)} MiB` : `${(v / 1024 ** 3).toFixed(2)} GiB`;
const services: Record<string, { active: string; sub: string }> = {};
let memory: Record<string, number | undefined> = {};
try {
  const out = execFileSync("systemctl", ["--user", "show", "news-db.service", "news-api.service", "news-worker.service", "news-backup.timer", "news-capacity.timer", "news-logrotate.timer", "-p", "Id", "-p", "ActiveState", "-p", "SubState"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  for (const section of out.trim().split(/\n\n/)) {
    const fields = Object.fromEntries(section.split("\n").map((line) => line.split("=")));
    services[fields.Id] = { active: fields.ActiveState, sub: fields.SubState };
  }
  const outMemory = execFileSync("systemctl", ["--user", "show", "news-runtime.slice", "-p", "MemoryCurrent", "-p", "MemoryPeak", "-p", "MemoryHigh", "-p", "MemoryMax"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  memory = Object.fromEntries(outMemory.trim().split("\n").map((line) => { const [k, v] = line.split("="); return [k, /^\d+$/.test(v) ? Number(v) : undefined]; }));
} catch { /* Missing systemd is reported as unavailable, never healthy. */ }
const api = await fetch("http://127.0.0.1:3001/api/health", { signal: AbortSignal.timeout(5000) })
  .then(async (r) => r.ok && (await r.json() as { ok?: boolean; db?: string }).ok === true, () => false).catch(() => false);
const operations = await readFile(path.join(config.dataDir, "operations/runtime-state.json"), "utf8")
  .then((s) => JSON.parse(s) as { backup?: { at: number }; checked_at?: number; runtime_bytes?: number; size_checked_at?: number; disk_free_bytes?: number; alerts?: Record<string, unknown> }, () => null).catch(() => null);
try {
  await sql`SET statement_timeout = '5s'`;
  const sources = await sql`SELECT enabled, count(*)::int AS count FROM sources GROUP BY enabled`;
  const articles = await sql`SELECT processing_state, count(*)::int AS count FROM articles GROUP BY processing_state`;
  const budgets = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service IN ('codex','llm')`;
  const calls = await sql`SELECT service, status, count(*)::int AS count FROM receipt_attempts WHERE started_at > now() - interval '1 day' GROUP BY service,status`;
  const channelCalls = process.env.MODEL_CHANNEL_BUDGETS_ENABLED === "true" ? await sql`SELECT service,budget_channel,
    count(*) FILTER(WHERE started_at>now()-interval '1 minute')::int AS minute,
    count(*) FILTER(WHERE started_at>now()-interval '1 hour')::int AS hour,count(*)::int AS day
    FROM receipt_attempts WHERE origin='live' AND started_at>now()-interval '1 day' AND budget_channel IS NOT NULL
    GROUP BY service,budget_channel` : [];
  const analysisQueues = await sql`SELECT name,state,count(*)::int AS count FROM pgboss.job
    WHERE name IN ('content.analyze','content.analyze.ai','content.analyze.stock') AND state IN ('created','retry','active') GROUP BY name,state`;
  const notify = await sql`SELECT key, kind, enabled FROM notify_targets WHERE kind='wechat_template'`;
  const failures = await sql`SELECT id,name,fail_count FROM sources WHERE fail_count>0 ORDER BY id`;
  const stockIndexes = await sql`SELECT source_id,day,count(*)::int AS indexed,count(*) FILTER (WHERE NOT baseline)::int AS live,
    count(*) FILTER (WHERE state='queued')::int AS queued,count(*) FILTER (WHERE state='failed')::int AS failed FROM stock_announcements
    WHERE day >= to_char(now() AT TIME ZONE 'Asia/Shanghai' - interval '1 day','YYYY-MM-DD') GROUP BY source_id,day ORDER BY day,source_id`;
  const stockScans = await sql`SELECT source_id,day,next_page,expected_count,complete FROM stock_announcement_scans
    WHERE day >= to_char(now() AT TIME ZONE 'Asia/Shanghai' - interval '1 day','YYYY-MM-DD') ORDER BY day,source_id`;
  const stockDocumentUsage = await announcementUsage(new Date(now));
  const stockEvents = await sql`SELECT day,count(*)::int AS observations FROM stock_market_events
    WHERE day=to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') GROUP BY day`;
  const [heartbeat] = await sql<{ at: string }[]>`SELECT value->>'at' AS at FROM settings WHERE key='heartbeat.worker'`;
  const [lastFetch] = await sql<{ at: Date }[]>`SELECT max(finished_at) AS at FROM fetch_runs WHERE status='ok'`;
  const [lastAnalysis] = await sql<{ at: Date }[]>`SELECT max(created_at) AS at FROM analyses`;
  const recentDeliveries = await sql<{ subject_kind: string; status: string; wechat_delivery_status: string | null; at: Date }[]>`SELECT subject_kind,status,wechat_delivery_status,created_at AS at FROM deliveries WHERE target_key='wechat-personal' ORDER BY id DESC LIMIT 5`;
  const issues = runtimeIssues({ services, database: true, api, heartbeat: heartbeat?.at ?? null, now });
  if (failures.length) issues.push(`${failures.length} 个信源最近采集失败`);
  if (!operations?.checked_at || now / 1000 - operations.checked_at > 7200) issues.push("容量检查记录缺失或超过两小时");
  if (!operations?.backup?.at || now / 1000 - operations.backup.at > 36 * 3600) issues.push("备份记录缺失或超过 36 小时");
  if (Object.keys(operations?.alerts ?? {}).length) issues.push(`运行告警：${Object.keys(operations!.alerts!).join("、")}`);
  if (recentDeliveries.some((d) => ["failed", "unknown"].includes(d.status))) issues.push("近期微信投递存在失败或结果未知，需检查记录");
  if (recentDeliveries.some((d) => d.wechat_delivery_status && d.wechat_delivery_status !== "success")) issues.push("微信平台回执报告投递失败");
  if (process.env.WECHAT_DAILY_MODE === "page" && !process.env.DAILY_PUBLIC_BASE_URL) issues.push("正式日报阅读地址待配置，日报暂不发送");
  if (process.env.WECHAT_SEPARATE_TEMPLATES === "true" && ["WECHAT_AI_DAILY_TEMPLATE_ID", "WECHAT_STOCK_DAILY_TEMPLATE_ID", "WECHAT_URGENT_TEMPLATE_ID"].some((k) => !process.env[k])) issues.push("三个业务模板尚未配置完整，相关推送等待接入");
  if (json) console.log(JSON.stringify({ services, memory, api, heartbeat: heartbeat?.at, operations, issues, recentDeliveries, model: { provider: process.env.LLM_PROVIDER || "api", name: process.env.LLM_PROVIDER === "codex" ? process.env.CODEX_MODEL : process.env.LLM_MODEL }, collectionEnabled: process.env.COLLECT_ENABLED !== "false", modelCallsEnabled: process.env.MODEL_CALLS_ENABLED !== "false", sources, articles, budgets, calls, channelCalls, analysisQueues, notify, failures, stockIndexes, stockScans, stockEvents, stockDocumentUsage }, null, 2));
  else {
    console.log(`个人热点服务状态 · ${stamp(now)}`);
    console.log(`总体：${issues.length ? "需要关注" : "运行正常（当前检查通过）"}`);
    for (const issue of issues) console.log(`  · ${issue}`);
    const labels: Record<string, string> = { "news-db.service": "数据库", "news-api.service": "API", "news-worker.service": "采集与分析", "news-backup.timer": "自动备份", "news-capacity.timer": "容量检查", "news-logrotate.timer": "日志轮换" };
    console.log(`服务：${Object.entries(labels).map(([unit, label]) => `${label}=${services[unit]?.active === "active" ? "运行" : "未运行"}`).join("；")}`);
    console.log(`健康：API=${api ? "正常" : "异常"}；worker 最近心跳 ${stamp(heartbeat?.at)}`);
    console.log(`内存：当前 ${size(memory.MemoryCurrent)}；峰值 ${size(memory.MemoryPeak)}；上限 ${size(memory.MemoryMax)}`);
    console.log(`模型：${process.env.LLM_PROVIDER === "codex" ? `Codex / ${process.env.CODEX_MODEL}` : `API / ${process.env.LLM_MODEL}`}；DeepSeek 备用需手动切换`);
    console.log(`采集：${sources.filter((s) => s.enabled).reduce((n, s) => n + s.count, 0)} 个启用信源；开关=${process.env.COLLECT_ENABLED !== "false" ? "开" : "关"}；最近成功 ${stamp(lastFetch?.at)}`);
    console.log(`分析：${articles.map((a) => `${a.processing_state}=${a.count}`).join("；")}；模型开关=${config.modelCallsEnabled ? "开" : "关"}；最近完成 ${stamp(lastAnalysis?.at)}（排队数量不等于故障）`);
    if (process.env.ANALYZE_CHANNELS_ENABLED === "true") console.log(`分析通道：AI、股市各并发 1；队列 ${analysisQueues.map((q) => `${q.name}/${q.state}=${q.count}`).join("；") || "暂无等待任务"}`);
    if (process.env.MODEL_CHANNEL_BUDGETS_ENABLED === "true") for (const budget of budgets) {
      for (const channel of ["ai", "stock"]) {
        const used = channelCalls.find((c) => c.service === budget.service && c.budget_channel === channel);
        console.log(`模型份额 ${budget.service}/${channel}：分钟 ${used?.minute ?? 0}/${Math.floor(budget.per_minute / 2)}；小时 ${used?.hour ?? 0}/${Math.floor(budget.per_hour / 2)}；滚动 24h ${used?.day ?? 0}/${Math.floor(budget.per_day / 2)}`);
      }
    }
    const enabled = config.wechatPushEnabled && notify.some((t) => t.enabled);
    console.log(`微信：${enabled ? "已开启" : "未开启"}；${process.env.PERSONAL_DAILY_TWICE_ENABLED === "true" ? "AI 与股市均为 08:00 早报、20:00 晚报" : "AI 每天 08:00、股市每天 18:00"}（北京时间，无新增精选也发提示）`);
    console.log(`公告阅读：本窗口 ${stockDocumentUsage.windowUsed}/${stockDocumentUsage.windowLimit}；滚动 24h ${stockDocumentUsage.rollingUsed}/${stockDocumentUsage.rollingLimit}（含失败尝试）`);
    if (process.env.WECHAT_DAILY_MODE === "page") console.log(`日报格式：概览卡片＋完整阅读页；访问地址=${process.env.DAILY_PUBLIC_BASE_URL ? "已填写（手机可达性仍需验证）" : "待配置，日报暂不发送"}`);
    if (process.env.WECHAT_SEPARATE_TEMPLATES === "true") console.log(`分用途模板：AI 日报=${process.env.WECHAT_AI_DAILY_TEMPLATE_ID ? "已填" : "待填"}；股市日报=${process.env.WECHAT_STOCK_DAILY_TEMPLATE_ID ? "已填" : "待填"}；即时/运行提醒=${process.env.WECHAT_URGENT_TEMPLATE_ID ? "已填" : "待填"}`);
    const last = recentDeliveries[0];
    const status: Record<string, string> = { sent: "接口已接受，手机送达未自动确认", failed: "失败", unknown: "结果未知", skipped: "跳过", pending: "待发送", sending: "发送中" };
    const receipt = last?.wechat_delivery_status === "success" ? "平台确认投递成功（非已读）" : last?.wechat_delivery_status ? "平台报告投递失败" : last ? status[last.status] ?? last.status : "";
    console.log(`最近业务推送：${last ? `${stamp(last.at)} / ${last.subject_kind} / ${receipt}` : "暂无记录（连接测试不计入业务推送）"}`);
    console.log(`微信查询与回执回调：${process.env.WECHAT_CALLBACK_ENABLED === "true" ? "接口已开启，控制台配置及实际回执需验证" : "尚未开启"}`);
    console.log(`备份：${operations?.backup?.at ? stamp(operations.backup.at * 1000) : "暂无记录"}`);
    console.log(`容量：D 盘剩余 ${size(operations?.disk_free_bytes)}；本项目数据 ${size(operations?.runtime_bytes)}（统计于 ${stamp(operations?.size_checked_at ? operations.size_checked_at * 1000 : null)}）`);
    for (const scan of stockScans.filter((s) => !s.complete)) console.log(`公告补齐：${scan.source_id} / ${scan.day} / 正在分页至第 ${scan.next_page} 页`);
    console.log("查看命令只检查状态，不触发采集、模型调用或微信发送。详尽记录：status --json");
  }
} catch {
  const issues = runtimeIssues({ services, database: false, api, heartbeat: null, now });
  if (json) console.log(JSON.stringify({ services, memory, api, issues }));
  else console.log(`个人热点服务状态 · ${stamp(now)}\n总体：需要关注\n${issues.map((s) => `  · ${s}`).join("\n")}\n未取得业务数据；未输出数据库错误或凭据。`);
  process.exitCode = 1;
} finally { await closeDb(); }
