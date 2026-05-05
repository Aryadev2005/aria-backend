// src/services/songs/song.embedding.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Song Embedding — Tier 2 for the songs 3-tier architecture
//
// Mirrors the pattern of src/services/vector/embedding.service.ts but scoped
// to live_songs → song_embeddings.
//
// Uses OpenAI embeddings — same model as trend embeddings.
// Falls back gracefully — never blocks the scrape worker.
// ══════════════════════════════════════════════════════════════════════════════

import OpenAI from "openai";
import { prisma } from "../../config/database";
import { cache } from "../../config/redis";
import { logger } from "../../utils/logger";

const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
const BATCH_SIZE = 128;

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey)
      throw new Error("OPENAI_API_KEY is required for song embeddings");
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
}

// ── Build rich embed text from a song row ─────────────────────────────────────

function buildSongEmbedText(song: {
  title: string;
  artist: string;
  language: string | null;
  mood_tags: string[] | null;
  niche_tags: string[] | null;
  lifecycle: string | null;
}): string {
  const parts = [
    song.title,
    `by ${song.artist}`,
    song.language ? `language:${song.language}` : null,
    song.mood_tags?.length ? `mood:${song.mood_tags.join(",")}` : null,
    song.niche_tags?.length ? `niche:${song.niche_tags.join(",")}` : null,
    song.lifecycle ? `lifecycle:${song.lifecycle}` : null,
  ].filter(Boolean);

  return parts.join(" | ");
}

// ── Generate embedding via Groq ───────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[]> {
  const cacheKey = `semb:${Buffer.from(text).toString("base64").slice(0, 40)}`;
  const cached = (await cache.get(cacheKey)) as number[] | null;
  if (cached) return cached;

  const response = await getOpenAI().embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });

  const embedding = response.data[0].embedding as number[];
  await cache.set(cacheKey, embedding, 3600);
  return embedding;
}

async function generateEmbeddingsBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await getOpenAI().embeddings.create({
      model: EMBED_MODEL,
      input: batch,
    });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    results.push(...sorted.map((d) => d.embedding as number[]));
  }

  return results;
}

// ── Embed a list of song IDs ───────────────────────────────────────────────────

export async function embedSongs(songIds: string[]): Promise<number> {
  if (!songIds.length) return 0;

  const songs = await (prisma as any).live_songs.findMany({
    where: { id: { in: songIds } },
    select: {
      id: true,
      title: true,
      artist: true,
      language: true,
      mood_tags: true,
      niche_tags: true,
      lifecycle: true,
    },
  });

  if (!songs.length) return 0;

  const texts = songs.map(buildSongEmbedText);
  const embeddings = await generateEmbeddingsBatch(texts);

  let upserted = 0;

  for (let i = 0; i < songs.length; i++) {
    const song = songs[i];
    const embedding = embeddings[i];
    const embedText = texts[i];

    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO song_embeddings (song_id, embedding, embed_text, language, niche_tags, updated_at)
         VALUES ($1, $2::vector, $3, $4, $5, NOW())
         ON CONFLICT (song_id)
         DO UPDATE SET
           embedding  = $2::vector,
           embed_text = $3,
           language   = $4,
           niche_tags = $5,
           updated_at = NOW()`,
        song.id,
        `[${embedding.join(",")}]`,
        embedText,
        song.language || null,
        `{${(song.niche_tags || []).join(",")}}`,
      );
      upserted++;
    } catch (err: any) {
      logger.warn(
        { err: err.message, songId: song.id },
        "Song embedding upsert failed",
      );
    }
  }

  logger.info({ upserted, total: songs.length }, "Song embeddings upserted");
  return upserted;
}

// ── Embed ALL current live songs ─────────────────────────────────────────────

export async function embedAllSongs(): Promise<number> {
  const songs = await (prisma as any).live_songs.findMany({
    where: { expires_at: { gt: new Date() } },
    select: { id: true },
  });

  const ids = songs.map((s: any) => s.id);
  return embedSongs(ids);
}

// ── Semantic song search ──────────────────────────────────────────────────────

export interface SimilarSongResult {
  id: string;
  songId: string;
  title: string;
  artist: string;
  language: string | null;
  similarity: number;
  embedText: string;
}

export async function findSimilarSongs(
  query: string,
  options: {
    limit?: number;
    language?: string;
    nicheTags?: string[];
    minSimilarity?: number;
  } = {},
): Promise<SimilarSongResult[]> {
  const { limit = 8, language, nicheTags, minSimilarity = 0.25 } = options;

  const cacheKey = `svsearch:${query}:${language || "all"}:${nicheTags?.join(",") || "all"}:${limit}`;
  const cached = (await cache.get(cacheKey)) as SimilarSongResult[] | null;
  if (cached) return cached;

  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Song semantic search: embedding generation failed",
    );
    return [];
  }

  const vectorStr = `[${queryEmbedding.join(",")}]`;

  // Build parameterised SQL based on filters
  const conditions: string[] = [
    `ls.expires_at > NOW()`,
    `1 - (se.embedding <=> $1::vector) > $2`,
  ];
  const params: any[] = [vectorStr, minSimilarity];

  if (language) {
    params.push(language);
    conditions.push(`se.language = $${params.length}`);
  }

  if (nicheTags?.length) {
    params.push(`{${nicheTags.join(",")}}`);
    conditions.push(`se.niche_tags && $${params.length}::text[]`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT
      se.id,
      se.song_id    AS "songId",
      ls.title,
      ls.artist,
      se.language,
      se.embed_text AS "embedText",
      1 - (se.embedding <=> $1::vector) AS similarity
    FROM song_embeddings se
    JOIN live_songs ls ON ls.id = se.song_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY se.embedding <=> $1::vector
    LIMIT ${limitParam}
  `;

  try {
    const results = (await prisma.$queryRawUnsafe(sql, ...params)) as any[];

    const mapped: SimilarSongResult[] = results.map((r) => ({
      id: r.id,
      songId: r.songId,
      title: r.title,
      artist: r.artist,
      language: r.language,
      similarity: parseFloat(r.similarity),
      embedText: r.embedText,
    }));

    await cache.set(cacheKey, mapped, 180); // 3 min cache
    return mapped;
  } catch (err: any) {
    logger.warn({ err: err.message, query }, "Song vector search failed");
    return [];
  }
}
