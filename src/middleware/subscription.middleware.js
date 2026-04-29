// src/middleware/subscription.middleware.js
// ARIA Backend — Subscription gating middleware
// Drop-in replacement / addition to auth.middleware.js requirePro
//
// Usage in routes:
//   const { requirePro } = require('../middleware/subscription.middleware')
//   app.get('/rate-card', { preHandler: [authenticateFirebase, requirePro] }, handler)

'use strict'

const { errors } = require('../utils/response')
const { logger } = require('../utils/logger')

/**
 * Blocks access if user is not Pro.
 * Checks both is_pro flag AND subscription_expires_at (server-side expiry guard).
 * RevenueCat webhook keeps these in sync, but this is the safety net.
 */
const requirePro = async (req, reply) => {
  const user = req.user

  if (!user) {
    return errors.unauthorized(reply, 'Authentication required')
  }

  // Check is_pro flag (set by webhook)
  if (!user.is_pro) {
    return errors.forbidden(
      reply,
      'This feature requires ARIA Pro — upgrade for ₹499/month or ₹5,000/year',
    )
  }

  // Double-check expiry if we have it (belt + suspenders)
  if (user.subscription_expires_at) {
    const expired = new Date(user.subscription_expires_at) < new Date()
    if (expired) {
      logger.warn(
        { userId: user.id, expiresAt: user.subscription_expires_at },
        'Pro access expired — downgrading user',
      )
      // Downgrade in background (don't await — don't block the response)
      _downgradeExpiredUser(req, user.id).catch(() => {})
      return errors.forbidden(
        reply,
        'Your Pro subscription has expired. Please renew to continue.',
      )
    }
  }
}

/**
 * Soft gate — attaches isPro to req but doesn't block.
 * Use for features that have free tier with limits + pro unlimited.
 */
const softProCheck = async (req, _reply) => {
  req.isPro = req.user?.is_pro ?? false
}

/**
 * Downgrade expired user in DB (called in background)
 */
const _downgradeExpiredUser = async (req, userId) => {
  try {
    const { getDB } = require('../config/database')
    const { cache, CacheKeys } = require('../config/redis')
    const sql = getDB()

    await sql`
      UPDATE users
      SET is_pro = false, subscription_tier = 'free', updated_at = NOW()
      WHERE id = ${userId}
        AND (subscription_expires_at IS NULL OR subscription_expires_at < NOW())
    `
    await cache.del(CacheKeys.user(userId))
    req.log?.info({ userId }, 'Expired user downgraded to free')
  } catch (err) {
    req.log?.error({ err, userId }, 'Failed to downgrade expired user')
  }
}

module.exports = { requirePro, softProCheck }
