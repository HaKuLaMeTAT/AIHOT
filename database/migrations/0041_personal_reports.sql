-- Private notification editions, separate from the public site's combined report archive.
CREATE TABLE notification_reports (
  channel text NOT NULL CHECK (channel IN ('ai', 'stock')),
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, key)
);

CREATE TABLE notification_urgency (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  input_key text NOT NULL,
  urgent boolean NOT NULL,
  reason text NOT NULL,
  evidence text NOT NULL,
  receipt_id bigint REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, input_key)
);
