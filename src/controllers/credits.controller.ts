// src/controllers/credits.controller.ts

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
import { TOPUP_PACKS, PLAN_CREDITS } from "../config/credits";
import { prisma } from "../config/database";

// GET /api/v1/credits/wallet
export const getWallet = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const tier = user.subscription_tier ?? "free";

  try {
    const [summary, recentTx] = await Promise.all([
      getWalletSummary(user.id, tier),
      getTransactionHistory(user.id, 10, 0),
    ]);

    return success(reply, {
      wallet: summary,
      plan: tier,
      planLimit: PLAN_CREDITS[tier] ?? 50,
      recentTransactions: recentTx,
      topupPacks: TOPUP_PACKS,
    });
  } catch (err) {
    logger.error({ err }, "Get wallet failed");
    return errors.internal(reply);
  }
};

// GET /api/v1/credits/history?limit=20&offset=0
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

    return success(reply, { transactions, total, limit, offset });
  } catch (err) {
    logger.error({ err }, "Get history failed");
    return errors.internal(reply);
  }
};

// GET /api/v1/credits/packs
export const getPacks = async (_req: FastifyRequest, reply: FastifyReply) => {
  return success(reply, { packs: TOPUP_PACKS });
};

// POST /api/v1/credits/topup  — called after Razorpay payment verified
export const buyTopup = async (
  req: FastifyRequest<{ Body: { packId: string; paymentId: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { packId, paymentId } = req.body;

  const pack = TOPUP_PACKS.find((p) => p.id === packId);
  if (!pack) return reply.code(400).send({ error: "Invalid pack" });

  try {
    // TODO: verify paymentId with Razorpay before processing
    // For now, trust the client (add Razorpay verification before production)
    await processTopup(
      user.id,
      packId,
      pack.credits,
      pack.amountInr,
      paymentId,
    );

    return success(reply, {
      message: `${pack.credits} credits added to your wallet`,
      credits: pack.credits,
      amountInr: pack.amountInr,
    });
  } catch (err) {
    logger.error({ err }, "Topup failed");
    return errors.internal(reply);
  }
};

// POST /api/v1/credits/admin/reset  — internal use only, protected by admin check
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

// POST /api/v1/credits/admin/grant
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

// POST /api/v1/credits/admin/flush-cache
export const adminFlushCache = async (
  _req: FastifyRequest,
  reply: FastifyReply,
) => {
  await flushConfigCache();
  return success(reply, { message: "Credit config cache flushed" });
};
