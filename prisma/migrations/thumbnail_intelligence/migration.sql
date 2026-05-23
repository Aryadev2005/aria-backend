-- ───────────────────────────────────────────────────────────────────────────────
-- Thumbnail Intelligence System Migration
-- Adds visual analysis capabilities, variant A/B/C testing, and Rival Watch tracking
-- ───────────────────────────────────────────────────────────────────────────────

-- 1. Add thumbnail_analysis column to video_dna_analyses (nullable, safe migration)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'video_dna_analyses' AND column_name = 'thumbnail_analysis'
  ) THEN
    ALTER TABLE video_dna_analyses ADD COLUMN thumbnail_analysis JSONB;
  END IF;
END $$;

-- 2. Add Rival Watch tracking columns to users table
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'rival_watch_handles'
  ) THEN
    ALTER TABLE users ADD COLUMN rival_watch_handles TEXT[] DEFAULT '{}'::text[];
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'rival_watch_last_notified_at'
  ) THEN
    ALTER TABLE users ADD COLUMN rival_watch_last_notified_at TIMESTAMPTZ;
  END IF;
END $$;

-- 3. Create thumbnail_variants table for A/B/C testing
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'thumbnail_variants'
  ) THEN
    CREATE TABLE thumbnail_variants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      studio_session_id UUID REFERENCES studio_scripts(id) ON DELETE SET NULL,
      video_id TEXT,
      variant_a JSONB NOT NULL,
      variant_b JSONB NOT NULL,
      variant_c JSONB,
      active_variant TEXT DEFAULT 'a',
      rotation_started_at TIMESTAMPTZ,
      rotation_ends_at TIMESTAMPTZ,
      ctr_a DECIMAL(5,2),
      ctr_b DECIMAL(5,2),
      ctr_c DECIMAL(5,2),
      winner TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '72 hours')
    );

    -- Create indexes
    CREATE INDEX idx_thumbnail_variants_user ON thumbnail_variants(user_id);
    CREATE INDEX idx_thumbnail_variants_session ON thumbnail_variants(studio_session_id);
    CREATE INDEX idx_thumbnail_variants_status ON thumbnail_variants(status) WHERE status = 'rotating';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────────
-- End of Thumbnail Intelligence Migration
-- ───────────────────────────────────────────────────────────────────────────────
