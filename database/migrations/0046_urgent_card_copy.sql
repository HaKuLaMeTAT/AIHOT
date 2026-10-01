-- Compact notification copy is produced by the existing, receipted urgency decision.
ALTER TABLE notification_urgency ADD COLUMN card_title text NOT NULL DEFAULT '';
ALTER TABLE notification_urgency ADD COLUMN card_summary text NOT NULL DEFAULT '';
