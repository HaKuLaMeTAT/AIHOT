import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeIssues } from "../scripts/runtime-health.ts";

const now = Date.parse("2026-09-30T12:00:00Z");
const services = Object.fromEntries([
  "news-db.service", "news-api.service", "news-worker.service", "news-backup.timer", "news-capacity.timer", "news-logrotate.timer",
].map((unit) => [unit, { active: "active" }]));
const good = { services, database: true, api: true, heartbeat: new Date(now - 30_000).toISOString(), now };
test("an active worker with a stale heartbeat is not reported as healthy", () => {
  assert.deepEqual(runtimeIssues(good), []);
  assert.ok(runtimeIssues({ ...good, heartbeat: new Date(now - 240_000).toISOString() }).some((s) => s.includes("心跳")));
  assert.ok(runtimeIssues({ ...good, heartbeat: null }).some((s) => s.includes("心跳")));
});
test("stopped services and unavailable checks remain visible without a database", () => {
  const issues = runtimeIssues({ ...good, services: {}, database: false, api: false });
  assert.ok(issues.some((s) => s.includes("数据库未运行")));
  assert.ok(issues.some((s) => s.includes("备份定时器")));
  assert.ok(issues.some((s) => s.includes("无法读取数据库")));
  assert.ok(issues.some((s) => s.includes("API 健康")));
});
