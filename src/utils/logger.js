'use strict'

const pino = require('pino')

const isDev = process.env.NODE_ENV !== 'production'

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDev ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
    },
  } : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'body.password',
      'body.token',
      '*.apiKey',
      '*.privateKey',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.ip }),
    res: (res) => ({ statusCode: res.statusCode }),
    err: pino.stdSerializers.err,
  },
})

module.exports = { logger }