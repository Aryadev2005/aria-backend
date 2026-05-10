// src/controllers/razorpay.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// Razorpay Payment Controller
// Handles: order creation + payment signature verification + credit grant
//
// Flow:
//   1. POST /credits/razorpay/create-order  → creates Razorpay order, returns orderId
//   2. Frontend opens Razorpay checkout modal with orderId
//   3. POST /credits/razorpay/verify        → verifies HMAC-SHA256 signature
//                                           → calls processTopup → credits granted
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import Razorpay from "razorpay";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types/user";
import { processTopup } from "../services/credits.service";
import { TOPUP_PACKS } from "../config/credits";
import { prisma } from "../config/database";

// ── Razorpay instance (singleton) ─────────────────────────────────────────────
// Keys are loaded from env — never hardcode them
const getRazorpayInstance = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in environment variables",
    );
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface CreateOrderBody {
  packId: string;
}

interface VerifyPaymentBody {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
  packId: string;
}

// ── POST /api/v1/credits/razorpay/create-order ────────────────────────────────
// Step 1: Create a Razorpay order on the server side.
// The order_id ties the payment to a specific amount — prevents tampering.
export const createOrder = async (
  req: FastifyRequest<{ Body: CreateOrderBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { packId } = req.body;

  const pack = TOPUP_PACKS.find((p) => p.id === packId);
  if (!pack) {
    return reply.code(400).send({
      success: false,
      error: "INVALID_PACK",
      message: `Pack '${packId}' does not exist.`,
    });
  }

  try {
    const razorpay = getRazorpayInstance();

    // Amount must be in paise (INR × 100)
    const amountInPaise = pack.amountInr * 100;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `aria_${user.id.slice(0, 8)}_${packId}_${Date.now()}`,
      notes: {
        userId: user.id,
        packId,
        credits: String(pack.credits),
        product: "ARIA Credits",
      },
    });

    logger.info(
      { userId: user.id, packId, orderId: order.id, amountInPaise },
      "Razorpay order created",
    );

    return success(reply, {
      orderId: order.id,
      amount: amountInPaise,
      currency: "INR",
      packId,
      credits: pack.credits,
      // Return public key — safe to send to frontend
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err: any) {
    logger.error(
      { err: err.message, userId: user.id, packId },
      "Razorpay order creation failed",
    );
    return errors.internal(reply);
  }
};

// ── POST /api/v1/credits/razorpay/verify ──────────────────────────────────────
// Step 2: Verify the Razorpay signature on the server side.
// THIS IS THE CRITICAL SECURITY STEP — never skip or weaken this.
//
// Razorpay official signature formula:
//   HMAC-SHA256( razorpay_order_id + "|" + razorpay_payment_id, RAZORPAY_KEY_SECRET )
//
// If the generated digest matches razorpay_signature, the payment is authentic.
export const verifyPayment = async (
  req: FastifyRequest<{ Body: VerifyPaymentBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, packId } =
    req.body;

  // ── 1. Validate inputs ───────────────────────────────────────────────────
  if (
    !razorpay_order_id ||
    !razorpay_payment_id ||
    !razorpay_signature ||
    !packId
  ) {
    return reply.code(400).send({
      success: false,
      error: "MISSING_FIELDS",
      message:
        "razorpay_order_id, razorpay_payment_id, razorpay_signature, and packId are required.",
    });
  }

  const pack = TOPUP_PACKS.find((p) => p.id === packId);
  if (!pack) {
    return reply.code(400).send({
      success: false,
      error: "INVALID_PACK",
      message: `Pack '${packId}' does not exist.`,
    });
  }

  // ── 2. Verify HMAC-SHA256 signature ─────────────────────────────────────
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
      { userId: user.id, razorpay_order_id, razorpay_payment_id },
      "Razorpay signature verification FAILED — possible tampering",
    );
    return reply.code(400).send({
      success: false,
      error: "INVALID_SIGNATURE",
      message:
        "Payment verification failed. If money was deducted, contact support.",
    });
  }

  // ── 3. Check for duplicate processing (idempotency) ──────────────────────
  // Prevent replaying the same payment_id to grant credits twice
  const existing = await prisma.credit_topups.findFirst({
    where: { payment_id: razorpay_payment_id },
  });

  if (existing) {
    logger.warn(
      { userId: user.id, razorpay_payment_id },
      "Duplicate payment_id — skipping double credit grant",
    );
    return reply.code(409).send({
      success: false,
      error: "DUPLICATE_PAYMENT",
      message: "This payment has already been processed.",
    });
  }

  // ── 4. Grant credits ─────────────────────────────────────────────────────
  try {
    await processTopup(
      user.id,
      packId,
      pack.credits,
      pack.amountInr,
      razorpay_payment_id,
    );

    logger.info(
      { userId: user.id, packId, credits: pack.credits, razorpay_payment_id },
      "Razorpay payment verified — credits granted",
    );

    return success(reply, {
      message: `${pack.credits} credits added to your wallet!`,
      credits: pack.credits,
      packId,
      paymentId: razorpay_payment_id,
    });
  } catch (err: any) {
    logger.error(
      { err: err.message, userId: user.id },
      "processTopup failed after verified payment",
    );
    return errors.internal(reply);
  }
};

// ── POST /api/v1/credits/razorpay/webhook ────────────────────────────────────
// Optional but recommended: Razorpay webhook for payment.captured events.
// Handles edge cases where the browser closed before verify could be called.
// Configure this URL in Razorpay Dashboard → Settings → Webhooks.
export const handleWebhook = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.warn(
      "RAZORPAY_WEBHOOK_SECRET not set — webhook endpoint is disabled",
    );
    return reply.code(503).send({ error: "Webhook not configured" });
  }

  const receivedSignature = req.headers["x-razorpay-signature"] as string;
  if (!receivedSignature) {
    return reply
      .code(400)
      .send({ error: "Missing x-razorpay-signature header" });
  }

  // Verify webhook signature
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

  // Handle payment.captured — the most important event
  if (eventType === "payment.captured") {
    const payment = event.payload?.payment?.entity;
    if (!payment) return reply.code(200).send({ status: "no_payload" });

    const { id: paymentId, order_id: orderId, notes } = payment;
    const { userId, packId } = notes ?? {};

    if (!userId || !packId) {
      logger.warn(
        { paymentId, orderId },
        "Webhook: missing userId/packId in notes",
      );
      return reply.code(200).send({ status: "missing_notes" });
    }

    // Idempotency check
    const existing = await prisma.credit_topups.findFirst({
      where: { payment_id: paymentId },
    });

    if (existing) {
      logger.info({ paymentId }, "Webhook: payment already processed");
      return reply.code(200).send({ status: "already_processed" });
    }

    const pack = TOPUP_PACKS.find((p) => p.id === packId);
    if (!pack) {
      logger.warn({ packId }, "Webhook: unknown packId");
      return reply.code(200).send({ status: "unknown_pack" });
    }

    try {
      await processTopup(
        userId,
        packId,
        pack.credits,
        pack.amountInr,
        paymentId,
      );
      logger.info(
        { userId, packId, paymentId },
        "Webhook: credits granted via payment.captured",
      );
    } catch (err) {
      logger.error({ err, userId, paymentId }, "Webhook: processTopup failed");
    }
  }

  // Always return 200 to Razorpay to acknowledge receipt
  return reply.code(200).send({ status: "ok" });
};
