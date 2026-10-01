-- Keep material identity, hashes, summaries and references after retiring large raw fields.
ALTER TABLE articles ADD COLUMN raw_retired_at timestamptz;
CREATE INDEX articles_retention_idx ON articles (updated_at)
  WHERE raw_retired_at IS NULL AND processing_state IN ('analyzed', 'skipped', 'blocked');
