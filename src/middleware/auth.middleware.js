'use strict'

const { verifyFirebaseToken } = require('../config/firebase')
const { cache, CacheKeys, TTL } = require('../config/redis')
const { getDB } = require('../config/database')
const { errors } = require('../utils/response')
const { logger } = require('../utils/logger')

const authenticateFirebase = async (req, reply) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return errors.unauthorized(reply, 'Missing Bearer token')
    }

    const idToken = authHeader.slice(7)
    const cacheKey = `fb:${idToken.slice(-20)}`
    const cachedUser = await cache.get(cacheKey)

    if (cachedUser) {
      req.user = cachedUser
      return
    }

    const firebaseUser = await verifyFirebaseToken(idToken)
    const sql = getDB()

    let [user] = await sql`
      SELECT id, firebase_uid, email, name, photo_url,
             follower_range, primary_platform, niches,
             is_pro, subscription_tier, created_at
      FROM users
      WHERE firebase_uid = ${firebaseUser.uid}
      LIMIT 1
    `

    if (!user) {
      ;[user] = await sql`
        INSERT INTO users (firebase_uid, email, name, photo_url)
        VALUES (${firebaseUser.uid}, ${firebaseUser.email},
                ${firebaseUser.name}, ${firebaseUser.picture || null})
        RETURNING id, firebase_uid, email, name, photo_url,
                  follower_range, primary_platform, niches,
                  is_pro, subscription_tier, created_at
      `
      logger.info({ userId: user.id }, 'New user created')
    }

    req.user = user
    await cache.set(cacheKey, user, 300)

  } catch (err) {
    logger.error({ err }, 'Auth middleware error')
    return errors.unauthorized(reply, 'Invalid or expired token')
  }
}

const requirePro = async (req, reply) => {
  if (!req.user?.is_pro) {
    return errors.forbidden(reply,
      'This feature requires Pro subscription — ₹499/month')
  }
}

const requireAgency = async (req, reply) => {
  if (req.user?.subscription_tier !== 'agency') {
    return errors.forbidden(reply, 'Agency subscription required')
  }
}

const optionalAuth = async (req, reply) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) return
    await authenticateFirebase(req, reply)
  } catch (_) {}
}

module.exports = {
  authenticateFirebase,
  requirePro,
  requireAgency,
  optionalAuth,
}