import { FastifyInstance } from 'fastify'
import * as songController from '../controllers/song.controller'
import { authenticateFirebase, requirePro } from '../middleware/auth.middleware'

export default async function songRoutes(app: FastifyInstance) {
  app.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          niche:     { type: 'string', default: 'fashion' },
          lifecycle: { type: 'string', enum: ['early', 'peak', 'dying', 'all'], default: 'all' },
          signal:    { type: 'string', enum: ['postNow', 'wait', 'tooLate', 'all'], default: 'all' },
          limit:     { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        },
      },
    },
  }, songController.getSongs);

  app.get('/top10', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          niche: { type: 'string', default: 'fashion' },
        },
      },
    },
  }, songController.getTop10);

  app.get('/predict', {
    preHandler: [authenticateFirebase, requirePro],
  }, songController.predictTrendingSongs);

  app.get('/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, songController.getSongById);
}
