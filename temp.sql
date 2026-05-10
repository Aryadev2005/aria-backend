-- Reset free users back to their original 100cr grant
-- Only runs if their balance somehow exceeded 100 due to past resets
UPDATE credit_wallets
SET
  balance       = 100,
  plan_credits  = 100,
  total_granted = 100
WHERE user_id IN (
  SELECT id FROM users
  WHERE subscription_tier IS NULL OR subscription_tier = 'free'
)
AND total_granted > 100; -- only touch accounts that got extra resets