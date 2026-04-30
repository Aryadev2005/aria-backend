'use strict'

const { getDB }    = require('../config/database')
const { logger }   = require('../utils/logger')
const { scrapeAndSaveProfile } = require('../services/scraper.service')
const groqService  = require('../services/ai/groq.service')

// Scheduling/dispatch is handled by enqueueScrapeJob() in src/config/queue.js

// Accepts a plain job-like object: { id: string, data: { userId, handle, platform } }
const processScrapeJob = async (job) => {
  const { userId, handle, platform } = job.data
  const sql = getDB()

  try {
    logger.info({ userId, handle, platform, jobId: job.id }, 'Processing scrape job')

    const scrapeResult = await scrapeAndSaveProfile(userId, handle, platform)

    logger.info(
      { userId, followers: scrapeResult.followers, jobId: job.id },
      'Profile scraped successfully'
    )

    const user = await sql`SELECT * FROM users WHERE id = ${userId}`
    if (!user || user.length === 0) throw new Error(`User ${userId} not found`)
    const updatedUser = user[0]

    try {
      const archetypeResult = await groqService.detectArchetype({
        niche:         updatedUser.niches?.[0] || 'fashion',
        platform:      updatedUser.primary_platform || 'instagram',
        followerRange: updatedUser.follower_range || '0-1K',
        creatorIntent: updatedUser.creator_intent,
        scrapedData:   updatedUser.scraped_summary,
      })

      await sql`
        UPDATE users SET
          archetype             = ${archetypeResult.archetype},
          archetype_label       = ${archetypeResult.archetypeLabel},
          archetype_confidence  = ${archetypeResult.archetypeConfidence},
          growth_stage          = ${archetypeResult.growthStage},
          tone_profile          = ${archetypeResult.toneProfile},
          health_score          = ${archetypeResult.healthScore || 75},
          aria_analyzed_at      = NOW()
        WHERE id = ${userId}
      `

      logger.info(
        { userId, archetype: archetypeResult.archetype, jobId: job.id },
        'ARIA archetype updated'
      )
    } catch (aiErr) {
      logger.warn(
        { err: aiErr, userId, jobId: job.id },
        'ARIA re-analysis failed (non-blocking)'
      )
    }

    logger.info({ userId, jobId: job.id }, 'Scrape job completed successfully')
    return {
      success:         true,
      followers:       scrapeResult.followers,
      engagementRate:  scrapeResult.engagement_rate,
    }
  } catch (err) {
    logger.error({ err, userId, handle, jobId: job.id }, 'Scrape job failed')
    throw err
  }
}

// Dispatch is handled by enqueueScrapeJob() in queue.js — nothing to instantiate here.
const startScrapeWorker = async () => {
  const SCRAPE_ENABLED = process.env.SCRAPE_ENABLED !== 'false'
  if (!SCRAPE_ENABLED) {
    logger.info('Scrape worker disabled via SCRAPE_ENABLED=false')
    return null
  }
  logger.info('Scrape processor ready (dispatched on-demand via queue.js)')
  return null
}

// Standalone execution support
if (require.main === module) {
  ;(async () => {
    try {
      const { connectRedis } = require('../config/redis')
      const { connectDB }    = require('../config/database')
      await connectRedis()
      await connectDB()
      await startScrapeWorker()
      logger.info('Scrape worker running...')
    } catch (err) {
      logger.error({ err }, 'Failed to start scrape worker')
      process.exit(1)
    }
  })()
}

module.exports = { startScrapeWorker, processScrapeJob }
