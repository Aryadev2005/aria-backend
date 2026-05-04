-- ══════════════════════════════════════════════════════════════════════════════
-- Hybrid RAG: Vector Embeddings + Knowledge Graph + Hot Window Cache
-- Migration for Airra 3-tier memory architecture
-- ══════════════════════════════════════════════════════════════════════════════

-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Tier 2: Trend Embeddings (Vector Store) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS trend_embeddings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trend_id      UUID NOT NULL REFERENCES live_trends(id) ON DELETE CASCADE,
  embedding     vector(768),          -- nomic-embed-text-v1.5 = 768 dims
  embed_text    TEXT NOT NULL,         -- the text that was embedded
  niche         TEXT,                  -- denormalized for fast filtering
  platform      TEXT,                  -- denormalized
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_trend_embeddings_trend UNIQUE (trend_id)
);

-- IVFFlat index for cosine similarity — handles up to ~1M rows with lists=100
CREATE INDEX IF NOT EXISTS idx_trend_embeddings_vector
  ON trend_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_trend_embeddings_niche
  ON trend_embeddings (niche);

CREATE INDEX IF NOT EXISTS idx_trend_embeddings_updated
  ON trend_embeddings (updated_at DESC);


-- ── Tier 3: Knowledge Graph — Nodes ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS graph_nodes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_type     TEXT NOT NULL,         -- 'NICHE' | 'PLATFORM' | 'FORMAT' | 'ARCHETYPE' | 'TREND_CLUSTER'
  label         TEXT NOT NULL,         -- human-readable: 'fashion', 'instagram', 'reel', etc.
  properties    JSONB DEFAULT '{}',    -- flexible metadata
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_graph_nodes_type_label UNIQUE (node_type, label)
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes (node_type);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_label ON graph_nodes (label);


-- ── Tier 3: Knowledge Graph — Edges ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS graph_edges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  target_id     UUID NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  edge_type     TEXT NOT NULL,         -- 'TRENDS_ON' | 'LAGS_BY' | 'RELATED_TO' | 'CROSS_POLLINATES'
  weight        DECIMAL(5,2) DEFAULT 1.0,
  properties    JSONB DEFAULT '{}',    -- e.g. { "lagDays": 3, "confidence": 0.82 }
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_graph_edges UNIQUE (source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges (source_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges (target_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_type   ON graph_edges (edge_type);


-- ── Tier 3: Trend Trajectories ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trend_trajectories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trend_title   TEXT NOT NULL,
  niche         TEXT,
  trajectory    TEXT NOT NULL,         -- 'RISING' | 'PEAKING' | 'DECLINING' | 'DEAD' | 'CYCLICAL'
  velocity_history JSONB DEFAULT '[]', -- [ { "date": "2025-05-01", "velocity": 72 }, ... ]
  first_seen    TIMESTAMPTZ DEFAULT NOW(),
  peak_at       TIMESTAMPTZ,
  confidence    DECIMAL(5,2) DEFAULT 0.5,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_trend_trajectories_title_niche UNIQUE (trend_title, niche)
);

CREATE INDEX IF NOT EXISTS idx_trend_trajectories_niche ON trend_trajectories (niche);
CREATE INDEX IF NOT EXISTS idx_trend_trajectories_trajectory ON trend_trajectories (trajectory);


-- ── Tier 1: Hot Window Cache (Postgres-backed, Redis is L1) ──────────────────
CREATE TABLE IF NOT EXISTS hot_window_cache (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key     TEXT NOT NULL UNIQUE,  -- e.g. 'hot:fashion', 'hot:tech'
  narrative     TEXT NOT NULL,         -- pre-assembled context for ARIA
  metadata      JSONB DEFAULT '{}',   -- signals count, graph context, etc.
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL   -- 30 min TTL
);

CREATE INDEX IF NOT EXISTS idx_hot_window_cache_key ON hot_window_cache (cache_key);
CREATE INDEX IF NOT EXISTS idx_hot_window_cache_expires ON hot_window_cache (expires_at);
