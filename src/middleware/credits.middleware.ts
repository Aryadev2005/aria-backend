// src/middleware/credits.middleware.ts
// ══════════════════════════════════════════════════════════════════════════════
// Credit Gate — wraps every AI route
// Includes trial bypass logic for free users eligible for first-experience trials
// Usage: app.post('/generate', { preHandler: [authenticateFirebase, requireCredits('content_generation')] }, handler)
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import { checkCredits } from "../services/credits.service";
import { ActionKey } from "../config/credits";
import { errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types/user";
import {
  canUseTrial,
  TRIAL_TO_REAL,
  TrialAction,
} from "../services/firstExperience.service";

// Attach credit check result to request so handlers can access modelToUse
declare module "fastify" {
  interface FastifyRequest {
    creditCheck?: {
      featureCharge: number;
      modelToUse: string;
      actionKey: ActionKey;
      isTrial?: boolean; // true if using first-experience trial
      trialAction?: TrialAction; // which trial action is being used
    };
  }
}

export function requireCredits(actionKey: ActionKey) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user as User;
    if (!user) return errors.unauthorized(reply, "Not authenticated");

    const tier = user.subscription_tier ?? "free";

    // ── TRIAL BYPASS: Check if free user can use trial ────────────────────
    if (tier === "free") {
      // Find if this actionKey has a trial equivalent
      const trialEntry = Object.entries(TRIAL_TO_REAL).find(
        ([_, realKey]) => realKey === actionKey,
      );

      if (trialEntry) {
        const [trialAction] = trialEntry as [TrialAction, string];

        try {
          const trialCheck = await canUseTrial(user.id, trialAction);

          if (trialCheck.canUse) {
            // User can use trial — bypass credit check entirely
            logger.info(
              { userId: user.id, trialAction, actionKey },
              "Trial bypass granted",
            );

            req.creditCheck = {
              featureCharge: 0, // free trial
              modelToUse: "gpt-4o-mini", // trials always use mini
              actionKey,
              isTrial: true,
              trialAction,
            };
            return; // Bypass credit gate
          }

          if (trialCheck.alreadyUsed) {
            // Trial was already used — proceed to normal credit check
            logger.info(
              { userId: user.id, trialAction },
              "Trial already used, proceeding to credit check",
            );
          }
        } catch (err: any) {
          // Trial check failed — log and proceed to normal credit check (fail safe)
          logger.warn(
            { err: err.message, userId: user.id, trialAction },
            "Trial check failed, proceeding to credit check",
          );
        }
      }
    }

    // ── NORMAL CREDIT CHECK ────────────────────────────────────────────────
    const check = await checkCredits(user.id, tier, actionKey);

    if (!check.allowed) {
      logger.info(
        { userId: user.id, actionKey, reason: check.reason },
        "Credit check failed",
      );
      return reply.code(402).send({
        success: false,
        error: "INSUFFICIENT_CREDITS",
        message: check.reason,
        required: check.featureCharge,
        actionKey,
      });
    }

    // Attach to request so the handler knows which model to use
    req.creditCheck = {
      featureCharge: check.featureCharge,
      modelToUse: check.modelToUse,
      actionKey,
    };
  };
}

