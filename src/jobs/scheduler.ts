// src/jobs/scheduler.ts
// ══════════════════════════════════════════════════════════════════════════════
// ARIA Notification Scheduler
//
// Manages cron jobs:
// 1. Weekly Digest — every Monday at 8:00 AM IST (02:30 UTC)
// 2. Rival Watch — every 6 hours
// 3. Performance Feedback — every Sunday at midnight IST (18:30 UTC Saturday)
//
// All cron jobs must catch errors — failures must NOT crash the server
// ══════════════════════════════════════════════════════════════════════════════

import cron from "node-cron";
import { runWeeklyDigest } from "../services/digest.service";
import { runRivalWatchCheck } from "../services/rivalWatch.service";
import { runPerformanceFeedbackAll } from "../services/performanceFeedback.service";
import { logger } from "../utils/logger";

export function startScheduler(): void {
  // ── Weekly Digest — every Monday at 8:00 AM IST ─────────────────────────────
  // IST is UTC+5:30, so 8:00 AM IST = 02:30 UTC
  // Cron format: minute hour day-of-month month day-of-week
  // 30 2 * * 1 = minute 30, hour 2, any day-of-month, any month, Monday (1)
  cron.schedule("30 2 * * 1", async () => {
    logger.info("Starting weekly digest run");
    const startTime = Date.now();

    try {
      const result = await Promise.race([
        runWeeklyDigest(),
        new Promise<{ sent: number; failed: number; skipped: number }>(
          (_, reject) =>
            setTimeout(
              () => reject(new Error("Weekly digest timed out (30s)")),
              30_000,
            ),
        ),
      ]);

      const duration = Date.now() - startTime;
      logger.info(
        { ...result, durationMs: duration },
        "Weekly digest run complete",
      );
    } catch (err: any) {
      logger.error(
        { err: err?.message || err, durationMs: Date.now() - startTime },
        "Weekly digest run failed — will retry next week",
      );
    }
  });

  // ── Rival Watch — every 6 hours ─────────────────────────────────────────────
  // 0 */6 * * * = minute 0, hour 0/6/12/18, any day-of-month, any month, any day-of-week
  cron.schedule("0 */6 * * *", async () => {
    logger.info("Starting rival watch check");
    const startTime = Date.now();

    try {
      const result = await Promise.race([
        runRivalWatchCheck(),
        new Promise<{ notified: number; checked: number }>(
          (_, reject) =>
            setTimeout(
              () => reject(new Error("Rival watch check timed out (30s)")),
              30_000,
            ),
        ),
      ]);

      const duration = Date.now() - startTime;
      logger.info(
        { ...result, durationMs: duration },
        "Rival watch check complete",
      );
    } catch (err: any) {
      logger.error(
        { err: err?.message || err, durationMs: Date.now() - startTime },
        "Rival watch check failed — will retry in 6 hours",
      );
    }
  });

  // ── Performance Feedback — every Sunday at midnight IST ──────────────────────
  // IST is UTC+5:30, so midnight IST = 18:30 UTC Saturday
  // Cron format: minute hour day-of-month month day-of-week
  // 30 18 * * 6 = minute 30, hour 18, any day-of-month, any month, Saturday (6)
  cron.schedule("30 18 * * 6", async () => {
    logger.info("Starting performance feedback run");
    const startTime = Date.now();

    try {
      await Promise.race([
        runPerformanceFeedbackAll(),
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("Performance feedback run timed out (5m)")),
            5 * 60_000,
          ),
        ),
      ]);

      const duration = Date.now() - startTime;
      logger.info(
        { durationMs: duration },
        "Performance feedback run complete",
      );
    } catch (err: any) {
      logger.error(
        { err: err?.message || err, durationMs: Date.now() - startTime },
        "Performance feedback run failed — will retry next week",
      );
    }
  });

  logger.info(
    "Scheduler started: weekly digest (Mon 8AM IST) + rival watch (every 6h) + performance feedback (Sun midnight IST)",
  );
}
