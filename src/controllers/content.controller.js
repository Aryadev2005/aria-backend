'use strict'

const groqService = require('../services/ai/groq.service')
const { getDB } = require('../config/database')
const { success, errors, paginated } = require('../utils/response')
const { logger } = require('../utils/logger')

const generateContent = async (req, reply) => {
  const { trendTitle, platform, niche, songTitle, tone, language } = req.body
  const user = req.user

  try {
    const content = await groqService.generateContent({
      trendTitle,
      platform,
      niche:         niche || user.niches?.[0] || 'fashion',
      followerRange: user.followerRange || '10K–50K',
      songTitle, tone, language,
      archetype:     user.archetype,
    })

    // Save to history async — don't block response
    const sql = getDB()
    sql`
      INSERT INTO content_history (
        user_id, trend_title, platform, niche,
        hook, caption, hashtags, best_time_to_post,
        content_format, thumbnail_text, cta
      ) VALUES (
        ${user.id}, ${trendTitle}, ${platform},
        ${niche || user.niches?.[0] || 'fashion'},
        ${content.hook}, ${content.caption},
        ${JSON.stringify(content.hashtags)},
        ${content.bestTimeToPost}, ${content.contentFormat},
        ${content.thumbnailText}, ${content.cta}
      )
    `.catch(err => logger.error({ err }, 'Save content history failed'))

    return success(reply, content)
  } catch (err) {
    logger.error({ err }, 'Content generation failed')
    return errors.serviceDown(reply, 'AI content generator')
  }
}

const generateHooks = async (req, reply) => {
  const { topic, platform, niche } = req.body
  const user = req.user

  try {
    const result = await groqService.generateHooks({
      topic, platform,
      niche:         niche || user.niches?.[0] || 'fashion',
      followerRange: user.followerRange || '10K–50K',
      archetype:     user.archetype,
    })
    return success(reply, result)
  } catch (err) {
    logger.error({ err }, 'Hook generation failed')
    return errors.serviceDown(reply, 'AI hook generator')
  }
}

const rewriteHook = async (req, reply) => {
  const { hook, platform, niche } = req.body
  const user = req.user

  try {
    const result = await groqService.rewriteHook({
      hook, platform,
      niche: niche || user.niches?.[0] || 'fashion',
      archetype: user.archetype,
    })
    return success(reply, result)
  } catch (err) {
    logger.error({ err }, 'Hook rewrite failed')
    return errors.serviceDown(reply, 'AI rewriter')
  }
}

const repurposeContent = async (req, reply) => {
  const { content, sourcePlatform, targetPlatforms } = req.body

  try {
    const result = await groqService.repurposeContent({
      content, sourcePlatform, targetPlatforms,
    })
    return success(reply, result)
  } catch (err) {
    logger.error({ err }, 'Repurpose failed')
    return errors.serviceDown(reply, 'AI repurposer')
  }
}

const analyseContent = async (req, reply) => {
  const { caption, platform, niche } = req.body
  const user = req.user

  try {
    const result = await groqService.analyseContent({
      caption, platform,
      niche: niche || user.niches?.[0] || 'fashion',
      archetype: user.archetype,
    })
    return success(reply, result)
  } catch (err) {
    logger.error({ err }, 'Analysis failed')
    return errors.serviceDown(reply, 'AI analyser')
  }
}

const getHistory = async (req, reply) => {
  const { page = 1, limit = 20 } = req.query
  const offset = (page - 1) * limit
  const sql = getDB()

  try {
    const [items, [{ count }]] = await Promise.all([
      sql`
        SELECT id, trend_title, platform, niche,
               hook, caption, hashtags,
               best_time_to_post, content_format, created_at
        FROM content_history
        WHERE user_id = ${req.user.id}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`SELECT COUNT(*)::int AS count FROM content_history WHERE user_id = ${req.user.id}`,
    ])

    return paginated(reply, items, { page, limit, total: count })
  } catch (err) {
    logger.error({ err }, 'Get history failed')
    return errors.internal(reply)
  }
}

const deleteContent = async (req, reply) => {
  const sql = getDB()

  try {
    const [deleted] = await sql`
      DELETE FROM content_history
      WHERE id = ${req.params.id} AND user_id = ${req.user.id}
      RETURNING id
    `
    if (!deleted) return errors.notFound(reply, 'Content')
    return success(reply, { deleted: true })
  } catch (err) {
    logger.error({ err }, 'Delete content failed')
    return errors.internal(reply)
  }
}

module.exports = {
  generateContent, generateHooks, rewriteHook,
  repurposeContent, analyseContent, getHistory, deleteContent,
}