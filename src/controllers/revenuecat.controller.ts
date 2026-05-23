import { FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { prisma } from "../config/database";
import { cache, CacheKeys } from "../config/redis";
import { success } from "../utils/response";
import { logger } from "../utils/logger";

// ── Event types RevenueCat sends ──────────────────────────────────────────
const RC_EVENTS = {
  INITIAL_PURCHASE: "INITIAL_PURCHASE",
  RENEWAL: "RENEWAL",
  CANCELLATION: "CANCELLATION",
  UNCANCELLATION: "UNCANCELLATION",
  NON_RENEWING_PURCHASE: "NON_RENEWING_PURCHASE",
  SUBSCRIPTION_PAUSED: "SUBSCRIPTION_PAUSED",
  EXPIRATION: "EXPIRATION",
  BILLING_ISSUE: "BILLING_ISSUE",
  PRODUCT_CHANGE: "PRODUCT_CHANGE",
  TRANSFER: "TRANSFER",
};

interface RevenueCatEvent {
  type: string;
  app_user_id: string;
  product_id?: string;
  expiration_at_ms?: number;
  store?: string;
  transaction_id?: string; // used for idempotency
}

interface RevenueCatWebhookBody {
  event: RevenueCatEvent;
}

// ── Webhook endpoint ──────────────────────────────────────────────────────

export const handleWebhook = async (
  req: FastifyRequest<{ Body: RevenueCatWebhookBody }>,
  reply: FastifyReply,
) => {
  try {
    // 1. Verify the webhook secret (timing-safe to prevent timing oracle attacks)
    const expectedSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
    const providedSecret = req.headers["authorization"] as string | undefined;
    if (!expectedSecret || !providedSecret) {
      logger.warn("RevenueCat webhook: missing secret");
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const expectedKey = Buffer.from("rc_secret_cmp");
    const expectedHash = crypto.createHmac("sha256", expectedKey).update(expectedSecret).digest();
    const providedHash  = crypto.createHmac("sha256", expectedKey).update(providedSecret).digest();
    if (!crypto.timingSafeEqual(expectedHash, providedHash)) {
      logger.warn("RevenueCat webhook: invalid secret");
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { event } = req.body;
    if (!event) {
      return reply.code(400).send({ error: "Missing event" });
    }

    const {
      type,
      app_user_id, // This is the Firebase UID you passed to RC
      product_id,
      expiration_at_ms,
      store,
      transaction_id,
    } = event;

    logger.info(
      { type, app_user_id, product_id, transaction_id },
      "RevenueCat webhook received",
    );

    // Idempotency check — RC retries on non-200 responses; skip duplicates
    if (transaction_id) {
      const idemKey = `rc_tx:${transaction_id}`;
      const alreadyProcessed = await cache.get(idemKey);
      if (alreadyProcessed) {
        logger.info({ transaction_id }, "RevenueCat webhook: duplicate transaction — skipping");
        return success(reply, { received: true, status: "already_processed" });
      }
      // Mark as processed for 7 days (longer than any RC retry window)
      await cache.set(idemKey, "1", 7 * 24 * 60 * 60);
    }

    switch (type) {
      // ── User purchased or renewed ─────────────────────────────────────
      case RC_EVENTS.INITIAL_PURCHASE:
      case RC_EVENTS.RENEWAL:
      case RC_EVENTS.UNCANCELLATION:
      case RC_EVENTS.NON_RENEWING_PURCHASE: {
        const expiresAt = expiration_at_ms ? new Date(expiration_at_ms) : null;

        await prisma.users.updateMany({
          where: { firebase_uid: app_user_id },
          data: {
            is_pro: true,
            subscription_tier: "pro",
            subscription_product_id: product_id || null,
            subscription_expires_at: expiresAt,
            subscription_store: store || null,
            updated_at: new Date(),
          },
        });

        // Bust cache so next request gets fresh data
        await _bustUserCache(app_user_id);

        logger.info({ app_user_id, type }, "User upgraded to Pro");
        break;
      }

      // ── User cancelled or subscription expired ────────────────────────
      case RC_EVENTS.CANCELLATION:
      case RC_EVENTS.EXPIRATION:
      case RC_EVENTS.SUBSCRIPTION_PAUSED: {
        // Grace period: only downgrade after actual expiry, not on cancel
        // RevenueCat sends EXPIRATION when access actually ends
        if (type === RC_EVENTS.EXPIRATION) {
          await prisma.users.updateMany({
            where: { firebase_uid: app_user_id },
            data: {
              is_pro: false,
              subscription_tier: "free",
              updated_at: new Date(),
            },
          });
          await _bustUserCache(app_user_id);
          logger.info({ app_user_id }, "User downgraded to Free (expired)");
        } else {
          // Just log the cancellation — keep Pro until expiry
          logger.info(
            { app_user_id, type },
            "Subscription cancelled (still active until expiry)",
          );
        }
        break;
      }

      // ── Billing issue — notify but keep access ────────────────────────
      case RC_EVENTS.BILLING_ISSUE: {
        logger.warn(
          { app_user_id },
          "Billing issue — user retains access during grace period",
        );
        // TODO: trigger push notification via FCM to prompt user to fix payment
        break;
      }

      // ── Product change (monthly → annual or vice versa) ───────────────
      case RC_EVENTS.PRODUCT_CHANGE: {
        await prisma.users.updateMany({
          where: { firebase_uid: app_user_id },
          data: {
            subscription_product_id: product_id || null,
            updated_at: new Date(),
          },
        });
        await _bustUserCache(app_user_id);
        logger.info({ app_user_id, product_id }, "Subscription plan changed");
        break;
      }

      default:
        logger.info({ type }, "Unhandled RC event type — ignored");
    }

    // RevenueCat expects 200 within 5s or it retries
    return success(reply, { received: true });
  } catch (err) {
    logger.error({ err }, "RevenueCat webhook failed");
    // Return 200 anyway to prevent RC from retrying a permanent failure
    return reply.code(200).send({ received: true, error: "internal" });
  }
};

// ── Bust all cache keys for a Firebase UID ───────────────────────────────

const _bustUserCache = async (firebaseUid: string) => {
  try {
    const user = await prisma.users.findUnique({
      where: { firebase_uid: firebaseUid },
      select: { id: true },
    });
    if (user) {
      await cache.del(CacheKeys.user(user.id));
    }
  } catch (_) {}
};
