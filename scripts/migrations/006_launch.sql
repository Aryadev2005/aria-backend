-- scripts/migrations/006_launch.sql
-- Migration: 006_launch
-- launch_packages: stores generated posting packages per user

CREATE TABLE IF NOT EXISTS launch_packages (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        REFERENCES users(id) ON DELETE CASCADE,
  package_data JSONB       NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_launch_packages_user
  ON launch_packages (user_id, created_at DESC);

-- Verify
SELECT 'launch_packages created' AS status;
