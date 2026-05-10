// src/controllers/credits.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// ARIA Credits Controller
// IMPORTANT: This controller NEVER returns raw credit numbers to the frontend.
// Everything is expressed as percentages (usedPct, remainingPct) or labels.
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types/user";
import {
  getWalletSummary,
  getTransactionHistory,
  processTopup,
  grantCredits,
  resetMonthlyCredits,
  flushConfigCache,
} from "../services/credits.service";
import {
  TOPUP_PACKS,
  PLAN_PRICES_INR,
  PLAN_LABELS,
  PLAN_MULTIPLIERS,
} from "../config/credits";
import { prisma } from "../config/database";

// ── GET /api/v1/credits/wallet ────────────────────────────────────────────────
// Returns percentage-based summary — raw credits NEVER exposed.
export const getWallet = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const tier = user.subscription_tier ?? "free";

  try {
    const summary = await getWalletSummary(user.id, tier);

    return success(reply, {
      // ── What frontend renders ──────────────────────────────────────────────
      usedPct: summary.usedPct, // e.g. 34.7  → "34.7% used"
      remainingPct: summary.remainingPct, // e.g. 65.3

      // ── Plan metadata ─────────────────────────────────────────────────────
      plan: tier,
      planLabel: summary.planLabel, // "Pro"
      planMultiplier: summary.planMultiplier, // "15× the free plan"
      planPriceInr: PLAN_PRICES_INR[tier] ?? 0,

      // ── Breakdown pcts (for the detail modal) ─────────────────────────────
      planUsedPct: summary.planUsedPct, // % of monthly plan used
      rolloverPct: summary.rolloverPct, // % added from rollover
      topupPct: summary.topupPct, // % added from top-ups

      // ── Usage stats (non-credit numbers are fine) ─────────────────────────
      totalActionsCount: summary.totalActionsCount,
      nextResetAt: summary.nextResetAt,
      lastResetAt: summary.lastResetAt,

      // ── Top-up packs (for upsell in settings) ─────────────────────────────
      topupPacks: TOPUP_PACKS,
    });
  } catch (err) {
    logger.error({ err }, "Get wallet failed");
    return errors.internal(reply);
  }
};

// ── GET /api/v1/credits/history?limit=20&offset=0 ────────────────────────────
// Returns transaction log — types and descriptions only, no raw amounts.
export const getHistory = async (
  req: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const limit = Math.min(parseInt(req.query.limit ?? "20"), 100);
  const offset = parseInt(req.query.offset ?? "0");

  try {
    const [transactions, total] = await Promise.all([
      getTransactionHistory(user.id, limit, offset),
      prisma.credit_transactions.count({ where: { user_id: user.id } }),
    ]);

    // Shape each transaction for the frontend:
    // - type: 'debit' | 'grant' | 'topup' | 'rollover'
    // - description: human-readable string
    // - costLabel: "~2% of plan" instead of raw credits
    const tier = (req.user as User).subscription_tier ?? "free";
    const { PLAN_CREDITS } = await import("../config/credits");
    const planLimit = PLAN_CREDITS[tier] ?? PLAN_CREDITS.free;

    const shaped = transactions.map((tx: any) => {
      const meta = tx.metadata ?? {};
      const rawAmount = Math.abs(meta.total_debited ?? 0);
      const costPct =
        planLimit > 0 ? Math.round((rawAmount / planLimit) * 1000) / 10 : 0;

      return {
        id: tx.id,
        type: tx.type,
        action_key: tx.action_key,
        description: tx.description,
        created_at: tx.created_at,
        // Show cost as "~1.2% of plan" for debits, suppress for grants/topups
        costLabel: tx.type === "debit" ? `~${costPct}% of plan` : null,
        // Feature vs AI breakdown for power users
        featureCharge:
          meta.feature_charge != null
            ? `${(meta.feature_charge as number).toFixed(1)}`
            : null,
        aiCharge:
          meta.ai_charge != null
            ? `${(meta.ai_charge as number).toFixed(2)}`
            : null,
      };
    });

    return success(reply, { transactions: shaped, total, limit, offset });
  } catch (err) {
    logger.error({ err }, "Get history failed");
    return errors.internal(reply);
  }
};

// ── GET /api/v1/credits/packs ─────────────────────────────────────────────────
export const getPacks = async (_req: FastifyRequest, reply: FastifyReply) => {
  return success(reply, { packs: TOPUP_PACKS });
};

// ── POST /api/v1/credits/topup ────────────────────────────────────────────────
// Legacy endpoint — prefer /razorpay/verify for production.
export const buyTopup = async (
  req: FastifyRequest<{ Body: { packId: string; paymentId: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { packId, paymentId } = req.body;

  const pack = TOPUP_PACKS.find((p) => p.id === packId);
  if (!pack) return reply.code(400).send({ error: "Invalid pack" });

  try {
    await processTopup(
      user.id,
      packId,
      pack.credits,
      pack.amountInr,
      paymentId,
    );
    // Return new wallet summary after topup
    const summary = await getWalletSummary(
      user.id,
      user.subscription_tier ?? "free",
    );
    return success(reply, {
      message: `Top-up successful`,
      usedPct: summary.usedPct,
      remainingPct: summary.remainingPct,
    });
  } catch (err) {
    logger.error({ err }, "Topup failed");
    return errors.internal(reply);
  }
};

// ── POST /api/v1/credits/admin/reset ─────────────────────────────────────────
export const adminReset = async (
  req: FastifyRequest<{ Body: { userId: string; tier: string } }>,
  reply: FastifyReply,
) => {
  const { userId, tier } = req.body;
  try {
    await resetMonthlyCredits(userId, tier);
    return success(reply, { message: "Credits reset" });
  } catch (err) {
    return errors.internal(reply);
  }
};

// ── POST /api/v1/credits/admin/grant ─────────────────────────────────────────
export const adminGrant = async (
  req: FastifyRequest<{
    Body: { userId: string; amount: number; reason: string };
  }>,
  reply: FastifyReply,
) => {
  const { userId, amount, reason } = req.body;
  try {
    await grantCredits(userId, amount, reason);
    return success(reply, { message: `Granted ${amount} credits` });
  } catch (err) {
    return errors.internal(reply);
  }
};

// ── POST /api/v1/credits/admin/flush-cache ───────────────────────────────────
export const adminFlushCache = async (
  _req: FastifyRequest,
  reply: FastifyReply,
) => {
  await flushConfigCache();
  return success(reply, { message: "Credit config cache flushed" });
};
