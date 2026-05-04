// src/workers/trajectory.worker.ts
// BullMQ Worker: Build knowledge graph + update trend trajectories

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
    const { updateTrajectoriesFromLiveTrends } = await import(
      "../services/graph/knowledge-graph.service"
    );
    const { invalidateAllHotWindows } = await import(
      "../services/retrieval/hybrid-rag.service"
    );
    const mode = job.data?.mode || "incremental";
    const updated = await updateTrajectoriesFromLiveTrends();
    if (mode === "full") await invalidateAllHotWindows();
    logger.info({ updated, mode, duration: Date.now() - startTime }, "Trajectory update complete");
  } catch (err: any) {
    logger.error({ err: err.message, jobName: job.name }, "Trajectory job failed");
    throw err;
  }
}

export async function startTrajectoryWorker(): Promise<Worker> {
  worker = new Worker("trajectory-queue", processJob, {
    connection: getConnection(),
    concurrency: 1,
  });
  worker.on("completed", (job) => logger.info({ jobId: job.id }, "Trajectory job completed"));
  worker.on("failed", (job, err) => logger.error({ jobId: job?.id, err: err.message }, "Trajectory job failed"));
  logger.info("Trajectory worker started");
  return worker;
}

export async function stopTrajectoryWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; logger.info("Trajectory worker stopped"); }
}
