// src/services/songs/song.rag.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Song 3-Tier Retrieval Orchestrator
//
// Tier 1 — Hot Window  : Redis (30 min TTL) → Postgres song_hot_window fallback
// Tier 2 — Warm        : pgvector semantic search on song_embeddings
// Tier 3 — Cold Graph  : song_trajectories lifecycle + rank history
//
// ARIA and the BGM matcher only ever read Tier 1.
// The song worker refreshes Tiers 2 & 3 every 6 hours, which rebuilds Tier 1.
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../../config/database";
import { cache } from "../../config/redis";
import { logger } from "../../utils/logger";
import {
  findSimilarSongs,
  type SimilarSongResult,
} from "./song.embedding.service";

// ── Config ─────────────────────────────────────────────────────────────────────
const HOT_TTL_SECONDS = 30 * 60; // 30 minutes — same cadence as trend hot window
const HOT_TTL_MS = HOT_TTL_SECONDS * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SongRetrievalResult {
  hotWindowNarrative: string;
  fromCache: boolean;
  songs: SongRow[];
  similarSongs: SimilarSongResult[];
  metadata: {
    language: string;
    niche: string;
    retrievalTimeMs: number;
    songCount: number;
    cacheAge?: number;
  };
}

export interface SongRow {
  id: string;
  title: string;
  artist: string;
  chart_position: number;
  chart_change: number;
  streams_today: string; // BigInt as string
  language: string;
  lifecycle: string;
  signal: string;
  growth: string;
  niche_tags: string[];
  mood_tags: string[];
  source: string;
}

// ── Tier 1: Hot Window ────────────────────────────────────────────────────────

function makeCacheKey(language: string, niche: string): string {
  return `songhot:${language.toLowerCase()}:${niche.toLowerCase()}`;
}

async function getHotWindow(language: string, niche: string) {
  const key = makeCacheKey(language, niche);

  // L1: Redis
  const redisHit = (await cache.get(key)) as any | null;
  if (redisHit?.narrative) {
    return {
      narrative: redisHit.narrative as string,
      songs: (redisHit.songs || []) as SongRow[],
      age: Date.now() - (redisHit.createdAt || 0),
    };
  }

  // L2: Postgres song_hot_window
  try {
    const row = await (prisma as any).song_hot_window.findFirst({
      where: {
        cache_key: key,
        expires_at: { gt: new Date() },
      },
    });

    if (row) {
      const age = Date.now() - (row.created_at?.getTime() || 0);
      const meta = (row.metadata as any) || {};

      // Promote back to Redis
      await cache.set(
        key,
        {
          narrative: row.narrative,
          songs: meta.songs || [],
          createdAt: row.created_at?.getTime(),
        },
        Math.max(
          60,
          Math.round((row.expires_at.getTime() - Date.now()) / 1000),
        ),
      );

      return {
        narrative: row.narrative as string,
        songs: (meta.songs || []) as SongRow[],
        age,
      };
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Song hot window Postgres fetch failed");
  }

  return null;
}

async function setHotWindow(
  language: string,
  niche: string,
  narrative: string,
  songs: SongRow[],
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const key = makeCacheKey(language, niche);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + HOT_TTL_MS);
  const payload = { narrative, songs, createdAt: now.getTime(), ...metadata };

  await cache.set(key, payload, HOT_TTL_SECONDS);

  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO song_hot_window (cache_key, narrative, metadata, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cache_key)
       DO UPDATE SET narrative = $2, metadata = $3, created_at = $4, expires_at = $5`,
      key,
      narrative,
      JSON.stringify({ ...metadata, songs }),
      now,
      expiresAt,
    );
  } catch (err: any) {
    logger.warn({ err: err.message }, "Song hot window Postgres write failed");
  }
}

// ── Build narrative from live signals ─────────────────────────────────────────

function buildSongNarrative(
  language: string,
  niche: string,
  songs: SongRow[],
  similar: SimilarSongResult[],
): string {
  const parts: string[] = [];

  const lifecycleEmoji: Record<string, string> = {
    RISING: "🚀",
    PEAKING: "🔥",
    DECLINING: "📉",
    DEAD: "💀",
    CYCLICAL: "🔄",
  };

  const signalLabel: Record<string, string> = {
    postNow: "Post NOW",
    wait: "Wait",
    tooLate: "Too Late",
  };

  if (songs.length > 0) {
    const postNow = songs.filter((s) => s.signal === "postNow").slice(0, 5);
    const waiting = songs.filter((s) => s.signal === "wait").slice(0, 3);

    if (postNow.length > 0) {
      parts.push(
        `🎵 SONGS TO USE RIGHT NOW (${language}/${niche}):\n` +
          postNow
            .map(
              (s) =>
                `• "${s.title}" — ${s.artist} | #${s.chart_position} ${s.growth} | ${lifecycleEmoji[s.lifecycle] || ""} ${s.lifecycle}`,
            )
            .join("\n"),
      );
    }

    if (waiting.length > 0) {
      parts.push(
        `⏳ TRENDING BUT WAIT:\n` +
          waiting
            .map((s) => `• "${s.title}" — ${s.artist} | ${s.lifecycle}`)
            .join("\n"),
      );
    }
  }

  // Add semantically similar songs (from vector search)
  const uniqueTitles = new Set(songs.map((s) => s.title.toLowerCase()));
  const novelSimilar = similar.filter(
    (s) => !uniqueTitles.has(s.title.toLowerCase()),
  );

  if (novelSimilar.length > 0) {
    parts.push(
      `🔍 RELATED SONGS (semantic match):\n` +
        novelSimilar
          .slice(0, 4)
          .map(
            (s) =>
              `• "${s.title}" — ${s.artist} | ${(s.similarity * 100).toFixed(0)}% match`,
          )
          .join("\n"),
    );
  }

  if (parts.length === 0) {
    return `No song intelligence available for ${language}/${niche} right now. New data arrives every 6 hours.`;
  }

  return parts.join("\n\n");
}

// ── Main retrieval function ───────────────────────────────────────────────────

export async function retrieveSongs(options: {
  language?: string;
  niche?: string;
  forceRefresh?: boolean;
  limit?: number;
}): Promise<SongRetrievalResult> {
  const startTime = Date.now();
  const language = options.language || "Hindi";
  const niche = options.niche || "general";
  const limit = options.limit || 15;

  // Tier 1 check
  if (!options.forceRefresh) {
    const hot = await getHotWindow(language, niche);
    if (hot) {
      logger.info({ language, niche, age: hot.age }, "Song hot window HIT");
      return {
        hotWindowNarrative: hot.narrative,
        fromCache: true,
        songs: hot.songs,
        similarSongs: [],
        metadata: {
          language,
          niche,
          retrievalTimeMs: Date.now() - startTime,
          songCount: hot.songs.length,
          cacheAge: hot.age,
        },
      };
    }
  }

  logger.info({ language, niche }, "Song hot window MISS — full retrieval");

  // Tier 2 + 3: parallel retrieval
  const [liveResult, similarResult, trajectoryResult] =
    await Promise.allSettled([
      // Live songs from DB
      (prisma as any).live_songs.findMany({
        where: {
          expires_at: { gt: new Date() },
          language: { equals: language, mode: "insensitive" },
          lifecycle: { not: "DEAD" },
          ...(niche !== "general" ? { niche_tags: { has: niche } } : {}),
        },
        orderBy: [
          { lifecycle: "asc" }, // PEAKING first via sort order
          { chart_position: "asc" },
        ],
        take: limit,
        select: {
          id: true,
          title: true,
          artist: true,
          chart_position: true,
          chart_change: true,
          streams_today: true,
          language: true,
          lifecycle: true,
          signal: true,
          growth: true,
          niche_tags: true,
          mood_tags: true,
          source: true,
        },
      }),

      // Semantic similarity (Tier 2)
      findSimilarSongs(`${niche} trending music ${language}`, {
        language,
        limit: 6,
        minSimilarity: 0.2,
      }),

      // Tier 3 trajectories
      (prisma as any).song_trajectories.findMany({
        where: {
          language: { equals: language, mode: "insensitive" },
          lifecycle: { not: "DEAD" },
          ...(niche !== "general" ? { niche_tags: { has: niche } } : {}),
        },
        orderBy: { updated_at: "desc" },
        take: 10,
        select: {
          song_title: true,
          artist: true,
          lifecycle: true,
          rank_history: true,
          confidence: true,
          peak_rank: true,
        },
      }),
    ]);

  const liveSongs: SongRow[] =
    liveResult.status === "fulfilled"
      ? (liveResult.value as any[]).map((s: any) => ({
          ...s,
          streams_today: s.streams_today?.toString() || "0",
        }))
      : [];

  // Ensure a stable, business-intended ordering: lifecycle priority then chart_position
  const lifecyclePriority: Record<string, number> = {
    PEAKING: 1,
    RISING: 2,
    DECLINING: 3,
    CYCLICAL: 4,
    DEAD: 5,
  };

  liveSongs.sort((a, b) => {
    const pa = lifecyclePriority[a.lifecycle] ?? 99;
    const pb = lifecyclePriority[b.lifecycle] ?? 99;
    if (pa !== pb) return pa - pb;
    const ca = a.chart_position ?? 9999;
    const cb = b.chart_position ?? 9999;
    return ca - cb;
  });

  const similarSongs: SimilarSongResult[] =
    similarResult.status === "fulfilled" ? similarResult.value : [];

  // Build and cache narrative
  const narrative = buildSongNarrative(
    language,
    niche,
    liveSongs,
    similarSongs,
  );

  await setHotWindow(language, niche, narrative, liveSongs, {
    songCount: liveSongs.length,
    similarCount: similarSongs.length,
    generatedAt: new Date().toISOString(),
  });

  return {
    hotWindowNarrative: narrative,
    fromCache: false,
    songs: liveSongs,
    similarSongs,
    metadata: {
      language,
      niche,
      retrievalTimeMs: Date.now() - startTime,
      songCount: liveSongs.length,
    },
  };
}

// ── Invalidation ──────────────────────────────────────────────────────────────

export async function invalidateSongHotWindow(
  language: string,
  niche: string,
): Promise<void> {
  const key = makeCacheKey(language, niche);
  await cache.del(key);
  try {
    await (prisma as any).song_hot_window.deleteMany({
      where: { cache_key: key },
    });
  } catch {
    /* non-critical */
  }
  logger.info({ language, niche }, "Song hot window invalidated");
}

export async function invalidateAllSongHotWindows(): Promise<void> {
  await cache.delPattern("songhot:*");
  try {
    await (prisma as any).song_hot_window.deleteMany({});
  } catch {
    /* non-critical */
  }
  logger.info("All song hot windows invalidated");
}

// ── Convenience: get songs for BGM matcher ────────────────────────────────────
// Called by studio.service.ts — returns normalised song rows ready for Groq prompt.

export async function getSongsForBGM(options: {
  niche: string;
  language: string;
  limit?: number;
}): Promise<SongRow[]> {
  try {
    const result = await retrieveSongs({
      language: options.language,
      niche: options.niche,
      limit: options.limit || 10,
    });
    return result.songs;
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "getSongsForBGM failed — returning empty",
    );
    return [];
  }
}
