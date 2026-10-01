-- Attempt limits count local CLI calls as well as HTTP calls; account credits are shared with Codex.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
VALUES ('codex', 6, 60, 300, 'Codex CLI 初始调用上限；与当前账户共享额度，非金额上限')
ON CONFLICT (service) DO NOTHING;
