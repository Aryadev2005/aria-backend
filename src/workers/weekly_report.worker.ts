// src/workers/weekly_report.worker.ts
// ══════════════════════════════════════════════════════════════════════════════
// Weekly Report Worker
//
// Runs every Monday at 05:30 IST (00:00 UTC).
// Pre-generates weekly performance reports for all active users so the
// analytics endpoint is instant on first access.
// ══════════════════════════════════════════════════════════════════════════════

import { Worker, type Job } from 'bullmq';
import { logger } from '../utils/logger';

let worker: Worker | null = null;

function getConnection() {
  const url    = process.env.REDIS_URL || 'redis://localhost:6379';
  const parsed = new URL(url);
  return { host: parsed.hostname, port: parseInt(parsed.port || '6379') };
}

async function processJob(job: Job): Promise<{ generated: number; failed: number }> {
  logger.info({ jobId: job.id }, 'Weekly report worker started');

  const { preGenerateForActiveUsers } = await import('../services/weeklyReport.service');
  const result = await preGenerateForActiveUsers();

  logger.info({ jobId: job.id, ...result }, 'Weekly report worker complete');
  return result;
}

export async function startWeeklyReportWorker(): Promise<Worker | null> {
  try {
    worker = new Worker('weekly-report', processJob, {
      connection:  getConnection(),
      concurrency: 1,
    });

    worker.on('completed', (job, result) => {
      logger.info({ jobId: job.id, ...result }, 'Weekly report job completed');
    });

    worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, err: err.message }, 'Weekly report job failed');
    });

    logger.info('Weekly report worker started');
    return worker;
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to start weekly report worker');
    return null;
  }
}

export async function stopWeeklyReportWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
