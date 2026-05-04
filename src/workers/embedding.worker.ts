// src/workers/embedding.worker.ts
// ══════════════════════════════════════════════════════════════════════════════
// BullMQ Worker: Embed new trend signals into pgvector
//
// Jobs:
//   embed-incremental  — embed specific trend IDs (triggered after scrape)
//   embed-full         — re-embed all live trends (scheduled every 6h)
// ══════════════════════════════════════════════════════════════════════════════

import { Worker, type Job } from "bullmq";
import { logger } from "../utils/logger";

let worker: Worker | null = null;

function getConnection() {
  return {
    host: new URL(process.env.REDIS_URL || "redis://localhost:6379").hostname,
    port: parseInt(
      new URL(process.env.REDIS_URL || "redis://localhost:6379").port || "6379",
    ),
  };
}

async function processJob(job: Job): Promise<void> {
  const startTime = Date.now();

  try {
    // Late import to avoid circular dependencies
    const { embedTrends, embedAllTrends } = await import(
      "../services/vector/embedding.service"
    );

    if (
      job.name === "embed-incremental" ||
      job.name === "embed-incremental-scheduled"
    ) {
      const { trendIds, niche } = job.data;
      if (!trendIds?.length) {
        logger.warn("Embed job received empty trendIds — skipping");
        return;
      }

      const count = await embedTrends(trendIds);
      const duration = Date.now() - startTime;
      logger.info(
        { count, niche, duration },
        "Incremental embedding complete",
      );
    } else if (
      job.name === "embed-full" ||
      job.name === "embed-full-scheduled"
    ) {
      const count = await embedAllTrends();
      const duration = Date.now() - startTime;
      logger.info({ count, duration }, "Full embedding complete");
    } else {
      logger.warn({ jobName: job.name }, "Unknown embedding job type");
    }
  } catch (err: any) {
    logger.error({ err: err.message, jobName: job.name }, "Embedding job failed");
    throw err; // BullMQ will retry based on job config
  }
}

export async function startEmbeddingWorker(): Promise<Worker> {
  const connection = getConnection();

  worker = new Worker("embedding-queue", processJob, {
    connection,
    concurrency: 2,
    limiter: {
      max: 10,
      duration: 60000, // max 10 jobs per minute (Groq rate limit)
    },
  });

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, jobName: job.name }, "Embedding job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, err: err.message },
      "Embedding job failed",
    );
  });

  logger.info("Embedding worker started");
  return worker;
}

export async function stopEmbeddingWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("Embedding worker stopped");
  }
}
