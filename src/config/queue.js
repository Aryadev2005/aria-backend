'use strict'

const { Queue } = require('bullmq')
const { getRedisClient } = require('./redis')
const { logger } = require('../utils/logger')

/**
 * BullMQ Queue Configuration
 *
 * Environment Variables:
 *  SCRAPE_ENABLED=true          # Set false to disable scraping feature
 *  TRENDS_ENABLED=true          # Set false to use only Groq-generated trends
 *  SONGS_ENABLED=true           # Set false to use only Groq-generated songs
 *  WORKER_CONCURRENCY=2         # Scrape worker concurrency
 */

// Three queues for different job types
const trendQueue = new Queue('trend-refresh', { connection: getRedisClient() })
const songQueue = new Queue('song-refresh', { connection: getRedisClient() })
const scrapeQueue = new Queue('profile-scrape', { connection: getRedisClient() })

/**
 * Schedule recurring jobs for trend and song refreshes
 * Call once from server.js after Redis connects
 */
const scheduleRecurringJobs = async () => {
  try {
    const TRENDS_ENABLED = process.env.TRENDS_ENABLED !== 'false'
    const SONGS_ENABLED = process.env.SONGS_ENABLED !== 'false'

    if (TRENDS_ENABLED) {
      // Trends every 6 hours
      await trendQueue.add('fetch-india-trends', {}, {
        repeat: { every: 6 * 60 * 60 * 1000 },
        jobId: 'india-trends-recurring',
        removeOnComplete: 10,
        removeOnFail: 5,
      })
      logger.info('BullMQ scheduled: trends refresh every 6 hours')
    }

    if (SONGS_ENABLED) {
      // Songs every 2 hours
      await songQueue.add('fetch-spotify-charts', {}, {
        repeat: { every: 2 * 60 * 60 * 1000 },
        jobId: 'spotify-charts-recurring',
        removeOnComplete: 10,
        removeOnFail: 5,
      })
      logger.info('BullMQ scheduled: songs refresh every 2 hours')
    }

    logger.info('BullMQ recurring jobs scheduled successfully')
  } catch (err) {
    logger.error({ err }, 'Failed to schedule recurring jobs')
    throw err
  }
}

/**
 * Enqueue a one-off profile scrape job
 * Called from analytics.controller.js triggerScrape()
 */
const enqueueScrapeJob = async (userId, handle, platform) => {
  try {
    const SCRAPE_ENABLED = process.env.SCRAPE_ENABLED !== 'false'

    if (!SCRAPE_ENABLED) {
      logger.warn('Scraping is disabled via SCRAPE_ENABLED env var')
      return null
    }

    const job = await scrapeQueue.add('scrape-profile', { userId, handle, platform }, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 20,
      removeOnFail: 10,
    })

    logger.info({ userId, handle, platform, jobId: job.id }, 'Scrape job enqueued')
    return job.id
  } catch (err) {
    logger.error({ err, userId, handle }, 'Failed to enqueue scrape job')
    throw err
  }
}

/**
 * Clean up all queues gracefully
 * Called during server shutdown
 */
const cleanupQueues = async () => {
  try {
    await Promise.all([
      trendQueue.close(),
      songQueue.close(),
      scrapeQueue.close(),
    ])
    logger.info('All BullMQ queues closed')
  } catch (err) {
    logger.error({ err }, 'Error closing BullMQ queues')
  }
}

module.exports = {
  trendQueue,
  songQueue,
  scrapeQueue,
  scheduleRecurringJobs,
  enqueueScrapeJob,
  cleanupQueues,
}
