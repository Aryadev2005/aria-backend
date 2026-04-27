-- Migration: 003_aria_columns
-- Add ARIA columns and new tables for live trends & songs

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS archetype TEXT,
  ADD COLUMN IF NOT EXISTS archetype_label TEXT,
  ADD COLUMN IF NOT EXISTS archetype_confidence INTEGER,
  ADD COLUMN IF NOT EXISTS growth_stage TEXT DEFAULT 'DISCOVERY',
  ADD COLUMN IF NOT EXISTS tone_profile TEXT,
  ADD COLUMN IF NOT EXISTS health_score INTEGER,
  ADD COLUMN IF NOT EXISTS instagram_handle TEXT,
  ADD COLUMN IF NOT EXISTS youtube_handle TEXT,
  ADD COLUMN IF NOT EXISTS scraped_summary JSONB,
  ADD COLUMN IF NOT EXISTS scraped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS engagement_rate DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS creator_intent TEXT DEFAULT 'grow_organically',
  ADD COLUMN IF NOT EXISTS aria_last_analysis JSONB,
  ADD COLUMN IF NOT EXISTS aria_analyzed_at TIMESTAMPTZ;

-- New table for ARIA feedback loop
CREATE TABLE IF NOT EXISTS aria_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  recommendation_type TEXT NOT NULL,
  recommendation_data JSONB NOT NULL,
  was_helpful BOOLEAN,
  result_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- New table for live trend data (fed by BullMQ workers)
CREATE TABLE IF NOT EXISTS live_trends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  search_volume INTEGER,
  velocity DECIMAL(5,2),
  niche_tags TEXT[],
  platform_tags TEXT[],
  raw_data JSONB,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- New table for live songs (fed by BullMQ workers)
CREATE TABLE IF NOT EXISTS live_songs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  chart_position INTEGER,
  chart_change INTEGER,
  streams_today BIGINT,
  language TEXT,
  raw_data JSONB,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_live_trends_expires ON live_trends(expires_at);
CREATE INDEX IF NOT EXISTS idx_live_trends_niche ON live_trends USING GIN(niche_tags);
CREATE INDEX IF NOT EXISTS idx_live_trends_platform ON live_trends USING GIN(platform_tags);
CREATE INDEX IF NOT EXISTS idx_aria_feedback_user ON aria_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_users_archetype ON users(archetype);
