-- prisma/migrations/credits/migration.sql
-- Run: psql $DATABASE_URL -f prisma/migrations/credits/migration.sql

-- ── 1. Credit config table — dynamic action→credit mapping ─────────────────
-- This is what makes the system future-proof.
-- Change a model or cost? UPDATE one row. No deploys needed.
CREATE TABLE IF NOT EXISTS credit_config (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  action_key    TEXT        NOT NULL UNIQUE,   -- 'content_generation', 'viral_ideas', etc.
  display_name  TEXT        NOT NULL,
  credits_cost  INTEGER     NOT NULL DEFAULT 10,
  model_mini    TEXT        NOT NULL DEFAULT 'gpt-4o-mini',
  model_heavy   TEXT        NOT NULL DEFAULT 'gpt-4o',
  use_heavy     BOOLEAN     NOT NULL DEFAULT false,  -- which model tier this action uses
  max_per_day   INTEGER,                             -- NULL = unlimited
  max_per_month INTEGER,                             -- NULL = unlimited
  free_tier_allowed BOOLEAN NOT NULL DEFAULT false,
  pro_tier_allowed  BOOLEAN NOT NULL DEFAULT true,
  max_tier_allowed  BOOLEAN NOT NULL DEFAULT true,
  active        BOOLEAN     NOT NULL DEFAULT true,
  notes         TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Credit wallets — one per user ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_wallets (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance             INTEGER     NOT NULL DEFAULT 0,
  total_granted       INTEGER     NOT NULL DEFAULT 0,   -- lifetime credits in
  total_spent         INTEGER     NOT NULL DEFAULT 0,   -- lifetime credits out
  plan_credits        INTEGER     NOT NULL DEFAULT 50,  -- monthly allowance from plan
  rollover_credits    INTEGER     NOT NULL DEFAULT 0,   -- carried from last month
  topup_credits       INTEGER     NOT NULL DEFAULT 0,   -- purchased, never expire
  last_reset_at       TIMESTAMPTZ DEFAULT NOW(),
  next_reset_at       TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. Credit transactions — full audit log ──────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT        NOT NULL,  -- 'debit' | 'grant' | 'topup' | 'rollover' | 'refund'
  amount          INTEGER     NOT NULL,  -- positive = credit in, negative = debit out
  balance_after   INTEGER     NOT NULL,
  action_key      TEXT,                  -- which action triggered this
  model_used      TEXT,                  -- actual model string used
  tokens_input    INTEGER,
  tokens_output   INTEGER,
  cost_usd        NUMERIC(10,6),         -- what YOU paid OpenAI
  description     TEXT,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 4. Credit top-up purchase log ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_topups (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits         INTEGER     NOT NULL,
  amount_inr      INTEGER     NOT NULL,  -- price paid in paise (multiply by 100)
  payment_id      TEXT,                  -- Razorpay/RevenueCat payment ID
  payment_status  TEXT        NOT NULL DEFAULT 'pending',  -- pending|completed|failed
  pack_id         TEXT,                  -- 'pack_100' | 'pack_300' | 'pack_1000'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_credit_wallets_user       ON credit_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user  ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_time  ON credit_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_action ON credit_transactions(action_key);
CREATE INDEX IF NOT EXISTS idx_credit_topups_user        ON credit_topups(user_id);

-- ── Seed credit_config with all TrendAI actions ──────────────────────────────
INSERT INTO credit_config (action_key, display_name, credits_cost, model_mini, model_heavy, use_heavy, max_per_day, max_per_month, free_tier_allowed, pro_tier_allowed, max_tier_allowed, notes)
VALUES
  -- Free tier actions (0 credits, no AI)
  ('trend_browse',        'Browse Trends',          0,  'none',         'none',    false, NULL, NULL, true,  true,  true,  'DB read only — no AI cost'),
  ('song_browse',         'Browse Songs',           0,  'none',         'none',    false, NULL, NULL, true,  true,  true,  'DB read only — no AI cost'),

  -- Light actions — 4o-mini only
  ('content_generation',  'Content Generation',     10, 'gpt-4o-mini',  'gpt-4o',  false, 20,   NULL, true,  true,  true,  'Hook + caption + hashtags'),
  ('viral_ideas',         'Viral Ideas Refresh',    5,  'gpt-4o-mini',  'gpt-4o',  false, 10,   NULL, true,  true,  true,  '20 ideas JSON'),
  ('aria_chat',           'ARIA Chat',              3,  'gpt-4o-mini',  'gpt-4o',  false, 50,   NULL, true,  true,  true,  'Conversational AI'),
  ('hook_rewrite',        'Hook Rewrite',           2,  'gpt-4o-mini',  'gpt-4o',  false, 30,   NULL, true,  true,  true,  'Single hook variation'),
  ('song_recommendations','Song Recommendations',   5,  'gpt-4o-mini',  'gpt-4o',  false, NULL, NULL, true,  true,  true,  'Vector search — minimal AI'),
  ('caption_analysis',    'Caption Analysis',       5,  'gpt-4o-mini',  'gpt-4o',  false, 10,   NULL, true,  true,  true,  'Caption feedback'),
  ('bio_analysis',        'Bio Analysis',           5,  'gpt-4o-mini',  'gpt-4o',  false, 5,    NULL, true,  true,  true,  'Profile bio feedback'),
  ('posting_package',     'Posting Package',        8,  'gpt-4o-mini',  'gpt-4o',  false, 10,   NULL, false, true,  true,  'Best time + format + brief'),
  ('weekly_report',       'Weekly Report',          10, 'gpt-4o-mini',  'gpt-4o',  false, 1,    4,    false, true,  true,  'Analytics summary'),
  ('content_calendar',    'Content Calendar',       15, 'gpt-4o-mini',  'gpt-4o',  false, 1,    1,    false, true,  true,  'Monthly calendar gen'),
  ('brand_alert',         'Brand Alert Check',      3,  'gpt-4o-mini',  'gpt-4o',  false, 5,    NULL, false, true,  true,  'Brand safety check'),

  -- Medium actions — 4o-mini but heavier prompts
  ('growth_roadmap',      'Growth Roadmap',         30, 'gpt-4o-mini',  'gpt-4o',  false, 1,    4,    false, true,  true,  '4-week plan'),
  ('rate_card',           'Rate Card Generator',    20, 'gpt-4o-mini',  'gpt-4o',  false, 2,    NULL, false, true,  true,  'Brand deal pricing'),
  ('script_writing',      'Script Writing',         25, 'gpt-4o-mini',  'gpt-4o',  false, 5,    NULL, false, true,  true,  'Full video script'),
  ('brand_pitch',         'Brand Pitch',            25, 'gpt-4o-mini',  'gpt-4o',  false, 3,    NULL, false, true,  true,  'Outreach email'),

  -- Heavy actions — use gpt-4o (use_heavy = true), gated to Pro+
  ('archetype_detection', 'Archetype Detection',    15, 'gpt-4o-mini',  'gpt-4o',  true,  1,    2,    false, true,  true,  'One-time or monthly. Heavy model.'),
  ('voice_portrait',      'Voice Portrait Build',   20, 'gpt-4o-mini',  'gpt-4o',  true,  1,    1,    false, true,  true,  'Creator voice fingerprint. Heavy.'),

  -- Max-tier only
  ('video_analysis',      'Video DNA Analysis',     50, 'gpt-4o-mini',  'gpt-4o',  false, 5,    NULL, false, false, true,  'Triple stream vision analysis'),
  ('competitor_gap',      'Competitor Gap Analysis',40, 'gpt-4o-mini',  'gpt-4o',  false, 3,    NULL, false, false, true,  'Competitor intelligence')

ON CONFLICT (action_key) DO NOTHING;