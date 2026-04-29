-- Migration 010: Fix memory indexes and naming
-- Improving DB performance for memory lookups

-- Ensure agent_memory has proper indexes if it exists
CREATE INDEX IF NOT EXISTS idx_agent_memory_user ON agent_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_key ON agent_memory(key);

-- Ensure aria_memory has the category/key coverage
CREATE INDEX IF NOT EXISTS idx_aria_memory_lookup ON aria_memory(user_id, category, key);

-- Add GIN index for search_volume and velocity in live_trends for faster sorting
CREATE INDEX IF NOT EXISTS idx_live_trends_performance ON live_trends(velocity DESC, search_volume DESC);
