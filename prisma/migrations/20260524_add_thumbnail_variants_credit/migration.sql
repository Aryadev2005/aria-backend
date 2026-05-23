-- Add thumbnail_variants action to credit_config table
-- featureCharge = 15 credits (A/B/C variant generation using GPT-4o vision)
-- Pro tier and above only
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
  'thumbnail_variants',
  'Thumbnail Variants',
  15,
  'gpt-4o-mini',
  'gpt-4o',
  false,
  false,
  false,
  true,
  true
) ON CONFLICT (action_key) DO NOTHING;
