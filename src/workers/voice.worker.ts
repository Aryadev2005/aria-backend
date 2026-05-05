// src/workers/voice.worker.ts
// ══════════════════════════════════════════════════════════════════════════════
// Voice Portrait Worker
//
// Runs weekly. Rebuilds voice portraits for all active users.
// "Active" = users who have had at least one ARIA conversation.
// ══════════════════════════════════════════════════════════════════════════════

import { Worker, Queue, type Job } from "bullmq";
import { prisma } from "../config/database";
import { logger } from "../utils/logger";

let worker: Worker | null = null;

function getConnection() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  return { host: parsed.hostname, port: parseInt(parsed.port || "6379") };
}

async function processJob(job: Job): Promise<{ built: number; skipped: number; failed: number }> {
  logger.info({ jobId: job.id }, "Voice portrait worker started");

  const { buildVoicePortrait } = await import("../services/voice.service");

  // Find users who need a rebuild
  const users = await (prisma as any).creator_voice_profiles.findMany({
    where: { next_rebuild_at: { lte: new Date() } },
    select: { user_id: true },
    take: 50, // Process max 50 per run to avoid overloading
  });

  // Also find users with no portrait at all but who have memory
  const usersWithMemory = await prisma.aria_memory.findMany({
    where: {
      // Not already in the above list
      user_id: { notIn: users.map((u: any) => u.user_id) },
    },
    select: { user_id: true },
    distinct: ["user_id"],
    take: 20,
  });

  const allUserIds = [
    ...users.map((u: any) => u.user_id),
    ...usersWithMemory.map(u => u.user_id),
  ];

  let built = 0, skipped = 0, failed = 0;

  for (const userId of allUserIds) {
    try {
      const portrait = await buildVoicePortrait(userId);
      if (portrait) {
        built++;
      } else {
        skipped++;
      }
      // Small delay to avoid hammering OpenAI
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      failed++;
      logger.warn({ err: err.message, userId }, "Voice portrait build failed for user");
    }
  }

  logger.info({ built, skipped, failed }, "Voice portrait worker complete");
  return { built, skipped, failed };
}

export async function startVoiceWorker(): Promise<Worker | null> {
  try {
    worker = new Worker("voice-rebuild", processJob, {
      connection:  getConnection(),
      concurrency: 1,
    });

    worker.on("completed", (job, result) => {
      logger.info({ jobId: job.id, ...result }, "Voice worker job completed");
    });

    worker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, err: err.message }, "Voice worker job failed");
    });

    logger.info("Voice portrait worker started");
    return worker;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Failed to start voice worker");
    return null;
  }
}

export async function stopVoiceWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
