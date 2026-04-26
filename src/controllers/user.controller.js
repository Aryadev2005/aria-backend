'use strict'

const { cache, CacheKeys, TTL } = require('../config/redis')
const { getDB } = require('../config/database')
const { success, errors } = require('../utils/response')
const { logger } = require('../utils/logger')

const getProfile = async (req, reply) => {
  try {
    const cached = await cache.get(CacheKeys.user(req.user.id))
    if (cached) return success(reply, cached)

    const sql = getDB()
    const [user] = await sql`
      SELECT id, email, name, photo_url, bio,
             follower_range, primary_platform, niches,
             instagram_handle, youtube_handle,
             is_pro, subscription_tier, created_at
      FROM users WHERE id = ${req.user.id}
    `
    if (!user) return errors.notFound(reply, 'User')

    await cache.set(CacheKeys.user(user.id), user, TTL.USER)
    return success(reply, user)
  } catch (err) {
    logger.error({ err }, 'Get profile failed')
    return errors.internal(reply)
  }
}

const updateProfile = async (req, reply) => {
  try {
    const { name, instagramHandle, youtubeHandle, bio, fcmToken } = req.body
    const sql = getDB()

    const [updated] = await sql`
      UPDATE users SET
        name              = COALESCE(${name}, name),
        instagram_handle  = COALESCE(${instagramHandle}, instagram_handle),
        youtube_handle    = COALESCE(${youtubeHandle}, youtube_handle),
        bio               = COALESCE(${bio}, bio),
        fcm_token         = COALESCE(${fcmToken}, fcm_token),
        updated_at        = NOW()
      WHERE id = ${req.user.id}
      RETURNING id, email, name, photo_url, bio,
                follower_range, primary_platform, niches,
                instagram_handle, youtube_handle, is_pro
    `

    await cache.del(CacheKeys.user(req.user.id))
    return success(reply, updated)
  } catch (err) {
    logger.error({ err }, 'Update profile failed')
    return errors.internal(reply)
  }
}

const completeOnboarding = async (req, reply) => {
  try {
    const { followerRange, primaryPlatform, niches } = req.body
    const sql = getDB()

    const [updated] = await sql`
      UPDATE users SET
        follower_range    = ${followerRange},
        primary_platform  = ${primaryPlatform},
        niches            = ${JSON.stringify(niches)},
        updated_at        = NOW()
      WHERE id = ${req.user.id}
      RETURNING id, email, name, follower_range,
                primary_platform, niches, is_pro
    `

    await cache.del(CacheKeys.user(req.user.id))
    logger.info({ userId: req.user.id }, 'Onboarding completed')
    return success(reply, updated)
  } catch (err) {
    logger.error({ err }, 'Onboarding failed')
    return errors.internal(reply)
  }
}

const getStats = async (req, reply) => {
  try {
    const cacheKey = CacheKeys.userStats(req.user.id)
    const cached = await cache.get(cacheKey)
    if (cached) return success(reply, cached)

    // Mock stats — replace with real Instagram API data later
    const stats = {
      followers:     24500,
      following:     892,
      posts:         147,
      engagement:    4.8,
      avgLikes:      1180,
      avgComments:   42,
      avgSaves:      89,
      reach:         45000,
      impressions:   78000,
      profileVisits: 3400,
      growth:        '+2.4% this week',
      bestDay:       'Wednesday',
      bestTime:      '7:00 PM IST',
    }

    await cache.set(cacheKey, stats, 300)
    return success(reply, stats)
  } catch (err) {
    logger.error({ err }, 'Get stats failed')
    return errors.internal(reply)
  }
}

const updateSubscription = async (req, reply) => {
  try {
    const { tier } = req.body
    const sql = getDB()

    const [updated] = await sql`
      UPDATE users SET
        subscription_tier = ${tier},
        is_pro = ${tier !== 'free'},
        updated_at = NOW()
      WHERE id = ${req.user.id}
      RETURNING id, subscription_tier, is_pro
    `

    await cache.del(CacheKeys.user(req.user.id))
    return success(reply, updated)
  } catch (err) {
    logger.error({ err }, 'Subscription update failed')
    return errors.internal(reply)
  }
}

module.exports = {
  getProfile,
  updateProfile,
  completeOnboarding,
  getStats,
  updateSubscription,
}