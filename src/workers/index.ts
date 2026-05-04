// src/workers/index.ts
// ══════════════════════════════════════════════════════════════════════════════
// Worker orchestrator — starts and stops all BullMQ workers
// ══════════════════════════════════════════════════════════════════════════════

import { logger } from "../utils/logger";
import { startEmbeddingWorker, stopEmbeddingWorker } from "./embedding.worker";
import { startTrajectoryWorker, stopTrajectoryWorker } from "./trajectory.worker";
import { scheduleEmbedJobs } from "../config/queue.additions";

const workers: any[] = [];

export const startAllWorkers = async () => {
  logger.info("Starting all workers...");

  try {
    const embeddingWorker = await startEmbeddingWorker();
    workers.push(embeddingWorker);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Embedding worker failed to start");
  }

  try {
    const trajectoryWorker = await startTrajectoryWorker();
    workers.push(trajectoryWorker);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Trajectory worker failed to start");
  }

  // Schedule recurring jobs
  await scheduleEmbedJobs();

  logger.info({ workerCount: workers.length }, "All workers started");
};

export const stopAllWorkers = async () => {
  logger.info("Stopping all workers...");
  await stopEmbeddingWorker();
  await stopTrajectoryWorker();
  logger.info("All workers stopped");
};

// Run directly if invoked as a script
if (process.argv[1]?.includes("workers/index")) {
  startAllWorkers().catch((err) => {
    logger.error({ err }, "Worker startup failed");
    process.exit(1);
  });

  process.on("SIGINT", async () => {
    await stopAllWorkers();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await stopAllWorkers();
    process.exit(0);
  });
}
