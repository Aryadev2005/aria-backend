// src/config/queue.additions.ts
// ══════════════════════════════════════════════════════════════════════════════
// BullMQ queue definitions and schedulers for Hybrid RAG workers
//
// Two new queues:
// 1. embedding-queue   — embed new trends into pgvector
// 2. trajectory-queue  — update knowledge graph + trend trajectories
// ══════════════════════════════════════════════════════════════════════════════

import { Queue } from "bullmq";
import { getRedisClient } from "./redis";
import { logger } from "../utils/logger";

// ── Queue Instances ───────────────────────────────────────────────────────────

let embeddingQueue: Queue | null = null;
let trajectoryQueue: Queue | null = null;

function getConnection() {
  const client = getRedisClient();
  if (!client) return null;
  // BullMQ needs raw ioredis connection options, not the client itself
  return {
    host: new URL(process.env.REDIS_URL || "redis://localhost:6379").hostname,
    port: parseInt(
      new URL(process.env.REDIS_URL || "redis://localhost:6379").port || "6379",
    ),
  };
}

export function getEmbeddingQueue(): Queue | null {
  if (embeddingQueue) return embeddingQueue;
  const connection = getConnection();
  if (!connection) {
    logger.warn("Redis unavailable — embedding queue disabled");
    return null;
  }
  embeddingQueue = new Queue("embedding-queue", { connection });
  return embeddingQueue;
}

export function getTrajectoryQueue(): Queue | null {
  if (trajectoryQueue) return trajectoryQueue;
  const connection = getConnection();
  if (!connection) {
    logger.warn("Redis unavailable — trajectory queue disabled");
    return null;
  }
  trajectoryQueue = new Queue("trajectory-queue", { connection });
  return trajectoryQueue;
}

// ── Job Triggers ──────────────────────────────────────────────────────────────

/**
 * Trigger incremental embedding for specific trend IDs.
 * Called by trend.worker after inserting new trends.
 * Non-blocking — logs a warning if Redis is unavailable.
 */
export async function triggerIncrementalEmbed(
  trendIds: string[],
  niche: string,
): Promise<void> {
  try {
    const queue = getEmbeddingQueue();
    if (!queue) {
      logger.warn("Embedding queue unavailable — skipping embed trigger");
      return;
    }

    await queue.add(
      "embed-incremental",
      { trendIds, niche },
      {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      },
    );

    logger.info(
      { trendIds: trendIds.length, niche },
      "Incremental embed job queued",
    );
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Failed to queue embed job — non-critical",
    );
  }
}

/**
 * Trigger a full embedding refresh (re-embed all live trends).
 */
export async function triggerFullEmbed(): Promise<void> {
  try {
    const queue = getEmbeddingQueue();
    if (!queue) return;

    await queue.add(
      "embed-full",
      {},
      {
        removeOnComplete: 10,
        removeOnFail: 10,
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    logger.info("Full embed job queued");
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Failed to queue full embed job",
    );
  }
}

/**
 * Trigger trajectory + graph update.
 */
export async function triggerTrajectoryUpdate(
  mode: "incremental" | "full" = "incremental",
): Promise<void> {
  try {
    const queue = getTrajectoryQueue();
    if (!queue) return;

    await queue.add(
      `trajectory-${mode}`,
      { mode },
      {
        removeOnComplete: 10,
        removeOnFail: 10,
        attempts: 2,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    logger.info({ mode }, "Trajectory update job queued");
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Failed to queue trajectory job",
    );
  }
}

// ── Scheduled Jobs ────────────────────────────────────────────────────────────

/**
 * Schedule recurring embed + trajectory jobs.
 * Call this once during app startup (in your scheduler setup).
 */
export async function scheduleEmbedJobs(): Promise<void> {
  try {
    const embQueue = getEmbeddingQueue();
    const trajQueue = getTrajectoryQueue();

    if (embQueue) {
      // Full re-embed every 6 hours
      await embQueue.add(
        "embed-full-scheduled",
        {},
        {
          repeat: { pattern: "0 */6 * * *" }, // every 6 hours
          removeOnComplete: 5,
          removeOnFail: 5,
        },
      );
      logger.info("Scheduled: full embedding every 6 hours");
    }

    if (trajQueue) {
      // Daily incremental trajectory update
      await trajQueue.add(
        "trajectory-incremental-scheduled",
        { mode: "incremental" },
        {
          repeat: { pattern: "30 */4 * * *" }, // every 4 hours
          removeOnComplete: 5,
          removeOnFail: 5,
        },
      );

      // Weekly full graph rebuild
      await trajQueue.add(
        "trajectory-full-scheduled",
        { mode: "full" },
        {
          repeat: { pattern: "0 3 * * 0" }, // Sunday 3 AM
          removeOnComplete: 3,
          removeOnFail: 3,
        },
      );

      logger.info("Scheduled: trajectory updates (4h incremental, weekly full)");
    }
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Failed to schedule embed/trajectory jobs — will retry on next startup",
    );
  }
}
