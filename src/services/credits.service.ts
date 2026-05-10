// src/services/credits.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// TrendAI Credit Engine
// Handles: wallet creation, balance checks, debits, grants, monthly resets,
//          top-up processing, config loading from DB with fallback
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import {
  ActionKey,
  ActionConfig,
  DEFAULT_ACTION_CONFIGS,
  PLAN_CREDITS,
  isTierAllowed,
  resolveModel,
  calculateOpenAICost,
  usdToCredits,
} from "../config/credits";

const CONFIG_CACHE_KEY = "credit_config:all";
const CONFIG_TTL = 300; // 5 min — config changes are not instant but close
const WALLET_TTL = 60; // 1 min — balance changes need to be fresh

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreditCheckResult {
  allowed: boolean;
  reason?: string; // human-readable block reason
  balance: number;
  cost: number;
  modelToUse: string;
  config: ActionConfig;
}

export interface DebitResult {
  success: boolean;
  balanceAfter: number;
  modelUsed: string;
  transactionId: string;
}

export interface WalletSummary {
  balance: number;
  planCredits: number;
  rolloverCredits: number;
  topupCredits: number;
  totalGranted: number;
  totalSpent: number;
  nextResetAt: Date;
  lastResetAt: Date;
}

// ── 1. Config loader — DB first, fallback to defaults ─────────────────────────

export async function getActionConfig(key: ActionKey): Promise<ActionConfig> {
  try {
    const cached = (await cache.get(
      `${CONFIG_CACHE_KEY}:${key}`,
    )) as ActionConfig | null;
    if (cached) return cached;

    const row = await prisma.credit_config.findUnique({
      where: { action_key: key },
    });
    if (!row) return DEFAULT_ACTION_CONFIGS[key];

    const config: ActionConfig = {
      key: row.action_key as ActionKey,
      displayName: row.display_name,
      creditsCost: row.credits_cost,
      modelMini: row.model_mini,
      modelHeavy: row.model_heavy,
      useHeavy: row.use_heavy,
      maxPerDay: row.max_per_day ?? undefined,
      maxPerMonth: row.max_per_month ?? undefined,
      freeTierAllowed: row.free_tier_allowed,
      proTierAllowed: row.pro_tier_allowed,
      maxTierAllowed: row.max_tier_allowed,
    };

    await cache.set(`${CONFIG_CACHE_KEY}:${key}`, config, CONFIG_TTL);
    return config;
  } catch (err) {
    logger.warn({ err, key }, "credit_config DB load failed — using default");
    return DEFAULT_ACTION_CONFIGS[key];
  }
}

// Flush config cache — call this after admin updates credit_config
export async function flushConfigCache(): Promise<void> {
  for (const key of Object.keys(DEFAULT_ACTION_CONFIGS)) {
    await cache.del(`${CONFIG_CACHE_KEY}:${key}`);
  }
}

// ── 2. Wallet management ──────────────────────────────────────────────────────

export async function getOrCreateWallet(userId: string, tier: string = "free") {
  const cacheKey = `wallet:${userId}`;
  const cached = (await cache.get(cacheKey)) as any;
  if (cached) return cached;

  let wallet = await prisma.credit_wallets.findUnique({
    where: { user_id: userId },
  });

  if (!wallet) {
    const planCredits = PLAN_CREDITS[tier] ?? PLAN_CREDITS.free;
    wallet = await prisma.credit_wallets.create({
      data: {
        user_id: userId,
        balance: planCredits,
        plan_credits: planCredits,
        total_granted: planCredits,
        next_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // Log initial grant
    await prisma.credit_transactions.create({
      data: {
        user_id: userId,
        type: "grant",
        amount: planCredits,
        balance_after: planCredits,
        description: `Initial ${tier} plan grant`,
        metadata: { plan: tier },
      },
    });

    logger.info({ userId, planCredits, tier }, "Credit wallet created");
  }

  await cache.set(cacheKey, wallet, WALLET_TTL);
  return wallet;
}

export async function getWalletSummary(
  userId: string,
  tier: string,
): Promise<WalletSummary> {
  const wallet = await getOrCreateWallet(userId, tier);
  return {
    balance: wallet.balance,
    planCredits: wallet.plan_credits,
    rolloverCredits: wallet.rollover_credits,
    topupCredits: wallet.topup_credits,
    totalGranted: wallet.total_granted,
    totalSpent: wallet.total_spent,
    nextResetAt: wallet.next_reset_at,
    lastResetAt: wallet.last_reset_at,
  };
}

// ── 3. Monthly reset — called by a cron job ───────────────────────────────────

export async function resetMonthlyCredits(
  userId: string,
  tier: string,
): Promise<void> {
  const wallet = await prisma.credit_wallets.findUnique({
    where: { user_id: userId },
  });
  if (!wallet) return;

  const newPlanCredits = PLAN_CREDITS[tier] ?? PLAN_CREDITS.free;

  // Rollover logic:
  // Free tier: no rollover
  // Pro tier: rollover up to 1 month's worth (500 max)
  // Max/Brand: rollover with no cap
  let rollover = 0;
  if (tier !== "free" && wallet.balance > 0) {
    if (tier === "pro") {
      rollover = Math.min(
        wallet.balance - wallet.topup_credits,
        newPlanCredits,
      );
    } else {
      rollover = Math.max(0, wallet.balance - wallet.topup_credits);
    }
    rollover = Math.max(0, rollover);
  }

  const newBalance = newPlanCredits + rollover + wallet.topup_credits;

  await prisma.$transaction([
    prisma.credit_wallets.update({
      where: { user_id: userId },
      data: {
        balance: newBalance,
        plan_credits: newPlanCredits,
        rollover_credits: rollover,
        last_reset_at: new Date(),
        next_reset_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        total_granted: { increment: newPlanCredits },
        updated_at: new Date(),
      },
    }),
    prisma.credit_transactions.create({
      data: {
        user_id: userId,
        type: "rollover",
        amount: newPlanCredits + rollover,
        balance_after: newBalance,
        description: `Monthly reset — ${newPlanCredits} plan + ${rollover} rollover`,
        metadata: {
          plan: tier,
          rollover,
          topup_preserved: wallet.topup_credits,
        },
      },
    }),
  ]);

  await cache.del(`wallet:${userId}`);
  logger.info({ userId, tier, newBalance, rollover }, "Monthly credits reset");
}

// ── 4. Pre-flight check — call BEFORE doing any AI work ──────────────────────

export async function checkCredits(
  userId: string,
  tier: string,
  actionKey: ActionKey,
): Promise<CreditCheckResult> {
  const [config, wallet] = await Promise.all([
    getActionConfig(actionKey),
    getOrCreateWallet(userId, tier),
  ]);

  // Zero-cost actions always pass
  if (config.creditsCost === 0) {
    return {
      allowed: true,
      balance: wallet.balance,
      cost: 0,
      modelToUse: resolveModel(config),
      config,
    };
  }

  // Tier access check
  if (!isTierAllowed(config, tier)) {
    const requiredTier = !config.proTierAllowed ? "Max" : "Pro";
    return {
      allowed: false,
      reason: `This feature requires ${requiredTier} plan`,
      balance: wallet.balance,
      cost: config.creditsCost,
      modelToUse: resolveModel(config),
      config,
    };
  }

  // Balance check
  if (wallet.balance < config.creditsCost) {
    return {
      allowed: false,
      reason: `Insufficient credits. Need ${config.creditsCost}, have ${wallet.balance}.`,
      balance: wallet.balance,
      cost: config.creditsCost,
      modelToUse: resolveModel(config),
      config,
    };
  }

  // Daily limit check
  if (config.maxPerDay) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayCount = await prisma.credit_transactions.count({
      where: {
        user_id: userId,
        action_key: actionKey,
        type: "debit",
        created_at: { gte: todayStart },
      },
    });

    if (todayCount >= config.maxPerDay) {
      return {
        allowed: false,
        reason: `Daily limit reached for ${config.displayName} (${config.maxPerDay}/day). Resets tomorrow.`,
        balance: wallet.balance,
        cost: config.creditsCost,
        modelToUse: resolveModel(config),
        config,
      };
    }
  }

  // Monthly limit check
  if (config.maxPerMonth) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const monthCount = await prisma.credit_transactions.count({
      where: {
        user_id: userId,
        action_key: actionKey,
        type: "debit",
        created_at: { gte: monthStart },
      },
    });

    if (monthCount >= config.maxPerMonth) {
      return {
        allowed: false,
        reason: `Monthly limit reached for ${config.displayName} (${config.maxPerMonth}/month).`,
        balance: wallet.balance,
        cost: config.creditsCost,
        modelToUse: resolveModel(config),
        config,
      };
    }
  }

  return {
    allowed: true,
    balance: wallet.balance,
    cost: config.creditsCost,
    modelToUse: resolveModel(config),
    config,
  };
}

// ── 5. Debit — call AFTER successful AI response ──────────────────────────────

/**
 * Debit credits from user wallet based on actual OpenAI API usage
 * @param userId - User ID
 * @param actionKey - Action performed (for logging)
 * @param modelUsed - OpenAI model used (e.g., "gpt-4o-mini", "gpt-4o")
 * @param inputTokens - Actual input/prompt tokens used
 * @param outputTokens - Actual output/completion tokens used
 * @param fallbackCost - Optional fallback cost in USD (if token counts unavailable)
 * @param metadata - Additional metadata for transaction log
 */
export async function debitCredits(
  userId: string,
  actionKey: ActionKey,
  modelUsed: string,
  inputTokens: number,
  outputTokens: number,
  fallbackCost?: number,
  metadata?: Record<string, any>,
) {
  // Calculate actual USD cost based on model and token usage
  const usdCost = calculateOpenAICost(modelUsed, inputTokens, outputTokens);

  // Convert USD cost to credits (1 credit = $0.001)
  const creditsToDeduct = usdToCredits(usdCost);

  try {
    // First update the wallet
    const updatedWallet = await prisma.credit_wallets.update({
      where: { user_id: userId },
      data: {
        balance: { decrement: creditsToDeduct },
        total_spent: { increment: creditsToDeduct },
        updated_at: new Date(),
      },
    });

    // Then create the transaction record
    const tx = await prisma.credit_transactions.create({
      data: {
        user_id: userId,
        type: "debit",
        amount: -creditsToDeduct,
        balance_after: updatedWallet.balance,
        action_key: actionKey,
        model_used: modelUsed,
        tokens_input: inputTokens,
        tokens_output: outputTokens,
        cost_usd: usdCost,
        description: `Used ${actionKey}`,
        metadata: { model: modelUsed, ...metadata },
      },
    });

    await cache.del(`wallet:${userId}`);

    logger.info(
      {
        userId,
        actionKey,
        modelUsed,
        inputTokens,
        outputTokens,
        usdCost: usdCost.toFixed(6),
        creditsDeducted: creditsToDeduct,
      },
      "Credits debited",
    );

    return {
      success: true,
      balanceAfter: updatedWallet.balance,
      modelUsed,
      transactionId: tx.id,
    };
  } catch (err) {
    logger.error({ err, userId, actionKey }, "Credit debit failed");
    throw err;
  }
}

// ── 6. Grant credits (subscription upgrade, promo, admin) ─────────────────────

export async function grantCredits(
  userId: string,
  amount: number,
  reason: string,
  tier?: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.credit_wallets.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        balance: amount,
        plan_credits: amount,
        total_granted: amount,
      },
      update: {
        balance: { increment: amount },
        total_granted: { increment: amount },
        ...(tier ? { plan_credits: PLAN_CREDITS[tier] ?? amount } : {}),
        updated_at: new Date(),
      },
    }),
    prisma.credit_transactions.create({
      data: {
        user_id: userId,
        type: "grant",
        amount,
        balance_after: 0, // approximate — ok for grants
        description: reason,
        metadata: { tier },
      },
    }),
  ]);

  await cache.del(`wallet:${userId}`);
  logger.info({ userId, amount, reason }, "Credits granted");
}

// ── 7. Top-up credits (purchase) ──────────────────────────────────────────────

export async function processTopup(
  userId: string,
  packId: string,
  credits: number,
  amountInr: number,
  paymentId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.credit_wallets.update({
      where: { user_id: userId },
      data: {
        balance: { increment: credits },
        topup_credits: { increment: credits },
        total_granted: { increment: credits },
        updated_at: new Date(),
      },
    }),
    prisma.credit_transactions.create({
      data: {
        user_id: userId,
        type: "topup",
        amount: credits,
        balance_after: 0,
        description: `Purchased ${credits} credits (${packId})`,
        metadata: {
          pack_id: packId,
          amount_inr: amountInr,
          payment_id: paymentId,
        },
      },
    }),
    prisma.credit_topups.create({
      data: {
        user_id: userId,
        credits,
        amount_inr: amountInr,
        payment_id: paymentId,
        payment_status: "completed",
        pack_id: packId,
      },
    }),
  ]);

  await cache.del(`wallet:${userId}`);
  logger.info({ userId, packId, credits }, "Top-up processed");
}

// ── 8. Transaction history ────────────────────────────────────────────────────

export async function getTransactionHistory(
  userId: string,
  limit: number = 20,
  offset: number = 0,
) {
  return prisma.credit_transactions.findMany({
    where: { user_id: userId },
    orderBy: { created_at: "desc" },
    take: limit,
    skip: offset,
    select: {
      id: true,
      type: true,
      amount: true,
      balance_after: true,
      action_key: true,
      description: true,
      created_at: true,
    },
  });
}
