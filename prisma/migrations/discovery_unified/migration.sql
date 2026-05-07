-- ══════════════════════════════════════════════════════════════════════════════
-- Unified Discovery System Migration
-- Adds: scrape_health, trend_interactions, platform_velocity column on live_trends
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Scrape Health Monitor ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scrape_health (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                TEXT NOT NULL,          -- 'youtube' | 'reddit' | 'tiktok' | 'pinterest' | 'google' | 'instagram'
  last_run_at           TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_result_count     INTEGER DEFAULT 0,
  consecutive_failures  INTEGER DEFAULT 0,
  last_error            TEXT,
  status                TEXT DEFAULT 'idle',    -- 'idle' | 'running' | 'ok' | 'failed' | 'stale'
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT scrape_health_source_key UNIQUE (source)
);

-- Seed all sources
INSERT INTO scrape_health (source, status) VALUES
  ('youtube',   'idle'),
  ('reddit',    'idle'),
  ('tiktok',    'idle'),
  ('pinterest', 'idle'),
  ('google',    'idle'),
  ('instagram', 'idle')
ON CONFLICT (source) DO NOTHING;

-- ── 2. Trend Interactions (Feedback Loop) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS trend_interactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trend_id    UUID REFERENCES live_trends(id) ON DELETE SET NULL,
  trend_title TEXT NOT NULL,
  source      TEXT,
  niche       TEXT,
  action      TEXT NOT NULL,   -- 'viewed' | 'saved' | 'created' | 'dismissed'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trend_interactions_user    ON trend_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_trend_interactions_source  ON trend_interactions(source, niche);
CREATE INDEX IF NOT EXISTS idx_trend_interactions_created ON trend_interactions(created_at DESC);

-- ── 3. Add platform_raw_score and content_format to live_trends ───────────────
ALTER TABLE live_trends
  ADD COLUMN IF NOT EXISTS platform_raw_score DECIMAL(10,4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS content_format     TEXT DEFAULT 'unknown',  -- 'short_form' | 'long_form' | 'article' | 'post' | 'pin' | 'unknown'
  ADD COLUMN IF NOT EXISTS override_reason    TEXT,                    -- why it bypassed velocity filter
  ADD COLUMN IF NOT EXISTS is_override        BOOLEAN DEFAULT FALSE;
