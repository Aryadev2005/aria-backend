// src/services/firstExperience.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// First Experience Trial System
//
// Grants free users one-time access to 3 core features before they subscribe:
// - Rival Spy Trial: 1 session analyzing 3 handles
// - Studio Trial: 1 full script generation
// - Video DNA Trial: 1 video analysis
//
// Once used, a trial is marked in the database forever. If user upgrades to Pro,
// trials are marked as "converted" for analytics.
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";

export const TRIAL_ACTIONS = [
  "rival_spy_trial",
  "studio_trial",
  "video_dna_trial",
] as const;

export type TrialAction = typeof TRIAL_ACTIONS[number];

/**
 * Map trial action key → real credit_config action_key
 * Used for validation and credit deduction
 */
export const TRIAL_TO_REAL: Record<TrialAction, string> = {
  rival_spy_trial: "rival_spy",
  studio_trial: "script_writing",
  video_dna_trial: "video_analysis",
};

// ── Check Trial Eligibility ──────────────────────────────────────────────────

/**
 * Check if a free user can perform this trial action
 *
 * Rules:
 * - User must be on 'free' subscription tier
 * - Trial action must not have been used before (no row in first_experience_usage)
 *
 * Returns:
 * - canUse: true if eligible for trial
 * - alreadyUsed: true if trial was already consumed
 * - reason: explanation if cannot use
 */
export async function canUseTrial(
  userId: string,
  action: TrialAction,
): Promise<{
  canUse: boolean;
  alreadyUsed: boolean;
  reason?: string;
}> {
  try {
    // Check user's subscription tier
    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: { subscription_tier: true },
    });

    if (!user) {
      logger.warn({ userId }, "User not found for trial check");
      return { canUse: true, alreadyUsed: false }; // Fail open
    }

    // Non-free users use normal credits
    if (user.subscription_tier !== "free") {
      return {
        canUse: false,
        alreadyUsed: false,
        reason: "Not on free tier",
      };
    }

    // Check if trial already used
    const used = await prisma.first_experience_usage.findUnique({
      where: {
        user_id_action_key: {
          user_id: userId,
          action_key: action,
        },
      },
      select: { id: true },
    });

    if (used) {
      return {
        canUse: false,
        alreadyUsed: true,
        reason: "Trial already used",
      };
    }

    return { canUse: true, alreadyUsed: false };
  } catch (err: any) {
    // Fail open — don't block users if check fails
    logger.warn(
      { err: err.message, userId, action },
      "Trial check failed, allowing access",
    );
    return { canUse: true, alreadyUsed: false };
  }
}

// ── Mark Trial as Used ───────────────────────────────────────────────────────

/**
 * Mark a trial action as used (called AFTER successful completion)
 * Non-fatal — called in background, never blocks response
 */
export async function markTrialUsed(
  userId: string,
  action: TrialAction,
  resultData?: object,
): Promise<void> {
  try {
    await prisma.first_experience_usage.upsert({
      where: {
        user_id_action_key: {
          user_id: userId,
          action_key: action,
        },
      },
      create: {
        user_id: userId,
        action_key: action,
        result_data: resultData || null,
      },
      update: {
        result_data: resultData || null,
      },
    });

    // Invalidate cache
    await cache.del(`trial_status:${userId}`).catch(() => {});

    logger.info({ userId, action }, "Trial marked as used");
  } catch (err: any) {
    // Non-fatal — log and continue
    logger.warn(
      { err: err.message, userId, action },
      "Failed to mark trial as used",
    );
  }
}

// ── Get Trial Status ─────────────────────────────────────────────────────────

/**
 * Get full trial status for a user (used by frontend)
 * Returns which trials have been used and when
 */
export async function getTrialStatus(userId: string): Promise<{
  rival_spy_trial: { used: boolean; usedAt?: string };
  studio_trial: { used: boolean; usedAt?: string };
  video_dna_trial: { used: boolean; usedAt?: string };
  allUsed: boolean;
  convertedToPro: boolean;
}> {
  try {
    // Check cache first
    const cached = await cache.get(`trial_status:${userId}`);
    if (cached) return cached;

    // Fetch from DB
    const usageRows = await prisma.first_experience_usage.findMany({
      where: { user_id: userId },
      select: {
        action_key: true,
        used_at: true,
        converted_to_pro: true,
      },
    });

    const status = {
      rival_spy_trial: { used: false, usedAt: undefined },
      studio_trial: { used: false, usedAt: undefined },
      video_dna_trial: { used: false, usedAt: undefined },
      allUsed: false,
      convertedToPro: false,
    };

    for (const row of usageRows) {
      const key = row.action_key as TrialAction;
      if (status[key]) {
        status[key].used = true;
        status[key].usedAt = row.used_at?.toISOString();
      }
      if (row.converted_to_pro) {
        status.convertedToPro = true;
      }
    }

    status.allUsed =
      status.rival_spy_trial.used &&
      status.studio_trial.used &&
      status.video_dna_trial.used;

    // Cache for 5 minutes
    await cache.set(`trial_status:${userId}`, status, 300).catch(() => {});

    return status;
  } catch (err: any) {
    logger.warn({ err: err.message, userId }, "Failed to get trial status");
    // Return default (all unused)
    return {
      rival_spy_trial: { used: false },
      studio_trial: { used: false },
      video_dna_trial: { used: false },
      allUsed: false,
      convertedToPro: false,
    };
  }
}

// ── Mark Trials as Converted ─────────────────────────────────────────────────

/**
 * When user upgrades to Pro, mark all their trials as converted
 * Used for analytics to track conversion funnels
 */
export async function markTrialsConverted(userId: string): Promise<void> {
  try {
    await prisma.first_experience_usage.updateMany({
      where: { user_id: userId },
      data: {
        converted_to_pro: true,
        converted_at: new Date(),
      },
    });

    // Invalidate cache
    await cache.del(`trial_status:${userId}`).catch(() => {});

    logger.info({ userId }, "Trials marked as converted");
  } catch (err: any) {
    // Non-fatal
    logger.warn({ err: err.message, userId }, "Failed to mark trials converted");
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Get a specific trial result (if stored)
 */
export async function getTrialResult(
  userId: string,
  action: TrialAction,
): Promise<object | null> {
  try {
    const row = await prisma.first_experience_usage.findUnique({
      where: {
        user_id_action_key: {
          user_id: userId,
          action_key: action,
        },
      },
      select: { result_data: true },
    });

    return row?.result_data || null;
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId, action },
      "Failed to get trial result",
    );
    return null;
  }
}

/**
 * Check if ANY trial is still available for a user
 */
export async function hasAvailableTrial(userId: string): Promise<boolean> {
  try {
    const status = await getTrialStatus(userId);
    return !status.allUsed;
  } catch (err: any) {
    logger.warn({ err: err.message, userId }, "Failed to check available trial");
    return false; // Assume no trial available
  }
}
