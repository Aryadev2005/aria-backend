import { logger } from '../utils/logger'
import { execSync } from 'child_process'

// setInterval handles — cleared on shutdown
let trendInterval: NodeJS.Timeout | null = null
let songInterval: NodeJS.Timeout | null  = null

export const initQueues = () => {
  // No-op: replaced BullMQ Queue with setInterval-based scheduling.
  // Actual scheduling starts in scheduleRecurringJobs() after DB/Redis are ready.
  logger.info('Queue system ready (setInterval mode — no BullMQ Queue)')
}

// Kept for API compatibility; no live queues exist in this mode.
export const getQueues = () => ({ trendQueue: null, songQueue: null, scrapeQueue: null })

export const scheduleRecurringJobs = async () => {
  try {
    const TRENDS_ENABLED = process.env.TRENDS_ENABLED !== 'false'
    const SONGS_ENABLED  = process.env.SONGS_ENABLED  !== 'false'

    if (TRENDS_ENABLED) {
      const { processTrendJob } = require('../workers/trend.worker')
      const INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

      // First run deferred 15s so DB/Redis settle after startup
      setTimeout(async () => {
        try {
          await processTrendJob({ id: `trend-init-${Date.now()}`, data: {} })
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Initial trend job failed (non-fatal)')
        }
      }, 15_000)

      trendInterval = setInterval(async () => {
        try {
          await processTrendJob({ id: `trend-${Date.now()}`, data: {} })
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Scheduled trend job failed')
        }
      }, INTERVAL_MS)

      logger.info('Trend scheduler started (every 6 hours, first run in 15s)')
    }

    if (SONGS_ENABLED) {
      const { processSongJob } = require('../workers/song.worker')
      const INTERVAL_MS = 2 * 60 * 60 * 1000 // 2 hours

      setTimeout(async () => {
        try {
          await processSongJob({ id: `song-init-${Date.now()}`, data: {} })
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Initial song job failed (non-fatal)')
        }
      }, 20_000)

      songInterval = setInterval(async () => {
        try {
          await processSongJob({ id: `song-${Date.now()}`, data: {} })
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Scheduled song job failed')
        }
      }, INTERVAL_MS)

      logger.info('Song scheduler started (every 2 hours, first run in 20s)')
    }

    logger.info('Recurring job schedulers started')
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Scheduler setup failed — continuing without recurring jobs')
  }
}

export const enqueueScrapeJob = async (userId: string, handle: string, platform: string) => {
  try {
    const SCRAPE_ENABLED = process.env.SCRAPE_ENABLED !== 'false'
    if (!SCRAPE_ENABLED) {
      logger.warn('Scraping disabled via SCRAPE_ENABLED env var')
      return null
    }

    try {
      execSync('python3 --version', { stdio: 'ignore' })
    } catch {
      logger.error('Cannot enqueue scrape job: python3 not found')
      throw new Error('python3 is required for scraping')
    }

    const { processScrapeJob } = require('../workers/scrape.worker')
    const jobId = `scrape-${Date.now()}`

    // Fire-and-forget — never blocks the caller
    setImmediate(async () => {
      try {
        await processScrapeJob({ id: jobId, data: { userId, handle, platform } })
      } catch (err) {
        logger.error({ err, userId, handle }, 'Scrape job failed')
      }
    })

    logger.info({ userId, handle, platform, jobId }, 'Scrape job enqueued')
    return jobId
  } catch (err) {
    logger.error({ err, userId, handle }, 'Failed to enqueue scrape job')
    throw err
  }
}

export const cleanupQueues = async () => {
  if (trendInterval) { clearInterval(trendInterval); trendInterval = null }
  if (songInterval)  { clearInterval(songInterval);  songInterval  = null }
  logger.info('Schedulers stopped')
}
