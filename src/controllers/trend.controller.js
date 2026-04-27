'use strict'

const groqService = require('../services/ai/groq.service')
const { cache, CacheKeys, TTL } = require('../config/redis')
const { getDB } = require('../config/database')
const { success, errors, paginated } = require('../utils/response')
const { logger } = require('../utils/logger')

const getTrends = async (req, reply) => {
  const { niche = 'fashion', platform = 'instagram', badge = 'ALL', page = 1, limit = 10 } = req.query

  const cacheKey = CacheKeys.trends(niche, platform) + `:${badge}:${page}`

  try {
    const trends = await cache.getOrSet(cacheKey, async () => {
      const sql = getDB()

      // Try live_trends table first (populated by BullMQ worker)
      const liveTrends = await sql`
        SELECT * FROM live_trends
        WHERE expires_at > NOW()
          AND (${niche} = ANY(niche_tags) OR niche_tags IS NULL)
          AND (${platform} = ANY(platform_tags) OR platform_tags IS NULL)
        ORDER BY velocity DESC
        LIMIT ${limit}
        OFFSET ${(page - 1) * limit}
      `

      if (liveTrends.length >= 3) return liveTrends

      // Fallback: generate with Groq
      return groqService.generateTrendInsights({
        niche, platform,
        followerRange: '10K-100K',
        archetype: null
      })
    }, TTL.TREND)

    let data = trends
    if (badge !== 'ALL') data = data.filter(t => t.badge === badge)
    return success(reply, data.slice(0, limit))

  } catch (err) {
    logger.error({ err }, 'Get trends failed')
    return errors.serviceDown(reply, 'Trend engine')
  }
}

const getPersonalizedTrends = async (req, reply) => {
  const user = req.user
  const niche = user.niches?.[0] || 'fashion'
  const platform = user.primaryPlatform || 'instagram'

  try {
    const cacheKey = `tr:personal:${user.id}`

    const trends = await cache.getOrSet(cacheKey, async () => {
      const sql = getDB()

      // Get live trends from DB
      const liveTrends = await sql`
        SELECT title, search_volume, velocity, niche_tags, platform_tags
        FROM live_trends
        WHERE expires_at > NOW()
        ORDER BY velocity DESC
        LIMIT 20
      `

      // Feed live data into Groq with user's archetype
      return groqService.generateTrendInsights({
        niche,
        platform,
        followerRange: user.followerRange || '10K–50K',
        archetype: user.archetype,
        liveTrendsContext: liveTrends.map(t => t.title).join(', ')
      })
    }, 300) // 5 min cache per user

    return success(reply, trends)

  } catch (err) {
    logger.error({ err }, 'Personalized trends failed')
    return errors.serviceDown(reply, 'Trend engine')
  }
}

const getOpportunityWindows = async (req, reply) => {
  try {
    const user = req.user
    const trends = await groqService.generateTrendInsights({
      niche: user.niches?.[0] || 'fashion',
      platform: user.primaryPlatform || 'instagram',
      followerRange: user.followerRange || '10K–50K',
      archetype: user.archetype,
    })

    // Filter to only trends with high opportunity score
    const windows = trends.trends
      .filter(t => t.opportunityScore >= 85)
      .sort((a, b) => b.opportunityScore - a.opportunityScore)

    return success(reply, windows)
  } catch (err) {
    logger.error({ err }, 'Opportunity windows failed')
    return errors.serviceDown(reply, 'Trend engine')
  }
}

const getViralRadar = async (req, reply) => {
  try {
    const user = req.user
    const result = await groqService.generateTrendInsights({
      niche: user.niches?.[0] || 'fashion',
      platform: user.primaryPlatform || 'instagram',
      followerRange: user.followerRange || '10K–50K',
      archetype: user.archetype,
    })

    const viralTrends = result.trends
      .filter(t => t.badge === 'HOT' || t.velocity >= 90)
      .slice(0, 5)

    return success(reply, viralTrends)
  } catch (err) {
    logger.error({ err }, 'Viral radar failed')
    return errors.serviceDown(reply, 'Trend engine')
  }
}

const getTrendById = async (req, reply) => {
  try {
    const cacheKey = CacheKeys.trendById(req.params.id)
    const cached = await cache.get(cacheKey)
    if (cached) return success(reply, cached)
    return errors.notFound(reply, 'Trend')
  } catch (err) {
    return errors.internal(reply)
  }
}

const saveTrend = async (req, reply) => {
  try {
    const sql = getDB()
    await sql`
      INSERT INTO saved_trends (user_id, trend_id, saved_at)
      VALUES (${req.user.id}, ${req.params.id}, NOW())
      ON CONFLICT DO NOTHING
    `
    return success(reply, { saved: true })
  } catch (err) {
    logger.error({ err }, 'Save trend failed')
    return errors.internal(reply)
  }
}

const unsaveTrend = async (req, reply) => {
  try {
    const sql = getDB()
    await sql`
      DELETE FROM saved_trends
      WHERE user_id = ${req.user.id} AND trend_id = ${req.params.id}
    `
    return success(reply, { unsaved: true })
  } catch (err) {
    logger.error({ err }, 'Unsave trend failed')
    return errors.internal(reply)
  }
}

const getSavedTrends = async (req, reply) => {
  try {
    const sql = getDB()
    const trends = await sql`
      SELECT * FROM saved_trends
      WHERE user_id = ${req.user.id}
      ORDER BY saved_at DESC
    `
    return success(reply, trends)
  } catch (err) {
    logger.error({ err }, 'Get saved trends failed')
    return errors.internal(reply)
  }
}

const submitFeedback = async (req, reply) => {
  const { recommendationType, recommendationData, wasHelpful, resultNotes } = req.body
  const sql = getDB()

  try {
    const [feedback] = await sql`
      INSERT INTO aria_feedback (user_id, recommendation_type, recommendation_data, was_helpful, result_notes)
      VALUES (${req.user.id}, ${recommendationType}, ${JSON.stringify(recommendationData)}, ${wasHelpful}, ${resultNotes})
      RETURNING id, created_at
    `

    return success(reply, {
      id: feedback.id,
      message: 'Feedback recorded. ARIA learns from this!',
      createdAt: feedback.createdAt,
    })
  } catch (err) {
    logger.error({ err }, 'Submit feedback failed')
    return errors.internal(reply)
  }
}

module.exports = {
  getTrends,
  getPersonalizedTrends,
  getOpportunityWindows,
  getViralRadar,
  getTrendById,
  saveTrend,
  unsaveTrend,
  getSavedTrends,
  submitFeedback,
}