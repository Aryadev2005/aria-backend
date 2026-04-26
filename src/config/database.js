'use strict'

const { Pool } = require('pg')
const { logger } = require('../utils/logger')

let pool = null

const connectDB = async () => {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max:              parseInt(process.env.DB_POOL_MAX || '20', 10),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || '10000', 10),
    })

    // Test connection
    const client = await pool.connect()
    await client.query('SELECT 1')
    client.release()

    logger.info({ pool: 20 }, 'PostgreSQL connected')
    return pool
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      logger.warn({ err }, 'PostgreSQL connection failed - running in mock mode')
      return null
    }
    logger.error({ err }, 'PostgreSQL connection failed')
    throw err
  }
}

const getDB = () => {
  if (!pool) throw new Error('Database not initialized')
  return pool
}

const disconnectDB = async () => {
  if (pool) {
    await pool.end()
    pool = null
  }
}

// Helper to run queries — mimics postgres.js tagged template syntax
// Usage: await query('SELECT * FROM users WHERE id = $1', [userId])
const query = async (text, params) => {
  const client = await pool.connect()
  try {
    const result = await client.query(text, params)
    return result.rows
  } finally {
    client.release()
  }
}

module.exports = { connectDB, getDB, disconnectDB, query }