import { logger } from '../utils/logger'
import { startTrendWorker } from './trend.worker'
import { startSongWorker } from './song.worker'
import { startScrapeWorker } from './scrape.worker'

let allWorkers: { name: string, worker: any }[] = []

export const startAllWorkers = async () => {
  logger.info('Starting workers...')
  const workers: { name: string, worker: any }[] = []

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
    } catch (err: any) {
      logger.warn({ err: err.message, worker: name }, 'Worker failed to start — skipping')
    }
  }

  allWorkers = workers
  logger.info({ count: workers.length }, 'Worker startup complete')
  return workers
}

export const stopAllWorkers = async () => {
  logger.info({ count: allWorkers.length }, 'Stopping workers...')

  await Promise.allSettled(
    allWorkers.map(({ name, worker }) =>
      worker.close()
        .then(() => logger.info({ worker: name }, 'Worker stopped'))
        .catch((err: any) => logger.warn({ err, worker: name }, 'Error stopping worker'))
    )
  )

  allWorkers = []
  logger.info('All workers stopped')
}

export const getWorkerStatus = () =>
  allWorkers.map(({ name, worker }) => ({
    name,
    isRunning: worker && !worker.closing,
  }))
