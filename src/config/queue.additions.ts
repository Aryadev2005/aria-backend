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
// Global TikTok + Pinterest + Google Trends scrape every 3 hours

export async function scheduleDiscoveryJobs(): Promise<void> {
  try {
    const discoveryQueue = new Queue("discovery-queue", { connection: getConnection() });

    await discoveryQueue.upsertJobScheduler(
      "discovery-global-scheduled",
      { every: 3 * 60 * 60 * 1000 },  // every 3 hours
      { name: "discovery-global", data: {} },
    );

    logger.info("Discovery jobs scheduled (every 3h)");
    await discoveryQueue.close();
  } catch (err: any) {
    logger.warn({ err: err.message }, "Failed to schedule discovery jobs");
  }
}
