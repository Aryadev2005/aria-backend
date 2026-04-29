-- ============================================================
-- Migration 005: ARIA True Intelligence
-- aria_memory + aria_chat_sessions + aria_suggestions + live_trends updates
-- Run: psql $DATABASE_URL -f 005_aria_memory.sql
-- ============================================================

-- ── 1. Persistent cross-session memory ──────────────────────
-- Each row = one discrete thing ARIA learned about this user.
-- category allows targeted injection (only inject 'tone' learnings
-- when the user is in Studio, only 'schedule' in Launch, etc.)
CREATE TABLE IF NOT EXISTS aria_memory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  -- categories: 'tone' | 'hook_language' | 'schedule' | 'content_format'
  --             | 'brand_voice' | 'platform_pref' | 'audience_insight'
  key          TEXT NOT NULL,   -- e.g. 'preferred_hook_language'
  value        TEXT NOT NULL,   -- e.g. 'Hindi'
  confidence   INTEGER DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  source       TEXT DEFAULT 'inferred',
  -- source: 'inferred' (from feedback) | 'explicit' (user said it) | 'observed' (from analytics)
  times_seen   INTEGER DEFAULT 1,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, category, key)  -- safe for ON CONFLICT DO UPDATE
);

-- ── 2. Chat sessions with rolling history ───────────────────
-- Stores turn-by-turn messages per session.
-- Capped at 20 messages via application logic to stay under token budget.
CREATE TABLE IF NOT EXISTS aria_chat_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,          -- client-generated UUID per app launch
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  tool_calls  JSONB,                  -- stores LLM tool invocations for replay
  tool_result JSONB,                  -- stores what the tool returned
  entry_screen TEXT,                  -- 'discover' | 'studio' | 'launch' | 'profile' | 'direct'
  context_snapshot JSONB,             -- idea/script/platform at message time
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3. ARIA's own suggestions — for closing the loop ────────
-- When ARIA recommends something, we store it here.
-- When the user comes back, ARIA can ask: "how did that go?"
CREATE TABLE IF NOT EXISTS aria_suggestions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id      TEXT,
  suggestion_type TEXT NOT NULL,
  -- types: 'posting_time' | 'hook' | 'format' | 'bgm' | 'caption' | 'trend'
  suggestion_data JSONB NOT NULL,     -- the full suggestion
  status          TEXT DEFAULT 'pending',
  -- status: 'pending' | 'tried' | 'skipped' | 'dismissed'
  result_data     JSONB,              -- what the user reported back
  follow_up_sent  BOOLEAN DEFAULT FALSE,
  follow_up_at    TIMESTAMPTZ,        -- when to send the 48hr nudge
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 4. Update live_trends table with ARIA columns ─────────
-- Add missing columns that aria_tools.service.js expects
ALTER TABLE live_trends
  ADD COLUMN IF NOT EXISTS badge TEXT,         -- 'HOT' | 'RISING' | 'ALL'
  ADD COLUMN IF NOT EXISTS recommendation TEXT; -- ARIA recommendation text

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_aria_memory_user       ON aria_memory(user_id, category);
CREATE INDEX IF NOT EXISTS idx_aria_memory_confidence ON aria_memory(user_id, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user     ON aria_chat_sessions(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_created  ON aria_chat_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestions_user       ON aria_suggestions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_suggestions_followup   ON aria_suggestions(follow_up_at)
  WHERE follow_up_sent = FALSE AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_live_trends_badge      ON live_trends(badge)
  WHERE expires_at > NOW();
