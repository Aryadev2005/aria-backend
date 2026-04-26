'use strict'

const Fastify = require('fastify')
const cors = require('@fastify/cors')
const helmet = require('@fastify/helmet')
const jwt = require('@fastify/jwt')
const rateLimit = require('@fastify/rate-limit')
const compress = require('@fastify/compress')
const sensible = require('@fastify/sensible')
const { logger } = require('./utils/logger')

const authRoutes      = require('./routes/auth.routes')
const userRoutes      = require('./routes/user.routes')
const trendRoutes     = require('./routes/trend.routes')
const songRoutes      = require('./routes/song.routes')
const contentRoutes   = require('./routes/content.routes')
const analyticsRoutes = require('./routes/analytics.routes')

const buildApp = async () => {
  const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production' ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
    } : undefined,
  },
  genReqId: (req) => {
    return req.headers['x-request-id'] ||
      `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  },
  trustProxy: true,
  ajv: {
    customOptions: {
      removeAdditional: true,
      useDefaults: true,
      coerceTypes: true,
      allErrors: false,
    },
  },
})

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })

  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    credentials: true,
    maxAge: 86400,
  })

  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip', 'deflate'],
  })

  await app.register(rateLimit, {
    global: true,
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000', 10),
    redis: require('./config/redis').getRedisClient(),
    keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
    errorResponseBuilder: (req, context) => ({
      success: false,
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  })

  await app.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN || '7d', algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  })

  await app.register(sensible)

  app.get('/health', async (req, reply) => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
    }
  })

  const API_PREFIX = `/api/${process.env.API_VERSION || 'v1'}`
  app.register(authRoutes,      { prefix: `${API_PREFIX}/auth` })
  app.register(userRoutes,      { prefix: `${API_PREFIX}/users` })
  app.register(trendRoutes,     { prefix: `${API_PREFIX}/trends` })
  app.register(songRoutes,      { prefix: `${API_PREFIX}/songs` })
  app.register(contentRoutes,   { prefix: `${API_PREFIX}/content` })
  app.register(analyticsRoutes, { prefix: `${API_PREFIX}/analytics` })

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      success: false,
      error: 'NOT_FOUND',
      message: `Route ${req.method} ${req.url} not found`,
    })
  })

  app.setErrorHandler((err, req, reply) => {
    const statusCode = err.statusCode || 500
    if (statusCode >= 500) {
      req.log.error({ err, req: { url: req.url, method: req.method } })
    }
    if (err.code === 'FST_ERR_VALIDATION') {
      return reply.code(400).send({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: err.validation,
      })
    }
    reply.code(statusCode).send({
      success: false,
      error: err.code || 'INTERNAL_ERROR',
      message: statusCode >= 500 ? 'Internal server error' : err.message,
    })
  })

  return app
}

module.exports = { buildApp }