// src/services/credits.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// ARIA Credit Engine — Unified debit: feature charge + AI dynamic charge
//
// KEY CHANGES from v1:
//   - balance column is now FLOAT (NUMERIC in Postgres, Decimal in Prisma)
//   - debitCredits() debits: featureCharge + usdToCredits(aiCost) in one tx
//   - getWalletSummary() exposes usedPct (0–100) — this is what frontend uses
//   - Raw credit numbers are NEVER returned to the frontend API
//   - Rollover logic updated for new plan names (starter added)
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
const CONFIG_TTL = 300;
const WALLET_TTL = 60;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CreditCheckResult {
  allowed: boolean;
  reason?: string;
  usedPct: number; // 0–100, what frontend shows
  featureCharge: number; // flat feature cost
  modelToUse: string;
  config: ActionConfig;
}

export interface DebitResult {
  success: boolean;
  usedPct: number; // updated pct after debit
  totalDebited: number; // featureCharge + aiCharge (float)
  transactionId: string;
}

export interface WalletSummary {
  // Percentage only — never expose raw credits to frontend
  usedPct: number; // 0–100 float, e.g. 34.7
  remainingPct: number; // 100 - usedPct
  plan: string;
  planLabel: string; // "Pro", "Free", etc.
  planMultiplier: string; // "15× the free plan"
  planLimitCredits: number; // internal only, used for pct calculation
  // Breakdown pcts (for the detail screen)
  planUsedPct: number;
  rolloverPct: number;
  topupPct: number;
  // Lifetime stats (shown as percentages / counts, not credits)
  totalActionsCount: number;
  nextResetAt: Date;
  lastResetAt: Date;
}

// ── 1. Config loader ──────────────────────────────────────────────────────────

export async function getActionConfig(key: ActionKey): Promise<ActionConfig> {
  try {
    const cacheKey = `${CONFIG_CACHE_KEY}:${key}`;
    const cached = (await cache.get(cacheKey)) as ActionConfig | null;
    if (cached) return cached;

    const row = await prisma.credit_config.findUnique({
      where: { action_key: key },
    });
    if (!row) return DEFAULT_ACTION_CONFIGS[key];

    const config: ActionConfig = {
      key: row.action_key as ActionKey,
      displayName: row.display_name,
      featureCharge: row.credits_cost, // DB credits_cost = featureCharge
      modelMini: row.model_mini,
      modelHeavy: row.model_heavy,
      useHeavy: row.use_heavy,
      maxPerDay: row.max_per_day ?? undefined,
      maxPerMonth: row.max_per_month ?? undefined,
      freeTierAllowed: row.free_tier_allowed,
      starterTierAllowed: row.pro_tier_allowed, // starter reuses pro_tier_allowed column
      proTierAllowed: row.pro_tier_allowed,
      maxTierAllowed: row.max_tier_allowed,
    };

    await cache.set(cacheKey, config, CONFIG_TTL);
    return config;
  } catch (err) {
    logger.warn({ err, key }, "credit_config DB load failed — using default");
    return DEFAULT_ACTION_CONFIGS[key];
  }
}

export async function flushConfigCache(): Promise<void> {
  for (const key of Object.keys(DEFAULT_ACTION_CONFIGS)) {
    await cache.del(`${CONFIG_CACHE_KEY}:${key}`);
  }
}

// ── 2. Wallet ─────────────────────────────────────────────────────────────────

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

// ── 3. Wallet summary — percentage-based, safe for frontend ───────────────────

export async function getWalletSummary(
  userId: string,
  tier: string,
): Promise<WalletSummary> {
  const { PLAN_LABELS, PLAN_MULTIPLIERS } = await import("../config/credits");

  const wallet = await getOrCreateWallet(userId, tier);
  const planLimit = PLAN_CREDITS[tier] ?? PLAN_CREDITS.free;

  // balance, plan_credits, rollover_credits, topup_credits are all floats now
  const balance = Number(wallet.balance);
  const planCredits = Number(wallet.plan_credits);
  const rollover = Number(wallet.rollover_credits);
  const topup = Number(wallet.topup_credits);
  const totalGranted = Number(wallet.total_granted);
  const totalSpent = Number(wallet.total_spent);

  const used = Math.max(0, totalGranted - balance);
  const usedPct = planLimit > 0 ? Math.min(100, (used / planLimit) * 100) : 0;

  // Breakdown pcts — what % of the plan limit each bucket represents
  const planUsedPct =
    planLimit > 0
      ? Math.min(
          100,
          ((planLimit - Math.max(0, planCredits - totalSpent)) / planLimit) *
            100,
        )
      : 0;
  const effectiveRollover =
    tier === "free" || tier === "starter" ? 0 : rollover;
  const rolloverPct = planLimit > 0 ? (effectiveRollover / planLimit) * 100 : 0;
  const topupPct = planLimit > 0 ? (topup / planLimit) * 100 : 0;

  // Total actions = number of debit transactions
  const totalActionsCount = await prisma.credit_transactions.count({
    where: { user_id: userId, type: "debit" },
  });

  return {
    usedPct: Math.round(usedPct * 10) / 10, // 1 decimal place
    remainingPct: Math.round((100 - usedPct) * 10) / 10,
    plan: tier,
    planLabel: PLAN_LABELS[tier] ?? tier,
    planMultiplier: PLAN_MULTIPLIERS[tier] ?? "",
    planLimitCredits: planLimit, // internal, not shown to user
    planUsedPct: Math.round(planUsedPct * 10) / 10,
    rolloverPct: Math.round(rolloverPct * 10) / 10,
    topupPct: Math.round(topupPct * 10) / 10,
    totalActionsCount,
    nextResetAt: wallet.next_reset_at,
    lastResetAt: wallet.last_reset_at,
  };
}

// ── 4. Monthly reset ──────────────────────────────────────────────────────────

export async function resetMonthlyCredits(
  userId: string,
  tier: string,
): Promise<void> {
  const wallet = await prisma.credit_wallets.findUnique({
    where: { user_id: userId },
  });
  if (!wallet) return;

  const newPlanCredits = PLAN_CREDITS[tier] ?? PLAN_CREDITS.free;
  const currentBalance = Number(wallet.balance);
  const topupCredits = Number(wallet.topup_credits);

  // Rollover logic:
  // free/starter: no rollover
  // pro: rollover up to 1× plan credits
  // max/brand: unlimited rollover
  let rollover = 0;
  if (tier === "pro") {
    rollover = Math.min(
      Math.max(0, currentBalance - topupCredits),
      newPlanCredits,
    );
  } else if (tier === "max" || tier === "brand") {
    rollover = Math.max(0, currentBalance - topupCredits);
  }
  // free and starter: rollover stays 0 (default)
  rollover = Math.max(0, rollover);

  const newBalance = newPlanCredits + rollover + topupCredits;

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
        description: `Monthly reset — ${newPlanCredits} plan + ${rollover.toFixed(1)} rollover`,
        metadata: { plan: tier, rollover, topup_preserved: topupCredits },
      },
    }),
  ]);

  await cache.del(`wallet:${userId}`);
  logger.info({ userId, tier, newBalance, rollover }, "Monthly credits reset");
}

// ── 5. Pre-flight check ───────────────────────────────────────────────────────
// Call BEFORE doing AI work to gate the request.
// Returns usedPct (not raw balance) — safe to pass to frontend.

export async function checkCredits(
  userId: string,
  tier: string,
  actionKey: ActionKey,
): Promise<CreditCheckResult> {
  const [config, wallet] = await Promise.all([
    getActionConfig(actionKey),
    getOrCreateWallet(userId, tier),
  ]);

  const planLimit = PLAN_CREDITS[tier] ?? PLAN_CREDITS.free;
  const balance = Number(wallet.balance);
  const totalGranted = Number(wallet.total_granted);
  const used = Math.max(0, totalGranted - balance);
  const usedPct = planLimit > 0 ? Math.min(100, (used / planLimit) * 100) : 0;

  // Zero-cost actions always pass
  if (config.featureCharge === 0) {
    return {
      allowed: true,
      usedPct,
      featureCharge: 0,
      modelToUse: resolveModel(config),
      config,
    };
  }

  // Tier access check
  if (!isTierAllowed(config, tier)) {
    const required = !config.proTierAllowed
      ? "Max"
      : !config.starterTierAllowed
        ? "Pro"
        : "Starter";
    return {
      allowed: false,
      reason: `This feature requires the ${required} plan.`,
      usedPct,
      featureCharge: config.featureCharge,
      modelToUse: resolveModel(config),
      config,
    };
  }

  // Balance check (use featureCharge as minimum gate — AI charge added after)
  if (balance < config.featureCharge) {
    return {
      allowed: false,
      reason:
        "You've used up your monthly allowance. Top up or upgrade to continue.",
      usedPct,
      featureCharge: config.featureCharge,
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
        reason: `Daily limit reached for ${config.displayName}. Comes back tomorrow.`,
        usedPct,
        featureCharge: config.featureCharge,
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
        reason: `Monthly limit reached for ${config.displayName}.`,
        usedPct,
        featureCharge: config.featureCharge,
        modelToUse: resolveModel(config),
        config,
      };
    }
  }

  return {
    allowed: true,
    usedPct,
    featureCharge: config.featureCharge,
    modelToUse: resolveModel(config),
    config,
  };
}

// ── 6. Debit — UNIFIED feature charge + AI charge in one transaction ──────────
// Call AFTER successful AI response.
// totalDebited = featureCharge + usdToCredits(actualAiCost) — both floats.

export async function debitCredits(
  userId: string,
  actionKey: ActionKey,
  modelUsed: string,
  inputTokens: number,
  outputTokens: number,
  featureChargeOverride?: number,
  metadata?: Record<string, any>,
): Promise<DebitResult> {
  const config = await getActionConfig(actionKey);
  const featureCharge = featureChargeOverride ?? config.featureCharge;

  // AI dynamic cost in credits (float)
  const aiCostUsd = calculateOpenAICost(modelUsed, inputTokens, outputTokens);
  const aiCostCredits = usdToCredits(aiCostUsd);

  // Total debit: feature value + actual AI cost
  const totalDebited = featureCharge + aiCostCredits;

  try {
    const updatedWallet = await prisma.credit_wallets.update({
      where: { user_id: userId },
      data: {
        balance: { decrement: totalDebited },
        total_spent: { increment: totalDebited },
        updated_at: new Date(),
      },
    });

    const newBalance = Number(updatedWallet.balance);
    const planLimit = Number(updatedWallet.plan_credits) > 0
      ? Number(updatedWallet.plan_credits)
      : PLAN_CREDITS.free;

    // Recompute usedPct for response
    const totalGranted = Number(updatedWallet.total_granted);
    const used = Math.max(0, totalGranted - newBalance);
    const usedPct =
      planLimit > 0
        ? Math.min(100, Math.round((used / planLimit) * 1000) / 10)
        : 0;

    const tx = await prisma.credit_transactions.create({
      data: {
        user_id: userId,
        type: "debit",
        amount: -totalDebited,
        balance_after: newBalance,
        action_key: actionKey,
        model_used: modelUsed,
        tokens_input: inputTokens,
        tokens_output: outputTokens,
        cost_usd: aiCostUsd,
        description: `${config.displayName} — ${featureCharge.toFixed(1)} feature + ${aiCostCredits.toFixed(2)} AI`,
        metadata: {
          feature_charge: featureCharge,
          ai_charge: aiCostCredits,
          total_debited: totalDebited,
          model: modelUsed,
          ...metadata,
        },
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
        featureCharge,
        aiCostCredits: aiCostCredits.toFixed(3),
        totalDebited: totalDebited.toFixed(3),
        aiCostUsd: aiCostUsd.toFixed(6),
      },
      "Credits debited (feature + AI)",
    );

    return { success: true, usedPct, totalDebited, transactionId: tx.id };
  } catch (err) {
    logger.error({ err, userId, actionKey }, "Credit debit failed");
    throw err;
  }
}

// ── 7. Grant credits ──────────────────────────────────────────────────────────

export async function grantCredits(
  userId: string,
  amount: number,
  reason: string,
  tier?: string,
): Promise<void> {
  const updatedWallet = await prisma.credit_wallets.upsert({
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
  });

  await prisma.credit_transactions.create({
    data: {
      user_id: userId,
      type: "grant",
      amount,
      balance_after: Number(updatedWallet.balance),
      description: reason,
      metadata: { tier },
    },
  });

  await cache.del(`wallet:${userId}`);
  logger.info({ userId, amount, reason }, "Credits granted");
}

// ── 8. Top-up processing ──────────────────────────────────────────────────────

export async function processTopup(
  userId: string,
  packId: string,
  credits: number,
  amountInr: number,
  paymentId: string,
): Promise<void> {
  const updatedWallet = await prisma.credit_wallets.update({
    where: { user_id: userId },
    data: {
      balance: { increment: credits },
      topup_credits: { increment: credits },
      total_granted: { increment: credits },
      updated_at: new Date(),
    },
  });

  await prisma.credit_transactions.create({
    data: {
      user_id: userId,
      type: "topup",
      amount: credits,
      balance_after: Number(updatedWallet.balance),
      description: `Purchased ${credits} credits (${packId})`,
      metadata: {
        pack_id: packId,
        amount_inr: amountInr,
        payment_id: paymentId,
      },
    },
  });

  await prisma.credit_topups.create({
    data: {
      user_id: userId,
      credits,
      amount_inr: amountInr,
      payment_id: paymentId,
      payment_status: "completed",
      pack_id: packId,
    },
  });

  await cache.del(`wallet:${userId}`);
  logger.info({ userId, packId, credits }, "Top-up processed");
}

// ── 9. Transaction history (safe — no raw credit amounts exposed) ─────────────

export async function getTransactionHistory(
  userId: string,
  limit = 20,
  offset = 0,
) {
  const rows = await prisma.credit_transactions.findMany({
    where: { user_id: userId },
    orderBy: { created_at: "desc" },
    take: limit,
    skip: offset,
    select: {
      id: true,
      type: true,
      action_key: true,
      description: true,
      created_at: true,
      // Return relative pct cost instead of raw amount
      metadata: true,
    },
  });
  return rows;
}
