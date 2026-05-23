import 'dotenv/config'

import { buildApp } from './app'
import { logger } from './utils/logger'
import { connectDB } from './config/database'
import { connectRedis } from './config/redis'
import { initFirebase } from './config/firebase'
import { validateEnv } from './utils/validateEnv'
import { FastifyInstance } from 'fastify'

const PORT = parseInt(process.env.PORT || '3000', 10)
const HOST = process.env.HOST || '0.0.0.0'

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])

const shutdown = async (app: FastifyInstance, signal: string) => {
  logger.info({ signal }, 'Shutdown signal received')
  try {
    await app.close()
    logger.info('Server closed cleanly')
    process.exit(0)
  } catch (err) {
    logger.error({ err }, 'Error during shutdown')
    process.exit(1)
  }
}

const start = async () => {
  // 0. Env validation — fail fast with a clear message
  try {
    validateEnv()
  } catch (err) {
    console.error('[ARIA] Environment validation failed:', (err as Error).message)
    process.exit(1)
  }

  // 1. Firebase — synchronous, non-fatal
  try {
    initFirebase()
    logger.info('Firebase Admin initialized')
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Firebase init failed — auth will retry on first request')
  }

  // 2. PostgreSQL — fatal
  try {
    await withTimeout(connectDB(), 5000, 'PostgreSQL')
    logger.info('PostgreSQL connected')
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, 'PostgreSQL connection failed — cannot start')
    process.exit(1)
  }

  // 3. Redis — fatal
  try {
    await withTimeout(connectRedis(), 5000, 'Redis')
    logger.info('Redis connected')
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, 'Redis connection failed — cannot start')
    process.exit(1)
  }

  // 4. Build Fastify app
  let app: FastifyInstance
  try {
    app = await buildApp()
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, 'Failed to build Fastify app')
    process.exit(1)
  }

  // 5. Health check is handled in app.ts

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
    process.once(signal, () => shutdown(app, signal))
  }

  await app.listen({ port: PORT, host: HOST })

  logger.info({ port: PORT, env: process.env.NODE_ENV, pid: process.pid }, 'ARIA Backend is live')
}

process.on('unhandledRejection', (reason: any) => {
  // Log it but do NOT exit — unhandled rejections in background tasks 
  // (fire-and-forget DB saves, background AI calls) should not kill the server.
  // Fatal infrastructure errors (DB down, Redis down) are handled in start().
  logger.error({ reason: reason?.message || reason }, 'Unhandled Rejection — continuing');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught Exception — continuing');
  // Only exit for truly fatal errors, not logic errors
  if (err.message?.includes('EADDRINUSE') || err.message?.includes('Cannot read')) {
    logger.fatal('Fatal error — exiting');
    process.exit(1);
  }
});

start()