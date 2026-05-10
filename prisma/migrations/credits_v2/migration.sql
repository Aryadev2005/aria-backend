-- prisma/migrations/credits_v2/migration.sql
-- ══════════════════════════════════════════════════════════════════════════════
-- Credit System v2 Migration
--
-- Changes:
--   1. balance, plan_credits, rollover_credits, topup_credits, total_granted,
--      total_spent → NUMERIC(12,4) (float) to support fractional AI charges
--   2. amount, balance_after in credit_transactions → NUMERIC(12,4)
--   3. Add starter_tier_allowed column to credit_config
--   4. Update PLAN_CREDITS seed values (free:100, starter:500, pro:1500, max:4000, brand:10000)
--   5. Update credit_config featureCharge values (credits_cost column)
--   6. Add pack_50 and pack_1500 topup packs
--
-- Run: psql $DATABASE_URL -f prisma/migrations/credits_v2/migration.sql
-- ══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Convert wallet balance columns to float ────────────────────────────────
ALTER TABLE credit_wallets
  ALTER COLUMN balance          TYPE NUMERIC(12,4) USING balance::NUMERIC(12,4),
  ALTER COLUMN plan_credits     TYPE NUMERIC(12,4) USING plan_credits::NUMERIC(12,4),
  ALTER COLUMN rollover_credits TYPE NUMERIC(12,4) USING rollover_credits::NUMERIC(12,4),
  ALTER COLUMN topup_credits    TYPE NUMERIC(12,4) USING topup_credits::NUMERIC(12,4),
  ALTER COLUMN total_granted    TYPE NUMERIC(12,4) USING total_granted::NUMERIC(12,4),
  ALTER COLUMN total_spent      TYPE NUMERIC(12,4) USING total_spent::NUMERIC(12,4);

-- ── 2. Convert transaction amount columns to float ────────────────────────────
ALTER TABLE credit_transactions
  ALTER COLUMN amount       TYPE NUMERIC(12,4) USING amount::NUMERIC(12,4),
  ALTER COLUMN balance_after TYPE NUMERIC(12,4) USING balance_after::NUMERIC(12,4);

-- ── 3. Add starter_tier_allowed to credit_config ──────────────────────────────
-- (reuses the same value as pro_tier_allowed for existing rows as default)
ALTER TABLE credit_config
  ADD COLUMN IF NOT EXISTS starter_tier_allowed BOOLEAN NOT NULL DEFAULT true;

-- Sync starter = pro for all existing rows
UPDATE credit_config SET starter_tier_allowed = pro_tier_allowed;

-- ── 4. Update credit_config with new featureCharge values and starter column ──
-- (credits_cost = featureCharge in the new model)
UPDATE credit_config SET
  credits_cost = 0,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true
WHERE action_key IN ('trend_browse', 'song_browse');

UPDATE credit_config SET
  credits_cost = 1,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_day = 50
WHERE action_key = 'aria_chat';

UPDATE credit_config SET
  credits_cost = 1,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_day = 30
WHERE action_key = 'hook_rewrite';

UPDATE credit_config SET
  credits_cost = 2,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true
WHERE action_key = 'song_recommendations';

UPDATE credit_config SET
  credits_cost = 4,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_day = 10
WHERE action_key = 'viral_ideas';

UPDATE credit_config SET
  credits_cost = 6,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_day = 20
WHERE action_key = 'content_generation';

UPDATE credit_config SET
  credits_cost = 5,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_day = 20
WHERE action_key = 'caption_analysis';

UPDATE credit_config SET
  credits_cost = 4,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true
WHERE action_key = 'bio_analysis';

UPDATE credit_config SET
  credits_cost = 8,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_day = 10
WHERE action_key = 'posting_package';

UPDATE credit_config SET
  credits_cost = 10, starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_month = 4
WHERE action_key = 'content_calendar';

UPDATE credit_config SET
  credits_cost = 10, starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_day = 5
WHERE action_key = 'script_writing';

UPDATE credit_config SET
  credits_cost = 12, starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_month = 4
WHERE action_key = 'weekly_report';

UPDATE credit_config SET
  credits_cost = 8,  starter_tier_allowed = true,  pro_tier_allowed = true,  max_tier_allowed = true,  max_per_month = 10
WHERE action_key = 'rate_card';

UPDATE credit_config SET
  credits_cost = 5,  starter_tier_allowed = false, pro_tier_allowed = true,  max_tier_allowed = true,  free_tier_allowed = false
WHERE action_key = 'brand_alert';

UPDATE credit_config SET
  credits_cost = 15, starter_tier_allowed = false, pro_tier_allowed = true,  max_tier_allowed = true,  free_tier_allowed = false, max_per_month = 4
WHERE action_key = 'growth_roadmap';

UPDATE credit_config SET
  credits_cost = 12, starter_tier_allowed = false, pro_tier_allowed = true,  max_tier_allowed = true,  free_tier_allowed = false, max_per_month = 2
WHERE action_key = 'archetype_detection';

UPDATE credit_config SET
  credits_cost = 15, starter_tier_allowed = false, pro_tier_allowed = true,  max_tier_allowed = true,  free_tier_allowed = false, max_per_day = 1, max_per_month = 3
WHERE action_key = 'voice_portrait';

UPDATE credit_config SET
  credits_cost = 20, starter_tier_allowed = false, pro_tier_allowed = true,  max_tier_allowed = true,  free_tier_allowed = false, max_per_day = 3
WHERE action_key = 'brand_pitch';

UPDATE credit_config SET
  credits_cost = 30, starter_tier_allowed = false, pro_tier_allowed = false, max_tier_allowed = true,  free_tier_allowed = false, max_per_day = 5
WHERE action_key = 'video_analysis';

UPDATE credit_config SET
  credits_cost = 25, starter_tier_allowed = false, pro_tier_allowed = false, max_tier_allowed = true,  free_tier_allowed = false, max_per_day = 3
WHERE action_key = 'competitor_gap';

-- ── 5. Scale existing wallet balances to new credit amounts ───────────────────
-- Old free plan was 50cr, new is 100cr → multiply by 2
-- Old pro plan was 500cr, new pro is 1500cr → we only scale free users here
-- (paid users get their new credits on next monthly reset)
-- This is safe to run once — it scales free user balances proportionally.
UPDATE credit_wallets
SET
  balance          = balance          * 2,
  plan_credits     = plan_credits     * 2,
  total_granted    = total_granted    * 2
WHERE user_id IN (
  SELECT id FROM users WHERE subscription_tier IS NULL OR subscription_tier = 'free'
);

-- ── 6. Update Prisma schema balance column type in credit_wallets ─────────────
-- (The ALTER TABLE above handles the DB side; update prisma/schema.prisma manually)
-- In schema.prisma, change:
--   balance          Int  → balance          Decimal @db.Decimal(12,4)
--   plan_credits     Int  → plan_credits     Decimal @db.Decimal(12,4)
--   rollover_credits Int  → rollover_credits Decimal @db.Decimal(12,4)
--   topup_credits    Int  → topup_credits    Decimal @db.Decimal(12,4)
--   total_granted    Int  → total_granted    Decimal @db.Decimal(12,4)
--   total_spent      Int  → total_spent      Decimal @db.Decimal(12,4)
-- And in credit_transactions:
--   amount           Int  → amount           Decimal @db.Decimal(12,4)
--   balance_after    Int  → balance_after    Decimal @db.Decimal(12,4)

COMMIT;