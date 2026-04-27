'use strict'

const postgres = require('postgres')
const { logger } = require('../utils/logger')

let sql = null

const connectDB = async () => {
  try {
    sql = postgres(process.env.DATABASE_URL, {
      max: 20,
      idle_timeout: 30,
    })

    // Test connection
    await sql`SELECT 1`

    logger.info({ pool: 20 }, 'PostgreSQL connected')
    return sql
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
  if (!sql) throw new Error('Database not initialized')
  return sql
}

const disconnectDB = async () => {
  if (sql) {
    await sql.end()
    sql = null
  }
}

// Helper function for executing queries with parameters
// Usage: await query('SELECT * FROM users WHERE id = $1', [userId])
const query = (text, params) => {
  const s = getDB()
  return s.unsafe(text, params)
}

module.exports = { connectDB, getDB, disconnectDB, query, sql }