-- Migration: 007_langgraph_checkpointer
-- PostgresSaver (LangGraph) creates its own tables via checkpointer.setup().
-- This migration documents what gets created + adds our index for cleanup.
--
-- Run checkpointer.setup() in Node FIRST (it auto-creates the tables),
-- then run this file for the index + cleanup job.
--
-- PostgresSaver creates these tables automatically:
--   checkpoints         — stores agent state per thread_id + checkpoint_id
--   checkpoint_blobs    — stores serialized state blobs
--   checkpoint_writes   — stores pending writes between checkpoints

-- ── Add cleanup index (LangGraph doesn't create this) ────────────────────────
-- Allows us to purge old sessions efficiently
CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_ts
  ON checkpoints(thread_id, checkpoint_id DESC)
  WHERE thread_id IS NOT NULL;

-- ── Cleanup job: delete sessions older than 30 days ──────────────────────────
-- Run via BullMQ cron weekly — or add to existing trend.worker.js
-- DELETE FROM checkpoints      WHERE created_at < NOW() - INTERVAL '30 days';
-- DELETE FROM checkpoint_blobs WHERE created_at < NOW() - INTERVAL '30 days';
-- DELETE FROM checkpoint_writes WHERE created_at < NOW() - INTERVAL '30 days';

-- ── Verify ───────────────────────────────────────────────────────────────────
SELECT 'LangGraph checkpointer migration ready' AS status;
SELECT 'Run checkpointer.setup() in Node to create the actual tables' AS note;
