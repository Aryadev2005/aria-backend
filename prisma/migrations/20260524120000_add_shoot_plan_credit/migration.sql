-- Add shoot_plan action to credit_config table
-- featureCharge = 3 credits (cheap — fast single AI call)
INSERT INTO credit_config (
  action_key,
  display_name,
  credits_cost,
  model_mini,
  model_heavy,
  use_heavy,
  free_tier_allowed,
  starter_tier_allowed,
  pro_tier_allowed,
  max_tier_allowed
) VALUES (
  'shoot_plan',
  'Director''s Shoot Plan',
  3,
  'gpt-4o-mini',
  'claude-sonnet-4-6',
  false,
  false,
  true,
  true,
  true
) ON CONFLICT (action_key) DO NOTHING;
