-- scripts/migrations/007_subscription_columns.sql
-- Migration: 007_subscription_columns
-- Add RevenueCat subscription tracking columns to users table
-- Run: psql $DATABASE_URL -f scripts/migrations/007_subscription_columns.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_product_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subscription_store        TEXT; -- 'APP_STORE' | 'PLAY_STORE'

-- Index for webhook lookups by Firebase UID (fast upserts)
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);

-- Verify the migration
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'users'
  AND column_name IN (
    'is_pro',
    'subscription_tier',
    'subscription_product_id',
    'subscription_expires_at',
    'subscription_store'
  )
ORDER BY column_name;
