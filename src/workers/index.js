'use strict'

const { logger } = require('../utils/logger')
const { startTrendWorker }  = require('./trend.worker')
const { startSongWorker }   = require('./song.worker')
const { startScrapeWorker } = require('./scrape.worker')

let allWorkers = []

const startAllWorkers = async () => {
  logger.info('Starting workers...')
  const workers = []

  // Each worker is started independently — one failure never blocks the others.
  const attempts = [
    { name: 'trend',  start: startTrendWorker },
    { name: 'song',   start: startSongWorker },
    { name: 'scrape', start: startScrapeWorker },
  ]

  for (const { name, start } of attempts) {
    try {
      const worker = await start()
      if (worker) workers.push({ name, worker })
    } catch (err) {
      logger.warn({ err: err.message, worker: name }, 'Worker failed to start — skipping')
    }
  }

  allWorkers = workers
  logger.info({ count: workers.length }, 'Worker startup complete')
  return workers
}

const stopAllWorkers = async () => {
  logger.info({ count: allWorkers.length }, 'Stopping workers...')

  await Promise.allSettled(
    allWorkers.map(({ name, worker }) =>
      worker.close()
        .then(() => logger.info({ worker: name }, 'Worker stopped'))
        .catch(err => logger.warn({ err, worker: name }, 'Error stopping worker'))
    )
  )

  allWorkers = []
  logger.info('All workers stopped')
}

const getWorkerStatus = () =>
  allWorkers.map(({ name, worker }) => ({
    name,
    isRunning: worker && !worker.closing,
  }))

module.exports = { startAllWorkers, stopAllWorkers, getWorkerStatus }
