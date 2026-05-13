-- ══════════════════════════════════════════════════════════════════════════════
-- Add discovery_youtube_raw staging table
-- Brings YouTube into the same raw → normalise pipeline as all other sources
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS discovery_youtube_raw (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id      TEXT        NOT NULL UNIQUE,
  title         TEXT        NOT NULL,
  channel       TEXT        NOT NULL DEFAULT '',
  view_count    BIGINT      DEFAULT 0,
  like_count    BIGINT      DEFAULT 0,
  comment_count BIGINT      DEFAULT 0,
  category_id   TEXT        DEFAULT '0',
  velocity      INT         DEFAULT 0,
  niche_tags    TEXT[]      DEFAULT '{}',
  thumbnail_url TEXT,
  published_at  TIMESTAMPTZ,
  scraped_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  raw_data      JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_youtube_raw_velocity   ON discovery_youtube_raw (velocity DESC);
CREATE INDEX IF NOT EXISTS idx_youtube_raw_views      ON discovery_youtube_raw (view_count DESC);
CREATE INDEX IF NOT EXISTS idx_youtube_raw_scraped    ON discovery_youtube_raw (scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_youtube_raw_expires    ON discovery_youtube_raw (expires_at);
CREATE INDEX IF NOT EXISTS idx_youtube_raw_category   ON discovery_youtube_raw (category_id);
