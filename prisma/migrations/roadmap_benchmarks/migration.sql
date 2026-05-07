-- ══════════════════════════════════════════════════════════════════════════════
-- Roadmap + Benchmark improvements
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Niche benchmarks table (replaces static constants) ─────────────────────
CREATE TABLE IF NOT EXISTS niche_benchmarks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  niche        TEXT NOT NULL,
  avg_er       DECIMAL(5,2) NOT NULL DEFAULT 3.0,
  top_er       DECIMAL(5,2) NOT NULL DEFAULT 6.0,
  cpm          INTEGER NOT NULL DEFAULT 90,
  label        TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT NOT NULL DEFAULT 'seed',
  CONSTRAINT niche_benchmarks_niche_key UNIQUE (niche)
);

-- Seed with current values — exact same as the static constants
INSERT INTO niche_benchmarks (niche, avg_er, top_er, cpm, label, updated_by) VALUES
  ('fitness',    3.8, 7.2, 140, 'Fitness & Wellness',        'seed'),
  ('finance',    2.9, 5.8, 220, 'Finance & Investing',       'seed'),
  ('food',       4.1, 8.0, 120, 'Food & Cooking',            'seed'),
  ('fashion',    3.2, 6.5, 130, 'Fashion & Style',           'seed'),
  ('tech',       2.5, 5.0, 190, 'Tech & Gadgets',            'seed'),
  ('travel',     3.5, 6.8, 130, 'Travel',                    'seed'),
  ('education',  3.0, 6.0, 160, 'Education',                 'seed'),
  ('comedy',     4.5, 9.0, 100, 'Comedy & Entertainment',    'seed'),
  ('beauty',     3.6, 7.0, 125, 'Beauty & Skincare',         'seed'),
  ('motivation', 3.4, 6.5, 110, 'Motivation & Lifestyle',    'seed'),
  ('hustle',     3.1, 6.2, 130, 'Hustle & Entrepreneurship', 'seed'),
  ('bollywood',  4.2, 8.5, 105, 'Bollywood & Entertainment', 'seed'),
  ('cricket',    3.9, 7.8, 115, 'Cricket & Sports',          'seed'),
  ('gaming',     3.3, 6.8, 135, 'Gaming',                    'seed'),
  ('general',    3.0, 6.0,  90, 'General',                   'seed')
ON CONFLICT (niche) DO NOTHING;

-- ── 2. Roadmap action tracking ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roadmap_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roadmap_version TEXT NOT NULL,   -- hash of roadmap generation (date + userId)
  week_number     INTEGER NOT NULL CHECK (week_number BETWEEN 1 AND 4),
  action_index    INTEGER NOT NULL,
  action_text     TEXT NOT NULL,
  completed_at    TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX roadmap_actions_unique
  ON roadmap_actions(user_id, roadmap_version, week_number, action_index);

CREATE INDEX idx_roadmap_actions_user
  ON roadmap_actions(user_id, roadmap_version);

-- ── 3. Roadmap strategic lens cycling ─────────────────────────────────────────
-- Tracks which lens was used last so each refresh gets a different one
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS roadmap_last_lens TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS roadmap_last_generated_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS roadmap_posts_at_generation INTEGER DEFAULT 0;
