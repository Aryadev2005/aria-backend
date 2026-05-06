-- Discovery Tables Migration
-- All statements are idempotent (IF NOT EXISTS)

-- Raw TikTok storage — everything scraped globally, no niche filter
CREATE TABLE IF NOT EXISTS discovery_tiktok_raw (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tiktok_id       TEXT        NOT NULL UNIQUE,
  description     TEXT,
  creator_handle  TEXT,
  creator_name    TEXT,
  creator_followers BIGINT    DEFAULT 0,
  views           BIGINT      DEFAULT 0,
  likes           BIGINT      DEFAULT 0,
  comments        BIGINT      DEFAULT 0,
  shares          BIGINT      DEFAULT 0,
  saves           BIGINT      DEFAULT 0,
  engagement_rate DECIMAL(8,6) DEFAULT 0,
  sound_name      TEXT,
  sound_artist    TEXT,
  hashtags        TEXT[]      DEFAULT '{}',
  video_url       TEXT,
  thumbnail_url   TEXT,
  duration        INT         DEFAULT 0,
  scraped_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  raw_data        JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tiktok_raw_views      ON discovery_tiktok_raw (views DESC);
CREATE INDEX IF NOT EXISTS idx_tiktok_raw_engagement ON discovery_tiktok_raw (engagement_rate DESC);
CREATE INDEX IF NOT EXISTS idx_tiktok_raw_scraped    ON discovery_tiktok_raw (scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_tiktok_raw_expires    ON discovery_tiktok_raw (expires_at);
CREATE INDEX IF NOT EXISTS idx_tiktok_raw_hashtags   ON discovery_tiktok_raw USING GIN (hashtags);
CREATE INDEX IF NOT EXISTS idx_tiktok_raw_sound      ON discovery_tiktok_raw (sound_name);

-- Raw Pinterest storage — everything scraped globally
CREATE TABLE IF NOT EXISTS discovery_pinterest_raw (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pinterest_id    TEXT        NOT NULL UNIQUE,
  title           TEXT,
  description     TEXT,
  image_url       TEXT,
  pin_url         TEXT,
  board_name      TEXT,
  board_owner     TEXT,
  saves           BIGINT      DEFAULT 0,
  clicks          BIGINT      DEFAULT 0,
  engagement_rate DECIMAL(8,6) DEFAULT 0,
  hashtags        TEXT[]      DEFAULT '{}',
  pin_type        TEXT        DEFAULT 'standard',
  scraped_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  raw_data        JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pinterest_raw_saves      ON discovery_pinterest_raw (saves DESC);
CREATE INDEX IF NOT EXISTS idx_pinterest_raw_engagement ON discovery_pinterest_raw (engagement_rate DESC);
CREATE INDEX IF NOT EXISTS idx_pinterest_raw_scraped    ON discovery_pinterest_raw (scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_pinterest_raw_expires    ON discovery_pinterest_raw (expires_at);
CREATE INDEX IF NOT EXISTS idx_pinterest_raw_hashtags   ON discovery_pinterest_raw USING GIN (hashtags);

-- Raw Google Trends storage
CREATE TABLE IF NOT EXISTS discovery_google_trends_raw (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword         TEXT        NOT NULL,
  geo             TEXT        DEFAULT 'GLOBAL',
  interest_score  INT         DEFAULT 0,
  related_queries TEXT[]      DEFAULT '{}',
  related_topics  TEXT[]      DEFAULT '{}',
  breakout        BOOLEAN     DEFAULT false,
  trend_date      DATE        DEFAULT CURRENT_DATE,
  scraped_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '3 days'),
  raw_data        JSONB       DEFAULT '{}',
  CONSTRAINT uq_google_trends_keyword_geo_date UNIQUE (keyword, geo, trend_date)
);

CREATE INDEX IF NOT EXISTS idx_gtrends_interest  ON discovery_google_trends_raw (interest_score DESC);
CREATE INDEX IF NOT EXISTS idx_gtrends_breakout  ON discovery_google_trends_raw (breakout);
CREATE INDEX IF NOT EXISTS idx_gtrends_scraped   ON discovery_google_trends_raw (scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_gtrends_expires   ON discovery_google_trends_raw (expires_at);
CREATE INDEX IF NOT EXISTS idx_gtrends_geo       ON discovery_google_trends_raw (geo);

-- Add title_source unique constraint on live_trends for normalisation upserts
-- (only if it doesn't already exist AND table exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'live_trends'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'title_source'
  ) THEN
    ALTER TABLE live_trends ADD CONSTRAINT title_source UNIQUE (title, source);
  END IF;
END $$;
