'use strict'

const { logger } = require('../utils/logger')
const { startTrendWorker } = require('./trend.worker')
const { startSongWorker } = require('./song.worker')
const { startScrapeWorker } = require('./scrape.worker')

let allWorkers = []

/**
 * Start all BullMQ workers
 * Called from server.js after scheduleRecurringJobs()
 */
const startAllWorkers = async () => {
  try {
    logger.info('Starting all workers...')

    const workers = []

    // Start trend worker
    const trendWorker = await startTrendWorker()
    if (trendWorker) {
      workers.push({ name: 'trend', worker: trendWorker })
    }

    // Start song worker
    const songWorker = await startSongWorker()
    if (songWorker) {
      workers.push({ name: 'song', worker: songWorker })
    }

    // Start scrape worker
    const scrapeWorker = await startScrapeWorker()
    if (scrapeWorker) {
      workers.push({ name: 'scrape', worker: scrapeWorker })
    }

    allWorkers = workers

    const activeWorkerCount = workers.length
    logger.info({ count: activeWorkerCount }, 'All workers started successfully')

    return workers
  } catch (err) {
    logger.error({ err }, 'Failed to start workers')
    throw err
  }
}

/**
 * Gracefully stop all workers
 * Called during server shutdown
 */
const stopAllWorkers = async () => {
  try {
    logger.info({ count: allWorkers.length }, 'Stopping all workers...')

    const stopPromises = allWorkers.map(({ name, worker }) => {
      return worker.close()
        .then(() => logger.info({ worker: name }, 'Worker stopped'))
        .catch(err => logger.warn({ err, worker: name }, 'Error stopping worker'))
    })

    await Promise.all(stopPromises)
    allWorkers = []

    logger.info('All workers stopped')
  } catch (err) {
    logger.error({ err }, 'Error stopping workers')
  }
}

/**
 * Get status of all workers
 */
const getWorkerStatus = () => {
  return allWorkers.map(({ name, worker }) => ({
    name,
    isRunning: worker && !worker.closing,
  }))
}

module.exports = { startAllWorkers, stopAllWorkers, getWorkerStatus }
