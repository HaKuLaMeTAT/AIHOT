-- Attribution changes no receipt identity: already received responses remain reusable.
ALTER TABLE receipt_attempts ADD COLUMN budget_channel text CHECK (budget_channel IN ('ai','stock'));
CREATE INDEX receipt_attempts_channel_time_idx ON receipt_attempts (service,budget_channel,started_at) WHERE origin='live';
