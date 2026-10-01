-- Keep API acceptance distinct from the official account's subsequent delivery result.
ALTER TABLE deliveries ADD COLUMN wechat_message_id text;
ALTER TABLE deliveries ADD COLUMN wechat_app_id text;
ALTER TABLE deliveries ADD COLUMN wechat_delivery_status text
  CHECK (wechat_delivery_status IN ('success', 'user_block', 'system_failed'));
ALTER TABLE deliveries ADD COLUMN wechat_delivery_at timestamptz;
CREATE INDEX deliveries_wechat_message_idx ON deliveries (wechat_app_id, wechat_message_id)
  WHERE wechat_message_id IS NOT NULL;

CREATE TABLE wechat_delivery_events (
  app_id text NOT NULL,
  message_id text NOT NULL,
  recipient_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'user_block', 'system_failed')),
  provider_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, message_id)
);
