import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'

export const logger = pino({
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
    req: (req: any) => ({ id: req.id, method: req.method, url: req.url, ip: req.ip }),
    res: (res: any) => ({ statusCode: res.statusCode }),
    err: pino.stdSerializers.err,
  },
})
