// src/config/queue.additions.ts
// ══════════════════════════════════════════════════════════════════════════════
// Scheduled BullMQ jobs for embeddings + songs
// Extend this file when adding new periodic workers.
// ══════════════════════════════════════════════════════════════════════════════

import { Queue } from "bullmq";
import { logger } from "../utils/logger";

function getConnection() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  return { host: parsed.hostname, port: parseInt(parsed.port || "6379") };
}

// ── Trend embedding schedule ──────────────────────────────────────────────────
// Full re-embed every 6h + incremental every hour

export async function scheduleEmbedJobs(): Promise<void> {
  try {
    const embeddingQueue = new Queue("embedding-queue", { connection: getConnection() });

    await embeddingQueue.upsertJobScheduler(
      "embed-full-scheduled",
      { every: 6 * 60 * 60 * 1000 },   // 6 hours
      { name: "embed-full", data: {} },
    );

    await embeddingQueue.upsertJobScheduler(
      "embed-incremental-scheduled",
      { every: 60 * 60 * 1000 },        // 1 hour
      { name: "embed-incremental", data: { trendIds: [] } },
    );

    logger.info("Embedding jobs scheduled");
    await embeddingQueue.close();
  } catch (err: any) {
    logger.warn({ err: err.message }, "Failed to schedule embedding jobs");
  }
}

// ── Song refresh schedule ─────────────────────────────────────────────────────
// Full scrape + embed + hot-window rebuild every 6 hours

export async function scheduleSongJobs(): Promise<void> {
  try {
    const songQueue = new Queue("song-refresh", { connection: getConnection() });

    await songQueue.upsertJobScheduler(
      "song-full-scheduled",
      { every: 6 * 60 * 60 * 1000 },   // 6 hours — matches scrape cadence
      { name: "song-full", data: {} },
    );

    logger.info("Song refresh job scheduled (every 6h)");
    await songQueue.close();
  } catch (err: any) {
    logger.warn({ err: err.message }, "Failed to schedule song jobs");
  }
}

// ── Discovery scrape schedule ─────────────────────────────────────────────────
// Split into two queues:
// discovery-fast (every 12h): YouTube + Google Trends
// discovery-slow (every 24h): Reddit + TikTok + Pinterest

export async function scheduleDiscoveryJobs(): Promise<void> {
  try {
    // Queue A: discovery-queue → discovery-fast (YouTube + Google Trends every 12h)
    const fastQueue = new Queue("discovery-queue", { connection: getConnection() });

    await fastQueue.upsertJobScheduler(
      "discovery-fast-scheduled",
      { every: 12 * 60 * 60 * 1000 },  // every 12 hours
      { name: "discovery-fast", data: {} },
    );

    logger.info("Discovery FAST job scheduled (YouTube + Google Trends every 12h)");
    await fastQueue.close();

    // Queue B: discovery-slow → discovery-slow (Reddit + TikTok + Pinterest every 24h)
    const slowQueue = new Queue("discovery-slow", { connection: getConnection() });

    await slowQueue.upsertJobScheduler(
      "discovery-slow-scheduled",
      { every: 24 * 60 * 60 * 1000 },  // every 24 hours
      { name: "discovery-slow", data: {} },
    );

    logger.info("Discovery SLOW job scheduled (Reddit + TikTok + Pinterest every 24h)");
    await slowQueue.close();
  } catch (err: any) {
    logger.warn({ err: err.message }, "Failed to schedule discovery jobs");
  }
}

// ── Voice portrait rebuild schedule ───────────────────────────────────────────
// Rebuild voice profiles for all active users every 7 days

export async function scheduleVoiceJobs(): Promise<void> {
  try {
    const voiceQueue = new Queue("voice-rebuild", { connection: getConnection() });
    await voiceQueue.upsertJobScheduler(
      "voice-rebuild-scheduled",
      { every: 7 * 24 * 60 * 60 * 1000 }, // every 7 days
      { name: "voice-rebuild", data: {} },
    );
    logger.info("Voice portrait jobs scheduled (weekly)");
    await voiceQueue.close();
  } catch (err: any) {
    logger.warn({ err: err.message }, "Failed to schedule voice jobs");
  }
}

// ── Weekly report pre-generation schedule ─────────────────────────────────────
// Every Monday at 05:30 IST (00:00 UTC) — pre-warm cache for all active users

export async function scheduleWeeklyReportJobs(): Promise<void> {
  try {
    const reportQueue = new Queue("weekly-report", { connection: getConnection() });
    await reportQueue.upsertJobScheduler(
      "weekly-report-scheduled",
      { every: 7 * 24 * 60 * 60 * 1000 }, // every 7 days
      { name: "weekly-report-generate", data: {} },
    );
    logger.info("Weekly report jobs scheduled (every 7 days)");
    await reportQueue.close();
  } catch (err: any) {
    logger.warn({ err: err.message }, "Failed to schedule weekly report jobs");
  }
}