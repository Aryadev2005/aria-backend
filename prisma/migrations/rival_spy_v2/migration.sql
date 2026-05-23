-- rival_spy_v2 migration
-- Adds rival_script action to credit_config
-- Adds generated_scripts JSONB column to rival_spy_sessions

INSERT INTO credit_config (
  action_key, display_name, credits_cost, model_mini, model_heavy,
  use_heavy, max_per_day, max_per_month,
  free_tier_allowed, starter_tier_allowed, pro_tier_allowed, max_tier_allowed, notes
) VALUES (
  'rival_script', 'Rival Script Generation', 25, 'gpt-4o-mini', 'gpt-4o',
  false, 10, NULL,
  false, false, true, true, 'Per-card voice-matched script + shoot plan from Rival Spy'
)
ON CONFLICT (action_key) DO NOTHING;

-- Add generated scripts cache column to existing sessions table
ALTER TABLE rival_spy_sessions
  ADD COLUMN IF NOT EXISTS generated_scripts JSONB DEFAULT '[]'::jsonb;

-- Index for fast session lookup
CREATE INDEX IF NOT EXISTS idx_rival_spy_sessions_user_created
  ON rival_spy_sessions(user_id, created_at DESC);
