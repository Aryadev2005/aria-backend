// src/controllers/trials.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// First Experience Trials Controller
// Manages trial eligibility checks and status endpoints
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types/user";
import {
  TRIAL_ACTIONS,
  canUseTrial,
  TRIAL_TO_REAL,
  markTrialAsUsed,
  convertTrial,
} from "../services/firstExperience.service";

// ── GET /api/v1/trials/status ─────────────────────────────────────────────────
// Returns trial eligibility status for all 3 core features
export const getTrialStatus = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    const tier = user.subscription_tier ?? "free";
    const results: Record<string, any> = {};

    // Check each trial action
    for (const action of TRIAL_ACTIONS) {
      const check = await canUseTrial(user.id, action);
      const realAction = TRIAL_TO_REAL[action as keyof typeof TRIAL_TO_REAL];

      results[action] = {
        canUse: check.canUse && tier === "free",
        alreadyUsed: check.alreadyUsed,
        realAction: realAction,
        label:
          action === "rival_spy_trial"
            ? "Rival Spy"
            : action === "studio_trial"
              ? "Script Generation"
              : "Video DNA Analysis",
      };
    }

    return success(reply, {
      tier,
      trials: results,
      message:
        "Check eligibility for each trial — free users get 1 free use per feature",
    });
  } catch (err: any) {
    logger.error(
      { err: err?.message || err, userId: user.id },
      "Failed to fetch trial status",
    );
    return errors.internal(reply);
  }
};

// ── POST /api/v1/trials/mark-used ─────────────────────────────────────────────
// Called by the frontend after a trial completes to mark it as used
export const markTrialUsed = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { action, resultData } = req.body as {
    action: string;
    resultData?: Record<string, any>;
  };

  try {
    // Validate action is one of our trials
    if (!TRIAL_ACTIONS.includes(action as any)) {
      return errors.badRequest(
        reply,
        `Invalid trial action: ${action}. Must be one of: ${TRIAL_ACTIONS.join(", ")}`,
      );
    }

    // Mark trial as used
    await markTrialAsUsed(user.id, action as any, resultData);

    logger.info(
      { userId: user.id, action },
      "Trial marked as used",
    );

    return success(reply, {
      action,
      marked: true,
      message: "Trial marked as used. Next use requires credits.",
    });
  } catch (err: any) {
    logger.error(
      { err: err?.message || err, userId: user.id, action },
      "Failed to mark trial as used",
    );
    return errors.internal(reply);
  }
};

// ── POST /api/v1/trials/convert ───────────────────────────────────────────────
// Called when a free trial user upgrades to Pro — converts all trials to "converted"
export const convertTrialsOnUpgrade = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    const tier = user.subscription_tier ?? "free";

    if (tier === "free") {
      return errors.badRequest(
        reply,
        "Can only convert trials on paid subscription",
      );
    }

    // Convert all used trials to "converted"
    const result = await convertTrial(user.id);

    logger.info(
      { userId: user.id, converted: result },
      "Trials converted on upgrade",
    );

    return success(reply, {
      converted: result,
      message: `${result} trials marked as converted`,
    });
  } catch (err: any) {
    logger.error(
      { err: err?.message || err, userId: user.id },
      "Failed to convert trials",
    );
    return errors.internal(reply);
  }
};
