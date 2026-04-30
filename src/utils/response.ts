import { FastifyReply } from 'fastify'

export const success = (reply: FastifyReply, data: any, statusCode = 200, meta: any = {}) =>
  reply.code(statusCode).send({
    success: true,
    data,
    ...(Object.keys(meta).length > 0 && { meta }),
    timestamp: new Date().toISOString(),
  })

export const error = (reply: FastifyReply, message: string, statusCode = 400, code = 'ERROR') =>
  reply.code(statusCode).send({
    success: false,
    error: code,
    message,
    timestamp: new Date().toISOString(),
  })

export interface PaginationParams {
  page: number | string
  limit: number | string
  total: number
}

export const paginated = (reply: FastifyReply, data: any[], { page, limit, total }: PaginationParams) => {
  const p = typeof page === 'string' ? parseInt(page, 10) : page
  const l = typeof limit === 'string' ? parseInt(limit, 10) : limit
  
  return reply.code(200).send({
    success: true,
    data,
    meta: {
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l),
      hasNext: p * l < total,
      hasPrev: p > 1,
    },
    timestamp: new Date().toISOString(),
  })
}

export const created = (reply: FastifyReply, data: any) => success(reply, data, 201)
export const noContent = (reply: FastifyReply) => reply.code(204).send()

export const errors = {
  error,
  unauthorized: (reply: FastifyReply, msg = 'Unauthorized') =>
    error(reply, msg, 401, 'UNAUTHORIZED'),
  forbidden: (reply: FastifyReply, msg = 'Forbidden') =>
    error(reply, msg, 403, 'FORBIDDEN'),
  notFound: (reply: FastifyReply, resource = 'Resource') =>
    error(reply, `${resource} not found`, 404, 'NOT_FOUND'),
  conflict: (reply: FastifyReply, msg = 'Resource already exists') =>
    error(reply, msg, 409, 'CONFLICT'),
  internal: (reply: FastifyReply, msg = 'Internal server error') =>
    error(reply, msg, 500, 'INTERNAL_ERROR'),
  serviceDown: (reply: FastifyReply, service = 'Service') =>
    error(reply, `${service} is temporarily unavailable`, 503, 'SERVICE_UNAVAILABLE'),
  badRequest: (reply: FastifyReply, msg = 'Bad request') =>
    error(reply, msg, 400, 'BAD_REQUEST'),
  validation: (reply: FastifyReply, msg = 'Validation failed') =>
    error(reply, msg, 422, 'VALIDATION_ERROR'),
  tooMany: (reply: FastifyReply, msg = 'Too many requests') =>
    error(reply, msg, 429, 'RATE_LIMITED'),
}
