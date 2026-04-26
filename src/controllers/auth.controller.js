'use strict'

const { cache, CacheKeys } = require('../config/redis')
const { getDB } = require('../config/database')
const { success, errors } = require('../utils/response')
const { logger } = require('../utils/logger')

const firebaseLogin = async (req, reply) => {
  try {
    const { fcmToken, platform } = req.body
    const user = req.user

    // Update FCM token for push notifications
    if (fcmToken) {
      const sql = getDB()
      await sql`
        UPDATE users
        SET fcm_token = ${fcmToken}, platform = ${platform}, updated_at = NOW()
        WHERE id = ${user.id}
      `.catch(() => {})
    }

    return success(reply, {
      user: {
        id:              user.id,
        email:           user.email,
        name:            user.name,
        photoUrl:        user.photoUrl,
        followerRange:   user.followerRange,
        primaryPlatform: user.primaryPlatform,
        niches:          user.niches,
        isPro:           user.isPro,
        subscriptionTier: user.subscriptionTier,
      },
      isNewUser: !user.primaryPlatform,
    })
  } catch (err) {
    logger.error({ err }, 'Firebase login failed')
    return errors.internal(reply)
  }
}

const logout = async (req, reply) => {
  try {
    // Clear user cache
    await cache.del(CacheKeys.user(req.user.id))

    // Clear FCM token
    const sql = getDB()
    await sql`
      UPDATE users SET fcm_token = NULL WHERE id = ${req.user.id}
    `.catch(() => {})

    return success(reply, { loggedOut: true })
  } catch (err) {
    logger.error({ err }, 'Logout failed')
    return errors.internal(reply)
  }
}

const getMe = async (req, reply) => {
  return success(reply, {
    id:              req.user.id,
    email:           req.user.email,
    name:            req.user.name,
    photoUrl:        req.user.photoUrl,
    followerRange:   req.user.followerRange,
    primaryPlatform: req.user.primaryPlatform,
    niches:          req.user.niches,
    isPro:           req.user.isPro,
    subscriptionTier: req.user.subscriptionTier,
    createdAt:       req.user.createdAt,
  })
}

const deleteAccount = async (req, reply) => {
  try {
    const sql = getDB()
    await sql`DELETE FROM users WHERE id = ${req.user.id}`
    await cache.del(CacheKeys.user(req.user.id))
    return success(reply, { deleted: true })
  } catch (err) {
    logger.error({ err }, 'Delete account failed')
    return errors.internal(reply)
  }
}

module.exports = { firebaseLogin, logout, getMe, deleteAccount }