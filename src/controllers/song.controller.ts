// src/controllers/song.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// Song Controller — serves songs from the 3-tier architecture
//
// All reads go through song.rag.service (Tier 1 hot window first).
// The scraper worker keeps the data fresh every 6 hours.
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { debitCredits } from "../services/credits.service";
import {
  retrieveSongs,
  getSongsForBGM,
} from "../services/songs/song.rag.service";
import { scrapeAllSources } from "../services/songs/song.scraper.service";
import {
  upsertSongs,
  updateSongTrajectories,
} from "../services/songs/song.persistence.service";
import { invalidateAllSongHotWindows } from "../services/songs/song.rag.service";
import { embedAllSongs } from "../services/songs/song.embedding.service";
import { prisma } from "../config/database";
import { User } from "../types";

// ── GET /songs — main song list for frontend ──────────────────────────────────

export interface GetSongsQuery {
  niche?: string;
  language?: string;
  lifecycle?: string;
  signal?: string;
  limit?: number;
  skipCache?: string; // "true" to bypass cache
}

export const getSongs = async (
  req: FastifyRequest<{ Querystring: GetSongsQuery }>,
  reply: FastifyReply,
) => {
  const {
    niche = "general",
    language = "Hindi",
    lifecycle,
    signal,
    limit = 120,
    skipCache,
  } = req.query;

  try {
    const result = await retrieveSongs({
      niche,
      language,
      limit: Math.min(limit, 120),
      forceRefresh: skipCache === "true",
    });

    // Apply optional filters post-retrieval
    let songs = result.songs;
    if (lifecycle && lifecycle !== "all") {
      songs = songs.filter((s) => s.lifecycle === lifecycle.toUpperCase());
    }
    if (signal && signal !== "all") {
      songs = songs.filter((s) => s.signal === signal);
    }

    return success(reply, {
      songs,
      fromCache: result.fromCache,
      language,
      niche,
      signalCount: result.metadata.songCount,
    });
  } catch (err) {
    logger.error({ err }, "getSongs failed");
    return errors.serviceDown(reply, "Song intelligence");
  }
};

// ── GET /songs/top10 ──────────────────────────────────────────────────────────

export const getTop10 = async (
  req: FastifyRequest<{ Querystring: { niche?: string; language?: string } }>,
  reply: FastifyReply,
) => {
  const { niche = "general", language = "Hindi" } = req.query;

  try {
    const result = await retrieveSongs({ niche, language, limit: 10 });
    return success(reply, result.songs.slice(0, 10));
  } catch (err) {
    logger.error({ err }, "getTop10 failed");
    return errors.serviceDown(reply, "Song intelligence");
  }
};

// ── GET /songs/predict — PRO: rising songs not yet in top 10 ─────────────────

export const predictTrendingSongs = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    const language = "Hindi"; // default — extend with user preference later
    const niche = (user.niches as string[] | null)?.[0] || "general";

    const result = await retrieveSongs({ niche, language, limit: 30 });

    // Predictions: RISING songs not yet in top 10 with high confidence
    const predictions = result.songs
      .filter((s) => s.lifecycle === "RISING" && s.chart_position > 10)
      .sort((a, b) => a.chart_position - b.chart_position)
      .slice(0, 10);

    return success(reply, predictions);
  } catch (err) {
    logger.error({ err }, "predictTrendingSongs failed");
    return errors.serviceDown(reply, "Song predictor");
  }
};

// ── GET /songs/by-mood — for BGM matcher semantic search ─────────────────────

export const getSongsByMood = async (
  req: FastifyRequest<{
    Querystring: { mood: string; niche?: string; language?: string };
  }>,
  reply: FastifyReply,
) => {
  const { mood, niche = "general", language = "Hindi" } = req.query;

  if (!mood?.trim()) return errors.badRequest(reply, "mood is required");

  try {
    const { findSimilarSongs } =
      await import("../services/songs/song.embedding.service");

    const similar = await findSimilarSongs(
      `${mood} music ${niche} ${language}`,
      {
        language,
        nicheTags: niche !== "general" ? [niche] : undefined,
        limit: 10,
        minSimilarity: 0.2,
      },
    );

    return success(reply, similar);
  } catch (err) {
    logger.error({ err }, "getSongsByMood failed");
    return errors.serviceDown(reply, "Song search");
  }
};

// ── GET /songs/languages — available languages in DB ─────────────────────────

export const getAvailableLanguages = async (
  _req: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const rows = await prisma.$queryRawUnsafe<
      { language: string; count: string }[]
    >(
      `SELECT language, COUNT(*)::text as count
       FROM live_songs
       WHERE expires_at > NOW() AND language IS NOT NULL
       GROUP BY language
       ORDER BY count DESC`,
    );
    return success(reply, rows);
  } catch (err) {
    logger.error({ err }, "getAvailableLanguages failed");
    return errors.serviceDown(reply, "Song languages");
  }
};

// ── GET /songs/niches — available niches in DB ───────────────────────────────

export const getAvailableNiches = async (
  _req: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const rows = await prisma.$queryRawUnsafe<
      { niche: string; count: string }[]
    >(
      `SELECT niche, COUNT(*)::text as count
       FROM live_songs,
            unnest(niche_tags) AS niche
       WHERE expires_at > NOW()
         AND niche IS NOT NULL
         AND niche <> ''
       GROUP BY niche
       ORDER BY count DESC, niche ASC`,
    );

    return success(reply, rows);
  } catch (err) {
    logger.error({ err }, "getAvailableNiches failed");
    return errors.serviceDown(reply, "Song niches");
  }
};

// ── GET /songs/:id ────────────────────────────────────────────────────────────

export const getSongById = async (
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  try {
    const song = await (prisma as any).live_songs.findUnique({
      where: { id: req.params.id },
    });

    if (!song) return errors.notFound(reply, "Song");

    return success(reply, {
      ...song,
      streams_today: song.streams_today?.toString(),
    });
  } catch (err) {
    logger.error({ err }, "getSongById failed");
    return errors.internal(reply);
  }
};

// ── GET /songs/trajectory/:title — Tier 3 trajectory data ────────────────────

export const getSongTrajectory = async (
  req: FastifyRequest<{
    Params: { title: string };
    Querystring: { language?: string };
  }>,
  reply: FastifyReply,
) => {
  const { title } = req.params;
  const { language } = req.query;

  try {
    const trajectory = await (prisma as any).song_trajectories.findFirst({
      where: {
        song_title: { equals: decodeURIComponent(title), mode: "insensitive" },
        ...(language
          ? { language: { equals: language, mode: "insensitive" } }
          : {}),
      },
    });

    if (!trajectory) return errors.notFound(reply, "Song trajectory");

    return success(reply, trajectory);
  } catch (err) {
    logger.error({ err }, "getSongTrajectory failed");
    return errors.internal(reply);
  }
};

// ── POST /songs/refresh — run scrapers, persist, update trajectories, invalidate cache
export const refreshSongs = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    // Run scrapers
    const { songs, diagnostics } = await scrapeAllSources();

    // Persist scraped songs into live_songs
    const upserted = await upsertSongs(songs);

    // Update trajectories (Tier 3)
    const trajectoriesUpdated = await updateSongTrajectories();

    // Invalidate hot window caches so next read is fresh
    await invalidateAllSongHotWindows();

    // Trigger embedding rebuild asynchronously (non-blocking)
    embedAllSongs().catch((err) => {
      logger.warn({ err }, "embedAllSongs failed (async)");
    });

    return success(reply, { upserted, trajectoriesUpdated, diagnostics });
  } catch (err) {
    logger.error({ err }, "refreshSongs failed");
    return errors.serviceDown(reply, "Song refresh");
  }
};
