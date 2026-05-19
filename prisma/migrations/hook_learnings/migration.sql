-- Hook archetype learning table
-- Tracks which hook archetypes creators choose per niche.
-- Used to auto-select the best archetype after sufficient data.

CREATE TABLE IF NOT EXISTS hook_learnings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  niche       TEXT NOT NULL,
  platform    TEXT NOT NULL,
  archetype   TEXT NOT NULL,
  was_auto    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS hook_learnings_user_niche_idx
  ON hook_learnings(user_id, niche, platform);

CREATE INDEX IF NOT EXISTS hook_learnings_archetype_idx
  ON hook_learnings(archetype);

CREATE INDEX IF NOT EXISTS hook_learnings_created_idx
  ON hook_learnings(created_at DESC);
