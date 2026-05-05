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
  const { invalidateRoadmapCache } = await import("../services/roadmap.service");

  // ── Find users with stale voice portraits ─────────────────────────────────
  const staleProfiles = await (prisma as any).creator_voice_profiles.findMany({
    where: { next_rebuild_at: { lte: new Date() } },
    select: { user_id: true, built_at: true },
    take: 50,
  });

  // ── Find users who have accumulated 8+ new memories since last voice build ────
  // These users get a rebuild even if their schedule hasn't hit yet
  let earlyRebuildCandidates: { user_id: string }[] = [];
  try {
    earlyRebuildCandidates = await prisma.$queryRawUnsafe<{ user_id: string }[]>(`
      SELECT DISTINCT am.user_id
      FROM aria_memory am
      JOIN creator_voice_profiles cvp ON cvp.user_id = am.user_id
      WHERE am.created_at > cvp.built_at
      GROUP BY am.user_id, cvp.built_at
      HAVING COUNT(*) >= 8
    `);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Early rebuild query failed — table may not exist yet or migration pending");
  }

  // ── Find users with memory but no portrait at all ─────────────────────────────
  const usersWithNoPortrait = await prisma.aria_memory.findMany({
    where: {
      user_id: {
        notIn: [
          ...staleProfiles.map((u: any) => u.user_id),
          ...earlyRebuildCandidates.map((u: any) => u.user_id),
        ].filter(Boolean),
      },
    },
    select:   { user_id: true },
    distinct: ['user_id'],
    take:     20,
  });

  // Deduplicate all user IDs
  const seen = new Set<string>();
  const allUserIds: string[] = [];

  for (const u of [...staleProfiles, ...earlyRebuildCandidates, ...usersWithNoPortrait]) {
    const id = (u as any).user_id;
    if (id && !seen.has(id)) {
      seen.add(id);
      allUserIds.push(id);
    }
  }

  logger.info({
    stale:         staleProfiles.length,
    earlyRebuild:  earlyRebuildCandidates.length,
    noPortrait:    usersWithNoPortrait.length,
    total:         allUserIds.length,
  }, "Voice portrait rebuild candidates");

  let built = 0, skipped = 0, failed = 0;

  for (const userId of allUserIds) {
    try {
      const portrait = await buildVoicePortrait(userId);
      if (portrait) {
        built++;
        // Bust roadmap cache so next fetch uses new voice portrait
        await invalidateRoadmapCache(userId);
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
