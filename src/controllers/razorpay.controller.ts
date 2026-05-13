// src/controllers/razorpay.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// Razorpay Payment Controller
//
// Handles TWO payment types:
//   1. Plan purchase  — upgrades subscription_tier + grants monthly credits
//   2. Top-up (future) — one-time credit purchase
//
// Flow (same for both):
//   POST /credits/razorpay/create-order  { planId }
//   → Razorpay modal opens
//   POST /credits/razorpay/verify        { ...signature, itemId, paymentType }
//   → tier upgraded + credits granted
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import Razorpay from "razorpay";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types/user";
import { processTopup, resetMonthlyCredits } from "../services/credits.service";
import { TOPUP_PACKS, PLAN_CREDITS } from "../config/credits";
import { prisma } from "../config/database";

// ── Razorpay instance ─────────────────────────────────────────────────────────
const getRazorpayInstance = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

// ── Plan definitions ──────────────────────────────────────────────────────────
export const SUBSCRIPTION_PLANS = [
  { id: "plan_starter", tier: "starter", amountInr: 249, label: "Starter" },
  { id: "plan_pro", tier: "pro", amountInr: 499, label: "Pro" },
  { id: "plan_max", tier: "max", amountInr: 749, label: "Max" },
  { id: "plan_brand", tier: "brand", amountInr: 999, label: "Brand" },
] as const;

function getPlan(planId: string) {
  return SUBSCRIPTION_PLANS.find((p) => p.id === planId) ?? null;
}

function getPack(packId: string) {
  return TOPUP_PACKS.find((p) => p.id === packId) ?? null;
}

// ── POST /api/v1/credits/razorpay/create-order ────────────────────────────────
// Body: { planId: "plan_pro" }  OR  { packId: "pack_300" }
export const createOrder = async (
  req: FastifyRequest<{ Body: { planId?: string; packId?: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { planId, packId } = req.body;

  if (!planId && !packId) {
    return reply.code(400).send({
      success: false,
      error: "MISSING_ID",
      message: "Provide either planId or packId.",
    });
  }

  let amountInr: number;
  let description: string;
  let itemId: string;
  let paymentType: "plan" | "topup";

  if (planId) {
    const plan = getPlan(planId);
    if (!plan) {
      return reply.code(400).send({
        success: false,
        error: "INVALID_PLAN",
        message: `Plan '${planId}' does not exist.`,
      });
    }
    amountInr = plan.amountInr;
    description = `ARIA ${plan.label} Plan — 1 month`;
    itemId = planId;
    paymentType = "plan";
  } else {
    const pack = getPack(packId!);
    if (!pack) {
      return reply.code(400).send({
        success: false,
        error: "INVALID_PACK",
        message: `Pack '${packId}' does not exist.`,
      });
    }
    amountInr = pack.amountInr;
    description = `ARIA ${pack.credits} Credits Top-up`;
    itemId = packId!;
    paymentType = "topup";
  }

  try {
    const razorpay = getRazorpayInstance();
    const amountInPaise = amountInr * 100;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `aria_${user.id.slice(0, 8)}_${itemId}_${Date.now()}`,
      notes: {
        userId: user.id,
        itemId,
        paymentType,
        product: "ARIA",
      },
    });

    logger.info(
      { userId: user.id, itemId, paymentType, orderId: order.id },
      "Razorpay order created",
    );

    return success(reply, {
      orderId: order.id,
      amount: amountInPaise,
      currency: "INR",
      description,
      itemId,
      paymentType,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err: any) {
    logger.error(
      {
        err: err.message,
        errCode: err.statusCode,
        errBody: err.error,
        userId: user.id,
      },
      "Razorpay order creation failed",
    );
    return errors.internal(reply);
  }
};

// ── POST /api/v1/credits/razorpay/verify ─────────────────────────────────────
// Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, itemId, paymentType }
export const verifyPayment = async (
  req: FastifyRequest<{
    Body: {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
      itemId: string;
      paymentType: "plan" | "topup";
    };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    itemId,
    paymentType,
  } = req.body;

  // ── 1. Validate ───────────────────────────────────────────────────────────
  if (
    !razorpay_order_id ||
    !razorpay_payment_id ||
    !razorpay_signature ||
    !itemId ||
    !paymentType
  ) {
    return reply.code(400).send({
      success: false,
      error: "MISSING_FIELDS",
      message:
        "razorpay_order_id, razorpay_payment_id, razorpay_signature, itemId, paymentType are required.",
    });
  }

  // ── 2. HMAC-SHA256 signature verification ─────────────────────────────────
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    logger.error("RAZORPAY_KEY_SECRET is not set");
    return errors.internal(reply);
  }

  const generatedSignature = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (generatedSignature !== razorpay_signature) {
    logger.warn(
      { userId: user.id, razorpay_order_id },
      "Razorpay signature verification FAILED",
    );
    return reply.code(400).send({
      success: false,
      error: "INVALID_SIGNATURE",
      message:
        "Payment verification failed. If money was deducted, contact support.",
    });
  }

  // ── 3. Idempotency check ──────────────────────────────────────────────────
  const existing = await prisma.credit_topups.findFirst({
    where: { payment_id: razorpay_payment_id },
  });
  if (existing) {
    logger.warn(
      { userId: user.id, razorpay_payment_id },
      "Duplicate payment_id",
    );
    return reply.code(409).send({
      success: false,
      error: "DUPLICATE_PAYMENT",
      message: "This payment has already been processed.",
    });
  }

  // ── 4. Process ────────────────────────────────────────────────────────────
  try {
    if (paymentType === "plan") {
      const plan = getPlan(itemId);
      if (!plan) {
        return reply.code(400).send({ success: false, error: "INVALID_PLAN" });
      }

      await activatePlan(
        user.id,
        plan.tier,
        plan.amountInr,
        razorpay_payment_id,
      );

      logger.info(
        { userId: user.id, planId: itemId, tier: plan.tier },
        "Plan activated",
      );

      return success(reply, {
        message: `${plan.label} plan activated! Your monthly allowance has been updated.`,
        paymentType: "plan",
        tier: plan.tier,
        planLabel: plan.label,
        paymentId: razorpay_payment_id,
      });
    } else {
      const pack = getPack(itemId);
      if (!pack) {
        return reply.code(400).send({ success: false, error: "INVALID_PACK" });
      }

      await processTopup(
        user.id,
        itemId,
        pack.credits,
        pack.amountInr,
        razorpay_payment_id,
      );

      logger.info({ userId: user.id, packId: itemId }, "Top-up processed");

      return success(reply, {
        message: `Top-up successful!`,
        paymentType: "topup",
        paymentId: razorpay_payment_id,
      });
    }
  } catch (err: any) {
    logger.error(
      { err: err.message, userId: user.id },
      "Payment processing failed after signature verify",
    );
    return errors.internal(reply);
  }
};

// ── activatePlan ──────────────────────────────────────────────────────────────
// Upgrades subscription_tier on users table + resets credit wallet for new tier.
async function activatePlan(
  userId: string,
  tier: string,
  amountInr: number,
  paymentId: string,
): Promise<void> {
  const planCredits = PLAN_CREDITS[tier] ?? PLAN_CREDITS.free;

  // 1. Upgrade user tier
  await prisma.users.update({
    where: { id: userId },
    data: {
      subscription_tier: tier,
      is_pro: tier !== "free",
      subscription_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      updated_at: new Date(),
    },
  });

  // 2. Reset wallet with new plan's credit pool
  //    resetMonthlyCredits handles rollover logic correctly per tier
  await resetMonthlyCredits(userId, tier);

  // 3. Audit log in credit_topups
  await prisma.credit_topups.create({
    data: {
      user_id: userId,
      credits: planCredits,
      amount_inr: amountInr,
      payment_id: paymentId,
      payment_status: "completed",
      pack_id: `subscription_${tier}`,
    },
  });

  logger.info(
    { userId, tier, planCredits },
    "Plan activated + credits granted",
  );
}

// ── POST /api/v1/credits/razorpay/webhook ────────────────────────────────────
export const handleWebhook = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.warn("RAZORPAY_WEBHOOK_SECRET not set — webhook disabled");
    return reply.code(503).send({ error: "Webhook not configured" });
  }

  const receivedSignature = req.headers["x-razorpay-signature"] as string;
  if (!receivedSignature) {
    return reply
      .code(400)
      .send({ error: "Missing x-razorpay-signature header" });
  }

  const generatedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (generatedSignature !== receivedSignature) {
    logger.warn("Razorpay webhook signature mismatch");
    return reply.code(400).send({ error: "Invalid webhook signature" });
  }

  const event = req.body as any;
  const eventType = event?.event;
  logger.info({ eventType }, "Razorpay webhook received");

  if (eventType === "payment.captured") {
    const payment = event.payload?.payment?.entity;
    if (!payment) return reply.code(200).send({ status: "no_payload" });

    const { id: paymentId, notes } = payment;
    const { userId, itemId, paymentType } = notes ?? {};

    if (!userId || !itemId || !paymentType) {
      return reply.code(200).send({ status: "missing_notes" });
    }

    const existing = await prisma.credit_topups.findFirst({
      where: { payment_id: paymentId },
    });
    if (existing) return reply.code(200).send({ status: "already_processed" });

    try {
      if (paymentType === "plan") {
        const plan = getPlan(itemId);
        if (plan) {
          await activatePlan(userId, plan.tier, plan.amountInr, paymentId);
          logger.info({ userId, itemId }, "Webhook: plan activated");
        }
      } else {
        const pack = getPack(itemId);
        if (pack) {
          await processTopup(
            userId,
            itemId,
            pack.credits,
            pack.amountInr,
            paymentId,
          );
          logger.info({ userId, itemId }, "Webhook: top-up processed");
        }
      }
    } catch (err) {
      logger.error({ err, userId, paymentId }, "Webhook: processing failed");
    }
  }

  return reply.code(200).send({ status: "ok" });
};
