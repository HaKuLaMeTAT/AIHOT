// Process state alone does not prove the worker is still making progress.
export interface HealthInput {
  services: Record<string, { active: string }>;
  database: boolean;
  api: boolean;
  heartbeat: string | null;
  now: number;
}

export function runtimeIssues(input: HealthInput): string[] {
  const issues: string[] = [];
  for (const [unit, label] of Object.entries({
    "news-db.service": "数据库", "news-api.service": "API", "news-worker.service": "采集与分析",
    "news-backup.timer": "备份定时器", "news-capacity.timer": "容量定时器", "news-logrotate.timer": "日志轮换定时器",
  })) {
    if (input.services[unit]?.active !== "active") issues.push(`${label}未运行`);
  }
  if (!input.database) issues.push("无法读取数据库状态");
  if (!input.api) issues.push("API 健康检查未通过");
  if (input.database) {
    const at = Date.parse(input.heartbeat ?? "");
    if (!Number.isFinite(at) || input.now - at > 180_000 || at - input.now > 60_000) issues.push("worker 心跳缺失或过期（启动后可稍后刷新）");
  }
  return issues;
}
