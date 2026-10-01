-- Direct official-account template notifications, disabled until explicitly configured.
ALTER TABLE notify_targets DROP CONSTRAINT notify_targets_kind_check;
ALTER TABLE notify_targets ADD CONSTRAINT notify_targets_kind_check
  CHECK (kind IN ('feishu_webhook', 'feishu_chat', 'log', 'wechat_template'));

INSERT INTO notify_targets (key, purpose, kind, enabled, note)
VALUES ('wechat-personal', 'content', 'wechat_template', false, '个人微信模板消息')
ON CONFLICT (key) DO NOTHING;
