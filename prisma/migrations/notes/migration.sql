-- Creator Notes Table
CREATE TABLE IF NOT EXISTS creator_notes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL DEFAULT '',
  content     TEXT        NOT NULL DEFAULT '',
  source      TEXT        NOT NULL DEFAULT 'manual',
  -- source values: 'manual' | 'studio_hook' | 'studio_caption' | 'studio_idea' | 'studio_script'
  source_meta JSONB       DEFAULT '{}',
  -- source_meta: { studioSessionId, ideaTitle, platform, niche } when source != 'manual'
  tags        TEXT[]      DEFAULT '{}',
  is_pinned   BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creator_notes_user_id ON creator_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_creator_notes_user_source ON creator_notes(user_id, source);
CREATE INDEX IF NOT EXISTS idx_creator_notes_pinned ON creator_notes(user_id, is_pinned) WHERE is_pinned = true;

-- Run this migration: psql $DATABASE_URL -f prisma/migrations/notes/migration.sql
