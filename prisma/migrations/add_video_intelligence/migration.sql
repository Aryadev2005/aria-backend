-- ── Video Intelligence Engine: Full Schema Migration ──────────────────────────────

-- Extended Video DNA analyses with heatmap + intelligence data
ALTER TABLE video_dna_analyses 
  ADD COLUMN IF NOT EXISTS heatmap_data       JSONB    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS streams_data       JSONB    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS shorts_timestamps  JSONB    DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS competitor_gap     JSONB    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS analysis_version   TEXT     DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS processing_ms      INTEGER  DEFAULT 0;

-- Competitor analysis cache
CREATE TABLE IF NOT EXISTS competitor_analyses (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  niche           TEXT        NOT NULL,
  video_ids       TEXT[]      NOT NULL DEFAULT '{}',
  gap_report      JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_competitor_analyses_user   ON competitor_analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_competitor_analyses_niche  ON competitor_analyses(niche);
CREATE INDEX IF NOT EXISTS idx_competitor_analyses_expiry ON competitor_analyses(expires_at);

-- Heatmap scrape cache
CREATE TABLE IF NOT EXISTS video_heatmaps (
  video_id        TEXT        PRIMARY KEY,
  heatmap_data    JSONB       NOT NULL DEFAULT '{}',
  scraped_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ DEFAULT NOW() + INTERVAL '6 hours'
);

CREATE INDEX IF NOT EXISTS idx_video_heatmaps_expiry ON video_heatmaps(expires_at);
