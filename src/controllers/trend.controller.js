'use strict'

const claudeService = require('../services/ai/claude.service')
const { cache, CacheKeys, TTL } = require('../config/redis')
const { getDB } = require('../config/database')
const { success, errors, paginated } = require('../utils/response')
const { logger } = require('../utils/logger')

const getTrends = async (req, reply) => {
  const { niche, platform, badge, limit, page } = req.query

  try {
    const cacheKey = CacheKeys.trends(niche, platform)
    const cached = await cache.get(cacheKey)
    if (cached) {
      let data = cached
      if (badge !== 'ALL') data = data.filter(t => t.badge === badge)
      return success(reply, data.slice(0, limit))
    }

    // Generate with Claude AI
    const trends = await claudeService.generateTrendInsights({
      niche, platform,
      followerRange: '10K–50K',
    })

    await cache.set(cacheKey, trends, TTL.TREND)

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
    const cached = await cache.get(cacheKey)
    if (cached) return success(reply, cached)

    const trends = await claudeService.generateTrendInsights({
      niche, platform,
      followerRange: user.followerRange || '10K–50K',
    })

    await cache.set(cacheKey, trends, TTL.TREND)
    return success(reply, trends)

  } catch (err) {
    logger.error({ err }, 'Personalized trends failed')
    return errors.serviceDown(reply, 'Trend engine')
  }
}

const getOpportunityWindows = async (req, reply) => {
  try {
    const user = req.user
    const trends = await claudeService.generateTrendInsights({
      niche: user.niches?.[0] || 'fashion',
      platform: user.primaryPlatform || 'instagram',
      followerRange: user.followerRange || '10K–50K',
    })

    // Filter to only trends with high opportunity score
    const windows = trends
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
    const trends = await claudeService.generateTrendInsights({
      niche: user.niches?.[0] || 'fashion',
      platform: user.primaryPlatform || 'instagram',
      followerRange: user.followerRange || '10K–50K',
    })

    const viralTrends = trends
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

module.exports = {
  getTrends,
  getPersonalizedTrends,
  getOpportunityWindows,
  getViralRadar,
  getTrendById,
  saveTrend,
  unsaveTrend,
  getSavedTrends,
}