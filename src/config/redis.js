'use strict'

const Redis = require('ioredis')
const { LRUCache } = require('lru-cache')
const { pack, unpack } = require('msgpackr')
const { logger } = require('../utils/logger')

let redisClient = null

const l1Cache = new LRUCache({
  max: 5000,
  maxSize: 32 * 1024 * 1024,
  sizeCalculation: (value) => Buffer.isBuffer(value) ? value.length : 256,
  ttl: 30 * 1000,
  allowStale: true,
  updateAgeOnGet: false,
})

const connectRedis = async () => {
  try {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => times > 5 ? null : Math.min(times * 100, 2000),
      socket: { noDelay: true, keepAlive: 30000 },
    })
    redisClient.on('error', (err) => logger.error({ err }, 'Redis error'))
    await redisClient.connect()
    await redisClient.ping()
    logger.info('Redis connected')
    return redisClient
  } catch (err) {
    logger.warn('Running without Redis cache')
  }
}

// BullMQ Workers removed — no separate worker client needed.
// Returns main client for any legacy callers.
const getWorkerRedisClient = () => redisClient

const getRedisClient = () => redisClient

const cache = {
  async get(key) {
    const l1Hit = l1Cache.get(key)
    if (l1Hit !== undefined) return unpack(l1Hit)
    if (!redisClient) return null
    try {
      const raw = await redisClient.getBuffer(key)
      if (!raw) return null
      l1Cache.set(key, raw)
      return unpack(raw)
    } catch { return null }
  },

  async set(key, value, ttlSeconds = 300) {
    const packed = pack(value)
    l1Cache.set(key, packed, { ttl: Math.min(ttlSeconds * 1000, 30000) })
    if (redisClient) {
      redisClient.setex(key, ttlSeconds, packed).catch(() => {})
    }
  },

  async del(key) {
    l1Cache.delete(key)
    if (redisClient) await redisClient.del(key).catch(() => {})
  },

  async delPattern(pattern) {
    for (const key of l1Cache.keys()) {
      if (key.startsWith(pattern.replace('*', ''))) l1Cache.delete(key)
    }
    if (redisClient) {
      const keys = await redisClient.keys(pattern)
      if (keys.length > 0) await redisClient.del(...keys).catch(() => {})
    }
  },

  // deduplication map for concurrent requests
  _pending: new Map(),

  async getOrSet(key, fetchFn, ttlSeconds = 300) {
    const cached = await cache.get(key)
    if (cached !== null) return cached

    // If a request for this key is already in progress, wait for it
    if (cache._pending.has(key)) {
      logger.info({ key }, 'Cache: deduplicating concurrent request')
      return cache._pending.get(key)
    }

    // Execute fetch and store the promise for others to wait on
    const fetchPromise = fetchFn()
      .then(async (fresh) => {
        if (fresh !== null && fresh !== undefined) {
          await cache.set(key, fresh, ttlSeconds)
        }
        return fresh
      })
      .finally(() => {
        cache._pending.delete(key)
      })

    cache._pending.set(key, fetchPromise)
    return fetchPromise
  },
}

const CacheKeys = {
  user:         (id) => `u:${id}`,
  userStats:    (id) => `u:${id}:stats`,
  trends:       (niche, platform) => `tr:${niche}:${platform}`,
  trendById:    (id) => `tr:id:${id}`,
  songs:        (niche) => `sg:${niche}`,
  songById:     (id) => `sg:id:${id}`,
  dashboard:    (userId) => `db:${userId}`,
  content:      (userId, page) => `ct:${userId}:${page}`,
  analytics:    (userId) => `an:${userId}`,
  spotifyToken: () => 'spotify:token',
}

const TTL = {
  TREND:     parseInt(process.env.CACHE_TTL_TRENDS   || '300',  10),
  SONG:      parseInt(process.env.CACHE_TTL_SONGS    || '600',  10),
  USER:      parseInt(process.env.CACHE_TTL_USER     || '3600', 10),
  DASHBOARD: parseInt(process.env.CACHE_TTL_DASHBOARD|| '60',  10),
  CONTENT:   1800,
  ANALYTICS: 300,
}

module.exports = { connectRedis, getRedisClient, getWorkerRedisClient, cache, CacheKeys, TTL }