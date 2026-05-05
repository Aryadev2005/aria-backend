// src/services/vector/embedding.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Tier 2 — Warm Retrieval: Embedding generation + vector similarity search
// Uses OpenAI embeddings for vector generation
// Falls back gracefully — never blocks the main flow
// ══════════════════════════════════════════════════════════════════════════════

import OpenAI from "openai";
import { prisma } from "../../config/database";
import { cache } from "../../config/redis";
import { logger } from "../../utils/logger";

// ── Config ────────────────────────────────────────────────────────────────────
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
const EMBEDDING_DIM = 1536; // text-embedding-3-small = 1536 dims
const BATCH_SIZE = 128; // OpenAI embeddings batch limit (conservative)

let _openai: OpenAI | null = null;
const getOpenAI = () => {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for embeddings");
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
};

// ── Core: Generate embeddings ─────────────────────────────────────────────────
export async function generateEmbedding(text: string): Promise<number[]> {
  const cacheKey = `emb:${Buffer.from(text).toString("base64").slice(0, 40)}`;
  const cached = (await cache.get(cacheKey)) as number[] | null;
  if (cached) return cached;

  const openai = getOpenAI();
  const response = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });

  const embedding = response.data[0].embedding as number[];
  await cache.set(cacheKey, embedding, 3600); // 1h cache
  return embedding;
}

export async function generateEmbeddingsBatch(
  texts: string[],
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const openai = getOpenAI();
    const response = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: batch,
    });

    // Sort by index to maintain order
    const sorted = response.data.sort((a, b) => a.index - b.index);
    results.push(...sorted.map((d) => d.embedding as number[]));
  }

  return results;
}

// ── Build embed text from a trend signal ──────────────────────────────────────
function buildEmbedText(trend: any): string {
  const parts = [
    trend.title,
    trend.recommendation,
    trend.niche_tags?.join(", "),
    trend.platform_tags?.join(", "),
    trend.badge ? `badge:${trend.badge}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
}

// ── Upsert embeddings for trend IDs ───────────────────────────────────────────
export async function embedTrends(trendIds: string[]): Promise<number> {
  if (!trendIds.length) return 0;

  const trends = await prisma.live_trends.findMany({
    where: { id: { in: trendIds } },
    select: {
      id: true,
      title: true,
      niche_tags: true,
      platform_tags: true,
      recommendation: true,
      badge: true,
    },
  });

  if (!trends.length) return 0;

  const texts = trends.map(buildEmbedText);
  const embeddings = await generateEmbeddingsBatch(texts);

  let upserted = 0;
  for (let i = 0; i < trends.length; i++) {
    const trend = trends[i];
    const embedding = embeddings[i];
    const embedText = texts[i];
    const niche = trend.niche_tags?.[0] || null;
    const platform = trend.platform_tags?.[0] || null;

    try {
      // Use raw SQL because Prisma doesn't support pgvector
      await prisma.$queryRawUnsafe(
        `INSERT INTO trend_embeddings (trend_id, embedding, embed_text, niche, platform, updated_at)
         VALUES ($1, $2::vector, $3, $4, $5, NOW())
         ON CONFLICT (trend_id)
         DO UPDATE SET embedding = $2::vector, embed_text = $3, niche = $4, platform = $5, updated_at = NOW()`,
        trend.id,
        `[${embedding.join(",")}]`,
        embedText,
        niche,
        platform,
      );
      upserted++;
    } catch (err: any) {
      logger.warn(
        { err: err.message, trendId: trend.id },
        "Failed to upsert embedding",
      );
    }
  }

  logger.info({ upserted, total: trends.length }, "Trend embeddings upserted");
  return upserted;
}

// ── Embed ALL live trends (full refresh) ──────────────────────────────────────
export async function embedAllTrends(): Promise<number> {
  const trends = await prisma.live_trends.findMany({
    where: { expires_at: { gt: new Date() } },
    select: { id: true },
  });

  const ids = trends.map((t) => t.id);
  return embedTrends(ids);
}

// ── Vector similarity search ──────────────────────────────────────────────────
export interface SimilarTrendResult {
  id: string;
  trendId: string;
  title: string;
  niche: string | null;
  similarity: number;
  embedText: string;
}

export async function findSimilarTrends(
  query: string,
  options: {
    limit?: number;
    niches?: string[];
    minSimilarity?: number;
  } = {},
): Promise<SimilarTrendResult[]> {
  const { limit = 10, niches, minSimilarity = 0.3 } = options;

  const cacheKey = `vsearch:${query}:${niches?.join(",") || "all"}:${limit}`;
  const cached = (await cache.get(cacheKey)) as SimilarTrendResult[] | null;
  if (cached) return cached;

  const queryEmbedding = await generateEmbedding(query);
  const vectorStr = `[${queryEmbedding.join(",")}]`;

  let sql: string;
  let params: any[];

  if (niches?.length) {
    sql = `
      SELECT
        te.id,
        te.trend_id AS "trendId",
        lt.title,
        te.niche,
        te.embed_text AS "embedText",
        1 - (te.embedding <=> $1::vector) AS similarity
      FROM trend_embeddings te
      JOIN live_trends lt ON lt.id = te.trend_id
      WHERE te.niche = ANY($2)
        AND lt.expires_at > NOW()
        AND 1 - (te.embedding <=> $1::vector) > $3
      ORDER BY te.embedding <=> $1::vector
      LIMIT $4
    `;
    params = [vectorStr, niches, minSimilarity, limit];
  } else {
    sql = `
      SELECT
        te.id,
        te.trend_id AS "trendId",
        lt.title,
        te.niche,
        te.embed_text AS "embedText",
        1 - (te.embedding <=> $1::vector) AS similarity
      FROM trend_embeddings te
      JOIN live_trends lt ON lt.id = te.trend_id
      WHERE lt.expires_at > NOW()
        AND 1 - (te.embedding <=> $1::vector) > $2
      ORDER BY te.embedding <=> $1::vector
      LIMIT $3
    `;
    params = [vectorStr, minSimilarity, limit];
  }

  try {
    const results = (await prisma.$queryRawUnsafe(sql, ...params)) as any[];
    const mapped: SimilarTrendResult[] = results.map((r) => ({
      id: r.id,
      trendId: r.trendId,
      title: r.title,
      niche: r.niche,
      similarity: parseFloat(r.similarity),
      embedText: r.embedText,
    }));

    await cache.set(cacheKey, mapped, 120); // 2 min cache
    return mapped;
  } catch (err: any) {
    logger.warn({ err: err.message, query }, "Vector search failed");
    return [];
  }
}

// ── Get embedding stats ───────────────────────────────────────────────────────
export async function getEmbeddingStats(): Promise<{
  totalEmbeddings: number;
  nicheBreakdown: Record<string, number>;
}> {
  const total = await prisma.trend_embeddings.count();
  const byNiche = (await (prisma.trend_embeddings as any).groupBy({
    by: ["niche"],
    _count: { _all: true },
  })) as any[];

  const nicheBreakdown: Record<string, number> = {};
  for (const row of byNiche) {
    nicheBreakdown[row.niche || "unknown"] = row._count._all;
  }

  return { totalEmbeddings: total, nicheBreakdown };
}
