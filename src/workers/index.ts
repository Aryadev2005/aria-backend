// src/workers/index.ts
// ══════════════════════════════════════════════════════════════════════════════
// Worker orchestrator — starts and stops all BullMQ workers
// ══════════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import { logger } from "../utils/logger";
import { startEmbeddingWorker,  stopEmbeddingWorker  } from "./embedding.worker";
import { startTrajectoryWorker, stopTrajectoryWorker } from "./trajectory.worker";
import { startSongWorker,       stopSongWorker       } from "./song.worker";
import { startDiscoveryWorker,  stopDiscoveryWorker  } from "./discovery.worker";
import { startVoiceWorker,      stopVoiceWorker      } from "./voice.worker";
import { scheduleEmbedJobs, scheduleSongJobs, scheduleDiscoveryJobs, scheduleVoiceJobs } from "../config/queue.additions";

const workers: any[] = [];

export const startAllWorkers = async () => {
  logger.info("Starting all workers...");

  try {
    const embeddingWorker = await startEmbeddingWorker();
    if (embeddingWorker) workers.push(embeddingWorker);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Embedding worker failed to start");
  }

  try {
    const trajectoryWorker = await startTrajectoryWorker();
    if (trajectoryWorker) workers.push(trajectoryWorker);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Trajectory worker failed to start");
  }

  try {
    const songWorker = await startSongWorker();
    if (songWorker) workers.push(songWorker);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Song worker failed to start");
  }

  try {
    const discoveryWorker = await startDiscoveryWorker();
    if (discoveryWorker) workers.push(discoveryWorker);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Discovery worker (fast) failed to start");
  }

  // Start a second worker for the slow discovery queue
  try {
    const { Worker } = await import("bullmq");
    const { processSlowJob } = await import("./discovery.worker");
    const url    = process.env.REDIS_URL || "redis://localhost:6379";
    const parsed = new URL(url);
    const conn   = { host: parsed.hostname, port: parseInt(parsed.port || "6379") };

    const slowWorker = new Worker("discovery-slow", processSlowJob, {
      connection: conn,
      concurrency: 1,
      lockDuration: 1800000,    // 30 min
      stalledInterval: 300000,
      maxStalledCount: 1,
    });

    slowWorker.on("completed", (job, result) => {
      logger.info({ jobId: job.id, jobName: job.name, ...result }, "Discovery slow job completed");
    });

    slowWorker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, jobName: job?.name, err: err.message }, "Discovery slow job failed");
    });

    workers.push(slowWorker);
    logger.info("Discovery slow worker started");
  } catch (err: any) {
    logger.warn({ err: err.message }, "Discovery slow worker failed to start");
  }

  try {
    const voiceWorker = await startVoiceWorker();
    if (voiceWorker) workers.push(voiceWorker);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Voice worker failed to start");
  }

  // Schedule recurring jobs
  await scheduleEmbedJobs();
  await scheduleSongJobs();
  await scheduleDiscoveryJobs();
  await scheduleVoiceJobs();

  logger.info({ workerCount: workers.length }, "All workers started");
};

export const stopAllWorkers = async () => {
  logger.info("Stopping all workers...");
  await Promise.allSettled([
    stopEmbeddingWorker(),
    stopTrajectoryWorker(),
    stopSongWorker(),
    stopDiscoveryWorker(),
    stopVoiceWorker(),
  ]);
  logger.info("All workers stopped");
};

// Run directly if invoked as a script
if (process.argv[1]?.includes("workers/index")) {
  startAllWorkers().catch((err) => {
    logger.error({ err }, "Worker startup failed");
    process.exit(1);
  });

  process.on("SIGINT",  async () => { await stopAllWorkers(); process.exit(0); });
  process.on("SIGTERM", async () => { await stopAllWorkers(); process.exit(0); });
}
