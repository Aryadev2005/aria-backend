'use strict'

const { Worker } = require('bullmq')
const { getRedisClient } = require('../config/redis')
const { getDB } = require('../config/database')
const { logger } = require('../utils/logger')
const { scrapeAndSaveProfile } = require('../services/scraper.service')
const groqService = require('../services/ai/groq.service')

/**
 * Process profile scrape job
 * Scrapes Instagram profile and triggers ARIA re-analysis
 */
const processScrapeJob = async (job) => {
  const { userId, handle, platform } = job.data
  const sql = getDB()

  try {
    logger.info({ userId, handle, platform, jobId: job.id }, 'Processing scrape job')

    // Step 1: Scrape profile
    const scrapeResult = await scrapeAndSaveProfile(userId, handle, platform)

    logger.info(
      { userId, followers: scrapeResult.followers, jobId: job.id },
      'Profile scraped successfully'
    )

    // Step 2: Fetch updated user data with scraped info
    const user = await sql`
      SELECT * FROM users WHERE id = ${userId}
    `

    if (!user || user.length === 0) {
      throw new Error(`User ${userId} not found`)
    }

    const updatedUser = user[0]

    // Step 3: Trigger ARIA re-analysis with new scraped data
    try {
      const archetypeResult = await groqService.detectArchetype({
        niche: updatedUser.niches?.[0] || 'fashion',
        platform: updatedUser.primary_platform || 'instagram',
        followerRange: updatedUser.follower_range || '0-1K',
        creatorIntent: updatedUser.creator_intent,
        scrapedData: updatedUser.scraped_summary,
      })

      // Update archetype and health score
      await sql`
        UPDATE users SET
          archetype = ${archetypeResult.archetype},
          archetype_label = ${archetypeResult.archetypeLabel},
          archetype_confidence = ${archetypeResult.archetypeConfidence},
          growth_stage = ${archetypeResult.growthStage},
          tone_profile = ${archetypeResult.toneProfile},
          health_score = ${archetypeResult.healthScore || 75},
          aria_analyzed_at = NOW()
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
      // Don't fail the job if ARIA update fails - scraping was successful
    }

    logger.info({ userId, jobId: job.id }, 'Scrape job completed successfully')
    return {
      success: true,
      followers: scrapeResult.followers,
      engagementRate: scrapeResult.engagement_rate,
    }
  } catch (err) {
    logger.error({ err, userId, handle, jobId: job.id }, 'Scrape job failed')
    throw err
  }
}

/**
 * Create and start the scrape worker
 */
const startScrapeWorker = async () => {
  const SCRAPE_ENABLED = process.env.SCRAPE_ENABLED !== 'false'

  if (!SCRAPE_ENABLED) {
    logger.info('Scrape worker disabled via SCRAPE_ENABLED')
    return null
  }

  const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '2', 10)

  const worker = new Worker('profile-scrape', processScrapeJob, {
    connection: getRedisClient(),
    concurrency,
  })

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Scrape job completed')
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err, userId: job?.data?.userId },
      'Scrape job failed - marking for retry'
    )
    // Worker continues running despite failures
  })

  worker.on('error', (err) => {
    logger.error({ err }, 'Scrape worker error')
  })

  logger.info({ concurrency }, 'Scrape worker started')
  return worker
}

// Export for standalone execution
if (require.main === module) {
  ;(async () => {
    try {
      const { connectRedis } = require('../config/redis')
      const { connectDB } = require('../config/database')

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
