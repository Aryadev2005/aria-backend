'use strict'

const success = (reply, data, statusCode = 200, meta = {}) =>
  reply.code(statusCode).send({
    success: true,
    data,
    ...(Object.keys(meta).length > 0 && { meta }),
    timestamp: new Date().toISOString(),
  })

const error = (reply, message, statusCode = 400, code = 'ERROR') =>
  reply.code(statusCode).send({
    success: false,
    error: code,
    message,
    timestamp: new Date().toISOString(),
  })

const paginated = (reply, data, { page, limit, total }) =>
  reply.code(200).send({
    success: true,
    data,
    meta: {
      page:       parseInt(page, 10),
      limit:      parseInt(limit, 10),
      total,
      totalPages: Math.ceil(total / limit),
      hasNext:    page * limit < total,
      hasPrev:    page > 1,
    },
    timestamp: new Date().toISOString(),
  })

const created   = (reply, data) => success(reply, data, 201)
const noContent = (reply) => reply.code(204).send()

const errors = {
  unauthorized: (reply, msg = 'Unauthorized') =>
    error(reply, msg, 401, 'UNAUTHORIZED'),
  forbidden:    (reply, msg = 'Forbidden') =>
    error(reply, msg, 403, 'FORBIDDEN'),
  notFound:     (reply, resource = 'Resource') =>
    error(reply, `${resource} not found`, 404, 'NOT_FOUND'),
  conflict:     (reply, msg = 'Resource already exists') =>
    error(reply, msg, 409, 'CONFLICT'),
  internal:     (reply, msg = 'Internal server error') =>
    error(reply, msg, 500, 'INTERNAL_ERROR'),
  serviceDown:  (reply, service = 'Service') =>
    error(reply, `${service} is temporarily unavailable`, 503, 'SERVICE_UNAVAILABLE'),
  tooMany:      (reply, msg = 'Too many requests') =>
    error(reply, msg, 429, 'RATE_LIMITED'),
}

module.exports = { success, error, paginated, created, noContent, errors }