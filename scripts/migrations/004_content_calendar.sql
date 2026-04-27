-- trendai-backend/scripts/migrations/004_content_calendar.sql
-- Run with: psql trendai -f scripts/migrations/004_content_calendar.sql

-- Content calendars table
CREATE TABLE IF NOT EXISTS content_calendars (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,                       -- e.g. "January"
  year         INTEGER NOT NULL,
  calendar_data JSONB NOT NULL,                     -- full ARIA calendar JSON
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, month, year)                      -- one calendar per user per month
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_calendars_user ON content_calendars (user_id);
CREATE INDEX IF NOT EXISTS idx_calendars_user_month ON content_calendars (user_id, month, year);

-- Rate cards table
CREATE TABLE IF NOT EXISTS rate_cards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  rate_data   JSONB NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_cards_user ON rate_cards (user_id);

-- Update analytics event types (add new events)
-- No migration needed — analytics.event is TEXT, accepts any string
-- New events: 'calendar_generated', 'rate_card_generated', 'caption_analysed'

-- Verify
SELECT 'content_calendars created' AS status;
SELECT 'rate_cards created' AS status;
