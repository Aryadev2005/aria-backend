import Redis from 'ioredis'
import { LRUCache } from 'lru-cache'
import { pack, unpack } from 'msgpackr'
import { logger } from '../utils/logger'

let redisClient: Redis | null = null

const l1Cache = new LRUCache<string, Buffer>({
  max: 5000,
  maxSize: 32 * 1024 * 1024,
  sizeCalculation: (value) => Buffer.isBuffer(value) ? value.length : 256,
  ttl: 30 * 1000,
  allowStale: true,
  updateAgeOnGet: false,
})

export const connectRedis = async () => {
  try {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: null,            // MUST be null for BullMQ
      retryStrategy: (times) => {
        // Fail fast in development if Redis isn't available
        if (process.env.NODE_ENV !== 'production' && times > 2) {
          return -1; // Stop retrying after 2 attempts
        }
        return Math.min(times * 200, 1000)
      },
      connectTimeout: 2000,                 // Reduced timeout for faster failure in dev
      keepAlive: 30000,
      noDelay: true,
    })

    redisClient.on('error', (err) => logger.error({ err }, 'Redis error'))

    await redisClient.connect()
    await redisClient.ping()
    logger.info('Redis connected')
    return redisClient
  } catch (err: any) {
    // Non-fatal — app runs without Redis, L1 in-memory cache still works
    logger.warn({ err: err.message }, 'Redis unavailable — running with in-memory cache only')
    redisClient = null
  }
}

// BullMQ Workers removed — no separate worker client needed.
// Returns main client for any legacy callers.
export const getWorkerRedisClient = () => redisClient

export const getRedisClient = () => redisClient

export const cache = {
  async get(key: string) {
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

  async set(key: string, value: any, ttlSeconds = 300) {
    const packed = pack(value)
    l1Cache.set(key, packed, { ttl: Math.min(ttlSeconds * 1000, 30000) })
    if (redisClient) {
      redisClient.setex(key, ttlSeconds, packed).catch(() => { })
    }
  },

  async del(key: string) {
    l1Cache.delete(key)
    if (redisClient) await redisClient.del(key).catch(() => { })
  },

  async delPattern(pattern: string) {
    for (const key of l1Cache.keys()) {
      if (key.startsWith(pattern.replace('*', ''))) l1Cache.delete(key)
    }
    if (redisClient) {
      const keys = await redisClient.keys(pattern)
      if (keys.length > 0) await redisClient.del(...keys).catch(() => { })
    }
  },

  // deduplication map for concurrent requests
  _pending: new Map<string, Promise<any>>(),

  async getOrSet<T>(key: string, fetchFn: () => Promise<T>, ttlSeconds = 300): Promise<T | null> {
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

export const CacheKeys = {
  user:         (id: string) => `u:${id}`,
  userStats:    (id: string) => `u:${id}:stats`,
  trends:       (niche: string, platform: string) => `tr:${niche}:${platform}`,
  trendById:    (id: string) => `tr:id:${id}`,
  songs:        (niche: string) => `sg:${niche}`,
  songById:     (id: string) => `sg:id:${id}`,
  dashboard:    (userId: string) => `db:${userId}`,
  content:      (userId: string, page: string | number) => `ct:${userId}:${page}`,
  analytics:    (userId: string) => `an:${userId}`,
  spotifyToken: () => 'spotify:token',
}

export const TTL = {
  TREND:     parseInt(process.env.CACHE_TTL_TRENDS    || '300',  10),
  SONG:      parseInt(process.env.CACHE_TTL_SONGS     || '600',  10),
  USER:      parseInt(process.env.CACHE_TTL_USER      || '3600', 10),
  DASHBOARD: parseInt(process.env.CACHE_TTL_DASHBOARD || '60',   10),
  CONTENT:   1800,
  ANALYTICS: 300,
}