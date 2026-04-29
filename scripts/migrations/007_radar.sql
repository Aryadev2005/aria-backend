-- scripts/migrations/005_radar.sql
-- Migration: 005_radar
-- radar_snapshots: caches ARIA niche intelligence per niche+platform combo (6hr TTL)

CREATE TABLE IF NOT EXISTS radar_snapshots (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  niche            TEXT        NOT NULL,
  platform         TEXT        NOT NULL,
  intelligence_data JSONB      NOT NULL,
  generated_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at       TIMESTAMPTZ DEFAULT NOW() + INTERVAL '6 hours'
);

CREATE INDEX IF NOT EXISTS idx_radar_niche_platform
  ON radar_snapshots (niche, platform);

CREATE INDEX IF NOT EXISTS idx_radar_expires
  ON radar_snapshots (expires_at);

-- Auto-cleanup: delete expired snapshots older than 24h
-- (run manually or via cron — BullMQ worker handles refresh)
-- DELETE FROM radar_snapshots WHERE expires_at < NOW() - INTERVAL '24 hours';
