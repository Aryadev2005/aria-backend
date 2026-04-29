'use strict'

const { Queue }        = require('bullmq')
const { getRedisClient } = require('./redis')
const { logger }       = require('../utils/logger')

// ─── Queues are null until initQueues() is called ────────────────────────────
// This prevents BullMQ from trying to connect to Redis at module load time,
// which was causing the server to hang silently on startup.
let trendQueue  = null
let songQueue   = null
let scrapeQueue = null

// ─────────────────────────────────────────────────────────────────────────────
// INIT — call this from server.js AFTER connectRedis() resolves
// ─────────────────────────────────────────────────────────────────────────────
const initQueues = () => {
  if (trendQueue) return { trendQueue, songQueue, scrapeQueue } // Already done

  const connection = getRedisClient()
  if (!connection) {
    logger.error('Cannot initialize queues: Redis not connected')
    throw new Error('Redis connection required for BullMQ')
  }

  trendQueue  = new Queue('trend-refresh',  { connection })
  songQueue   = new Queue('song-refresh',   { connection })
  scrapeQueue = new Queue('profile-scrape', { connection })

  logger.info('BullMQ queues initialized')
  return { trendQueue, songQueue, scrapeQueue }
}

const getQueues = () => {
  if (!trendQueue) return initQueues()
  return { trendQueue, songQueue, scrapeQueue }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE — call once from server.js after initQueues()
// ─────────────────────────────────────────────────────────────────────────────
const scheduleRecurringJobs = async () => {
  try {
    const TRENDS_ENABLED = process.env.TRENDS_ENABLED !== 'false'
    const SONGS_ENABLED  = process.env.SONGS_ENABLED  !== 'false'

    const { trendQueue: tq, songQueue: sq } = getQueues()

    if (TRENDS_ENABLED) {
  await Promise.race([
    tq.add('fetch-india-trends', {}, {
      repeat:           { pattern: '0 */6 * * *' },  // every 6 hours
      jobId:            'india-trends-recurring',
      removeOnComplete: { count: 10 },
      removeOnFail:     { count: 5 },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 5000)
    ),
  ])
}

if (SONGS_ENABLED) {
  await Promise.race([
    sq.add('fetch-spotify-charts', {}, {
      repeat:           { pattern: '0 */2 * * *' },  // every 2 hours
      jobId:            'spotify-charts-recurring',
      removeOnComplete: { count: 10 },
      removeOnFail:     { count: 5 },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 5000)
    ),
  ])
}

logger.info('BullMQ recurring jobs scheduled successfully')
} catch (err) {
  // Non-fatal — server works without recurring jobs
  logger.warn({ err: err.message }, 'BullMQ scheduling failed — continuing without recurring jobs')
}
}
// ─────────────────────────────────────────────────────────────────────────────
// SCRAPE — one-off job triggered from analytics.controller.js
// ─────────────────────────────────────────────────────────────────────────────
const enqueueScrapeJob = async (userId, handle, platform) => {
  try {
    const SCRAPE_ENABLED = process.env.SCRAPE_ENABLED !== 'false'

    if (!SCRAPE_ENABLED) {
      logger.warn('Scraping disabled via SCRAPE_ENABLED env var')
      return null
    }

    // Check Python exists before queuing — fail fast
    const { execSync } = require('child_process')
    try {
      execSync('python3 --version', { stdio: 'ignore' })
    } catch {
      logger.error('Cannot enqueue scrape job: python3 not found')
      throw new Error('python3 is required for scraping')
    }

    const { scrapeQueue: sq } = getQueues()
    const job = await sq.add('scrape-profile', { userId, handle, platform }, {
      attempts:         2,
      backoff:          { type: 'exponential', delay: 5000 },
      removeOnComplete: 20,
      removeOnFail:     10,
    })

    logger.info({ userId, handle, platform, jobId: job.id }, 'Scrape job enqueued')
    return job.id
  } catch (err) {
    logger.error({ err, userId, handle }, 'Failed to enqueue scrape job')
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP — called during server shutdown
// ─────────────────────────────────────────────────────────────────────────────
const cleanupQueues = async () => {
  try {
    if (!trendQueue) return // Never initialized — nothing to close
    await Promise.allSettled([
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
  initQueues,
  getQueues,
  scheduleRecurringJobs,
  enqueueScrapeJob,
  cleanupQueues,
}