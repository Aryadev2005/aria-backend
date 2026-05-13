-- prisma/migrations/rival_spy/migration.sql
-- Rival Spy feature: credit config entry + session cache table

-- Add rival_spy to credit_config
INSERT INTO credit_config (
  action_key, display_name, credits_cost, model_mini, model_heavy,
  use_heavy, max_per_day, max_per_month,
  free_tier_allowed, starter_tier_allowed, pro_tier_allowed, max_tier_allowed, notes
) VALUES (
  'rival_spy', 'Rival Spy', 35, 'gpt-4o-mini', 'gpt-4o',
  false, 3, NULL,
  false, false, true, true, 'Multi-handle competitor intelligence with DNA scoring'
)
ON CONFLICT (action_key) DO NOTHING;

-- Spy session cache — stores results so re-renders don't re-scrape
CREATE TABLE IF NOT EXISTS rival_spy_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handles       TEXT[]      NOT NULL,
  platform      TEXT        NOT NULL DEFAULT 'auto',
  result        JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ DEFAULT NOW() + INTERVAL '6 hours'
);

CREATE INDEX IF NOT EXISTS idx_rival_spy_user ON rival_spy_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_rival_spy_expires ON rival_spy_sessions(expires_at);
