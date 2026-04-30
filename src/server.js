'use strict'

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const { buildApp }                                         = require('./app')
const { logger }                                           = require('./utils/logger')
const { connectDB }                                        = require('./config/database')
const { connectRedis }                                     = require('./config/redis')
const { initFirebase }                                     = require('./config/firebase')
const { initQueues, scheduleRecurringJobs, cleanupQueues } = require('./config/queue')
const { startAllWorkers, stopAllWorkers }                  = require('./workers')

const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '0.0.0.0'

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])

const shutdown = async (app, signal) => {
  logger.info({ signal }, 'Shutdown signal received')
  try {
    await stopAllWorkers()
    await cleanupQueues()
    await app.close()
    logger.info('Server closed cleanly')
    process.exit(0)
  } catch (err) {
    logger.error({ err }, 'Error during shutdown')
    process.exit(1)
  }
}

const start = async () => {
  // 1. Firebase — synchronous init, non-fatal
  try {
    initFirebase()
    logger.info('Firebase Admin initialized')
  } catch (err) {
    logger.warn({ err: err.message }, 'Firebase init failed — auth will retry on first request')
  }

  // 2. PostgreSQL — fatal if unavailable
  try {
    await withTimeout(connectDB(), 5000, 'PostgreSQL')
    logger.info('PostgreSQL connected')
  } catch (err) {
    logger.fatal({ err: err.message }, 'PostgreSQL connection failed — cannot start')
    process.exit(1)
  }

  // 3. Redis — fatal if unavailable
  try {
    await withTimeout(connectRedis(), 5000, 'Redis')
    logger.info('Redis connected')
  } catch (err) {
    logger.fatal({ err: err.message }, 'Redis connection failed — cannot start')
    process.exit(1)
  }

  // 4. Queue init — non-fatal (setInterval-based, always fast)
  try {
    await withTimeout(Promise.resolve(initQueues()), 3000, 'Queue init')
  } catch (err) {
    logger.warn({ err: err.message }, 'Queue init failed — continuing without scheduled jobs')
  }

  // 5. Schedule recurring jobs — non-fatal
  try {
    await withTimeout(scheduleRecurringJobs(), 3000, 'scheduleRecurringJobs')
  } catch (err) {
    logger.warn({ err: err.message }, 'Job scheduling failed — continuing without recurring jobs')
  }

  // 6. Workers — non-fatal
  try {
    await withTimeout(startAllWorkers(), 3000, 'startAllWorkers')
  } catch (err) {
    logger.warn({ err: err.message }, 'Worker startup failed — continuing without workers')
  }

  // 7. Build and start Fastify
  let app
  try {
    app = await buildApp()
  } catch (err) {
    logger.fatal({ err }, 'Failed to build Fastify app')
    process.exit(1)
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
    process.once(signal, () => shutdown(app, signal))
  }

  await app.listen({ port: PORT, host: HOST })

  logger.info({
    port: PORT,
    env:  process.env.NODE_ENV,
    pid:  process.pid,
  }, 'TrendAI Backend is live')
}

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Rejection')
})

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception')
  process.exit(1)
})

start()
