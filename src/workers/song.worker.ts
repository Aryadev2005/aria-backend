// src/workers/song.worker.ts
// ══════════════════════════════════════════════════════════════════════════════
// BullMQ Worker: Song refresh pipeline — runs every 6 hours
//
// Pipeline per job run:
//   1. Scrape Spotify + JioSaavn + YouTube in parallel
//   2. Upsert normalised songs into live_songs (with lifecycle + signal)
//   3. Update song_trajectories (Tier 3)
//   4. Embed new/updated songs into song_embeddings (Tier 2)
//   5. Rebuild hot windows for all active languages + niches (Tier 1)
//   6. Invalidate Redis song caches so next API hit gets fresh data
//
// Job names:
//   song-full     — full pipeline (scheduled every 6h)
//   song-refresh  — alias for song-full (legacy test script compatibility)
// ══════════════════════════════════════════════════════════════════════════════

import { Worker, type Job } from "bullmq";
import { logger } from "../utils/logger";
import { cache } from "../config/redis";

let worker: Worker | null = null;

function getConnection() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "6379"),
  };
}

// ── Languages + niches to pre-warm hot windows for ───────────────────────────

const LANGUAGES = ["Hindi", "English", "Punjabi", "Telugu", "Tamil"];
const NICHES    = ["general", "fashion", "fitness", "lifestyle", "dance", "comedy"];

// ── Main job processor ────────────────────────────────────────────────────────

async function processJob(job: Job): Promise<{
  success:       boolean;
  songsInserted: number;
  embedded:      number;
  diagnostics:   { sources: Record<string, string> };
}> {
  const start = Date.now();
  logger.info({ jobName: job.name, jobId: job.id }, "Song worker job started");

  // ── Step 1: Scrape ──────────────────────────────────────────────────────────
  const { scrapeAllSources } = await import("../services/songs/song.scraper.service");
  const { songs, diagnostics } = await scrapeAllSources();

  if (!songs.length) {
    logger.warn("Song worker: no songs scraped from any source");
    return { success: false, songsInserted: 0, embedded: 0, diagnostics: { sources: diagnostics } };
  }

  await job.updateProgress(25);

  // ── Step 2: Upsert into live_songs ─────────────────────────────────────────
  const { upsertSongs, updateSongTrajectories, cleanupExpiredSongs } =
    await import("../services/songs/song.persistence.service");

  const songsInserted = await upsertSongs(songs);
  await job.updateProgress(45);

  // ── Step 3: Update trajectories (Tier 3) ───────────────────────────────────
  await updateSongTrajectories();
  await job.updateProgress(60);

  // ── Step 4: Embed new/updated songs (Tier 2) ───────────────────────────────
  let embedded = 0;
  try {
    const { embedAllSongs } = await import("../services/songs/song.embedding.service");
    embedded = await embedAllSongs();
  } catch (err: any) {
    // Embedding failure is non-fatal — songs still work without vectors
    logger.warn({ err: err.message }, "Song embedding failed — continuing without vectors");
  }
  await job.updateProgress(80);

  // ── Step 5: Invalidate old hot windows so they rebuild on next request ──────
  try {
    const { invalidateAllSongHotWindows } = await import("../services/songs/song.rag.service");
    await invalidateAllSongHotWindows();
  } catch (err: any) {
    logger.warn({ err: err.message }, "Hot window invalidation failed");
  }

  // ── Step 6: Pre-warm Tier 1 hot windows for top language+niche combos ───────
  try {
    const { retrieveSongs } = await import("../services/songs/song.rag.service");

    const warmupPairs = LANGUAGES.flatMap((lang) =>
      NICHES.map((niche) => ({ language: lang, niche })),
    );

    // Warm sequentially to avoid race conditions — each write must complete before next read
    for (const { language, niche } of warmupPairs) {
      try {
        await retrieveSongs({ language, niche, forceRefresh: true });
      } catch (err: any) {
        logger.warn({ err: err.message, language, niche }, "Hot window warmup failed");
      }
    }

    logger.info({ pairs: warmupPairs.length }, "Song hot windows pre-warmed");
  } catch (err: any) {
    logger.warn({ err: err.message }, "Hot window warmup failed — non-fatal");
  }

  // ── Step 7: Bust legacy Redis song cache keys (backward compat) ─────────────
  try {
    await cache.delPattern("sg:*");
  } catch { /* non-critical */ }

  await job.updateProgress(100);

  const duration = Date.now() - start;
  logger.info(
    { songsInserted, embedded, duration, diagnostics },
    "Song worker job complete",
  );

  // ── Step 8: Clean up expired songs (opportunistic) ───────────────────────────
  cleanupExpiredSongs().catch(() => {});

  return {
    success:       true,
    songsInserted,
    embedded,
    diagnostics: { sources: diagnostics },
  };
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

export async function startSongWorker(): Promise<Worker | null> {
  const enabled = process.env.SONG_WORKER_ENABLED !== "false";
  if (!enabled) {
    logger.info("Song worker disabled via SONG_WORKER_ENABLED=false");
    return null;
  }

  worker = new Worker("song-refresh", processJob, {
    connection:      getConnection(),
    concurrency:     1,
    lockDuration:    300000,     // 5 min
    stalledInterval: 60000,
    maxStalledCount: 2,
  });

  worker.on("completed", (job, result) => {
    logger.info(
      { jobId: job.id, songsInserted: result?.songsInserted },
      "Song worker job completed",
    );
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, err: err.message },
      "Song worker job failed",
    );
  });

  worker.on("error", (err) => {
    logger.error({ err: err.message }, "Song worker error");
  });

  logger.info("Song worker started");
  return worker;
}

export async function stopSongWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("Song worker stopped");
  }
}
