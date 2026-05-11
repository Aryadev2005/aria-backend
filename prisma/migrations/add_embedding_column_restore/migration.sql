-- ══════════════════════════════════════════════════════════════════════════════
-- Restore: Re-add the `embedding` column to trend_embeddings
--
-- The column was dropped by the studio_scripts migration because Prisma does
-- not model pgvector columns in schema.prisma (unsupported type). This raw SQL
-- migration re-adds it and is tracked by Prisma but never touched by future
-- `prisma migrate` runs (since the column is intentionally absent from the
-- Prisma schema model).
--
-- Dimension: 1536  (text-embedding-3-small, matches EMBEDDING_DIM in
--                   src/services/vector/embedding.service.ts)
-- ══════════════════════════════════════════════════════════════════════════════

-- Ensure pgvector extension exists (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Re-add the embedding column if it was dropped
ALTER TABLE trend_embeddings
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Recreate the IVFFlat cosine-similarity index
-- (dropped in studio_scripts migration alongside the column)
CREATE INDEX IF NOT EXISTS idx_trend_embeddings_vector
  ON trend_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
