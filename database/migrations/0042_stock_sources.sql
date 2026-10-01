-- Lightweight source indexes are not articles and never automatically enter model processing.
CREATE TABLE stock_announcement_scans (
  source_id text NOT NULL REFERENCES sources(id),
  day text NOT NULL,
  next_page integer NOT NULL DEFAULT 1,
  expected_count integer NOT NULL DEFAULT 0,
  complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, day)
);
CREATE TABLE stock_announcements (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources(id),
  day text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  title text NOT NULL,
  pdf_url text NOT NULL,
  published_at timestamptz NOT NULL,
  baseline boolean NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'indexed' CHECK (state IN ('indexed','preparing','queued','failed')),
  article_id text REFERENCES articles(id) ON DELETE SET NULL,
  error text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_announcements_dispatch_idx ON stock_announcements (priority DESC, published_at DESC)
  WHERE state = 'indexed' AND NOT baseline AND priority > 0;
CREATE INDEX stock_announcements_day_idx ON stock_announcements (source_id, day);
CREATE INDEX stock_announcements_promoted_idx ON stock_announcements (promoted_at) WHERE promoted_at IS NOT NULL;

CREATE TABLE stock_market_events (
  day text NOT NULL,
  event_key text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  info text NOT NULL,
  baseline boolean NOT NULL,
  PRIMARY KEY (day, event_key)
);
CREATE TABLE stock_market_boards (
  day text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  change_pct numeric NOT NULL,
  event_count integer NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (day, code)
);
CREATE TABLE stock_market_reports (
  day text PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
