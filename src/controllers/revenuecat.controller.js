// src/controllers/revenuecat.controller.js
// ARIA Backend — RevenueCat Webhook Handler
// RevenueCat sends server-side events here so your DB stays in sync
// even if the user never opens the app after purchasing.
//
// Setup in RevenueCat Dashboard:
//   Project Settings → Integrations → Webhooks
//   URL: https://your-railway-url.up.railway.app/api/v1/webhooks/revenuecat
//   Authorization: set a secret header value → add to your .env as REVENUECAT_WEBHOOK_SECRET

'use strict'

const { getDB } = require('../config/database')
const { cache, CacheKeys } = require('../config/redis')
const { success, errors } = require('../utils/response')
const { logger } = require('../utils/logger')

// ── Event types RevenueCat sends ──────────────────────────────────────────
const RC_EVENTS = {
  INITIAL_PURCHASE:   'INITIAL_PURCHASE',
  RENEWAL:            'RENEWAL',
  CANCELLATION:       'CANCELLATION',
  UNCANCELLATION:     'UNCANCELLATION',
  NON_RENEWING_PURCHASE: 'NON_RENEWING_PURCHASE',
  SUBSCRIPTION_PAUSED: 'SUBSCRIPTION_PAUSED',
  EXPIRATION:         'EXPIRATION',
  BILLING_ISSUE:      'BILLING_ISSUE',
  PRODUCT_CHANGE:     'PRODUCT_CHANGE',
  TRANSFER:           'TRANSFER',
}

// ── Webhook endpoint ──────────────────────────────────────────────────────

const handleWebhook = async (req, reply) => {
  try {
    // 1. Verify the webhook secret
    const secret = req.headers['authorization']
    if (secret !== process.env.REVENUECAT_WEBHOOK_SECRET) {
      logger.warn('RevenueCat webhook: invalid secret')
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { event } = req.body
    if (!event) {
      return reply.code(400).send({ error: 'Missing event' })
    }

    const {
      type,
      app_user_id,         // This is the Firebase UID you passed to RC
      product_id,
      expiration_at_ms,
      store,
    } = event

    logger.info({ type, app_user_id, product_id }, 'RevenueCat webhook received')

    const sql = getDB()

    switch (type) {
      // ── User purchased or renewed ─────────────────────────────────────
      case RC_EVENTS.INITIAL_PURCHASE:
      case RC_EVENTS.RENEWAL:
      case RC_EVENTS.UNCANCELLATION:
      case RC_EVENTS.NON_RENEWING_PURCHASE: {
        const expiresAt = expiration_at_ms
          ? new Date(expiration_at_ms)
          : null

        await sql`
          UPDATE users
          SET
            is_pro            = true,
            subscription_tier = 'pro',
            subscription_product_id = ${product_id || null},
            subscription_expires_at = ${expiresAt},
            subscription_store      = ${store || null},
            updated_at        = NOW()
          WHERE firebase_uid = ${app_user_id}
        `

        // Bust cache so next request gets fresh data
        await _bustUserCache(sql, app_user_id)

        logger.info({ app_user_id, type }, 'User upgraded to Pro')
        break
      }

      // ── User cancelled or subscription expired ────────────────────────
      case RC_EVENTS.CANCELLATION:
      case RC_EVENTS.EXPIRATION:
      case RC_EVENTS.SUBSCRIPTION_PAUSED: {
        // Grace period: only downgrade after actual expiry, not on cancel
        // RevenueCat sends EXPIRATION when access actually ends
        if (type === RC_EVENTS.EXPIRATION) {
          await sql`
            UPDATE users
            SET
              is_pro            = false,
              subscription_tier = 'free',
              updated_at        = NOW()
            WHERE firebase_uid = ${app_user_id}
          `
          await _bustUserCache(sql, app_user_id)
          logger.info({ app_user_id }, 'User downgraded to Free (expired)')
        } else {
          // Just log the cancellation — keep Pro until expiry
          logger.info({ app_user_id, type }, 'Subscription cancelled (still active until expiry)')
        }
        break
      }

      // ── Billing issue — notify but keep access ────────────────────────
      case RC_EVENTS.BILLING_ISSUE: {
        logger.warn({ app_user_id }, 'Billing issue — user retains access during grace period')
        // TODO: trigger push notification via FCM to prompt user to fix payment
        break
      }

      // ── Product change (monthly → annual or vice versa) ───────────────
      case RC_EVENTS.PRODUCT_CHANGE: {
        await sql`
          UPDATE users
          SET
            subscription_product_id = ${product_id || null},
            updated_at = NOW()
          WHERE firebase_uid = ${app_user_id}
        `
        await _bustUserCache(sql, app_user_id)
        logger.info({ app_user_id, product_id }, 'Subscription plan changed')
        break
      }

      default:
        logger.info({ type }, 'Unhandled RC event type — ignored')
    }

    // RevenueCat expects 200 within 5s or it retries
    return success(reply, { received: true })

  } catch (err) {
    logger.error({ err }, 'RevenueCat webhook failed')
    // Return 200 anyway to prevent RC from retrying a permanent failure
    return reply.code(200).send({ received: true, error: 'internal' })
  }
}

// ── Bust all cache keys for a Firebase UID ───────────────────────────────

const _bustUserCache = async (sql, firebaseUid) => {
  try {
    const [user] = await sql`
      SELECT id FROM users WHERE firebase_uid = ${firebaseUid} LIMIT 1
    `
    if (user) {
      await cache.del(CacheKeys.user(user.id))
    }
  } catch (_) {}
}

module.exports = { handleWebhook }
