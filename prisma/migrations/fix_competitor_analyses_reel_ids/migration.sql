-- Add reel_ids column to competitor_analyses if it does not exist
ALTER TABLE competitor_analyses
  ADD COLUMN IF NOT EXISTS reel_ids TEXT[] NOT NULL DEFAULT '{}';

-- Ensure the user_id_niche unique constraint exists (for upsert)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'competitor_analyses_user_id_niche_key'
  ) THEN
    ALTER TABLE competitor_analyses
      ADD CONSTRAINT competitor_analyses_user_id_niche_key UNIQUE (user_id, niche);
  END IF;
END $$;
