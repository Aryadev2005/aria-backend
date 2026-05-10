// src/middleware/credits.middleware.ts
// ══════════════════════════════════════════════════════════════════════════════
// Credit Gate — wraps every AI route
// Usage: app.post('/generate', { preHandler: [authenticateFirebase, requireCredits('content_generation')] }, handler)
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import { checkCredits } from "../services/credits.service";
import { ActionKey } from "../config/credits";
import { errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types/user";

// Attach credit check result to request so handlers can access modelToUse
declare module "fastify" {
  interface FastifyRequest {
    creditCheck?: {
      cost: number;
      modelToUse: string;
      actionKey: ActionKey;
    };
  }
}

export function requireCredits(actionKey: ActionKey) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user as User;
    if (!user) return errors.unauthorized(reply, "Not authenticated");

    const tier = user.subscription_tier ?? "free";

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
        balance: check.balance,
        required: check.cost,
        actionKey,
      });
    }

    // Attach to request so the handler knows which model to use
    req.creditCheck = {
      cost: check.cost,
      modelToUse: check.modelToUse,
      actionKey,
    };
  };
}
