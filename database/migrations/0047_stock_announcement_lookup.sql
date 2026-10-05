-- Security lookup stays independent of the editorial dispatch index.
CREATE INDEX stock_announcements_lookup_idx
  ON stock_announcements (source_id, code, published_at DESC, id DESC);
