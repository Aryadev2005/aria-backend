-- credits_v3/migration.sql
-- Allow Starter tier users to access shoot_plan and thumbnail_variants.
--
-- shoot_plan:        was freeTierAllowed=false, starterTierAllowed=true in code
--                    but DB starter_tier_allowed may be false — set to true.
-- thumbnail_variants: starterTierAllowed was false — upgrading Starter access.

BEGIN;

UPDATE credit_config
SET starter_tier_allowed = true
WHERE action_key IN ('shoot_plan', 'thumbnail_variants');

COMMIT;
