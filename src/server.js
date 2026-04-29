'use strict'

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const { buildApp } = require('./app')
const { logger } = require('./utils/logger')
const { connectDB } = require('./config/database')
const { connectRedis } = require('./config/redis')
const { initFirebase } = require('./config/firebase')
const { scheduleRecurringJobs, cleanupQueues } = require('./config/queue')
const { startAllWorkers, stopAllWorkers } = require('./workers')

const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '0.0.0.0'

const shutdown = async (app, signal) => {
  logger.info({ signal }, 'Shutdown signal received')
  try {
    // Stop workers before closing server
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
  try {
    await initFirebase()
    logger.info('Firebase Admin initialized')

    const db = await connectDB()
    if (db) {
      logger.info('PostgreSQL connected')
      
      // Initialize LangGraph checkpointer
      const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres')
      const checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL)
      await checkpointer.setup()
      logger.info('LangGraph checkpointer ready')
    }

    await connectRedis()
    logger.info('Redis connected')

    // Schedule recurring jobs (trends every 6h, songs every 2h)
    await scheduleRecurringJobs()

    // Start all workers
    await startAllWorkers()

    const app = await buildApp()

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
      process.once(signal, () => shutdown(app, signal))
    }

    await app.listen({ port: PORT, host: HOST })

    logger.info({
      port: PORT,
      env: process.env.NODE_ENV,
      pid: process.pid,
    }, '🚀 TrendAI Backend is live')

  } catch (err) {
    logger.error({ err }, 'Failed to start server')
    process.exit(1)
  }
}

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Rejection')
})

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception')
  process.exit(1)
})

start()