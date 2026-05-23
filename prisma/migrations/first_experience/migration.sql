-- Track which first-experience (trial) actions a user has consumed
-- Each action grants one-time free access to a premium feature
CREATE TABLE IF NOT EXISTS first_experience_usage (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_key    TEXT        NOT NULL,  -- 'rival_spy_trial' | 'studio_trial' | 'video_dna_trial'
  used_at       TIMESTAMPTZ DEFAULT NOW(),
  result_data   JSONB,                 -- store the result so they can revisit it
  converted_to_pro BOOLEAN  DEFAULT FALSE,
  converted_at  TIMESTAMPTZ,
  UNIQUE(user_id, action_key)          -- one per action per user, forever
);

CREATE INDEX IF NOT EXISTS idx_first_exp_user ON first_experience_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_first_exp_action ON first_experience_usage(user_id, action_key);
