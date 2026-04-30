import { FastifyInstance, FastifyRequest } from 'fastify'
import { analyseVideo, getHistory } from '../controllers/video_dna.controller'
import { authenticateFirebase } from '../middleware/auth.middleware'

export default async function videoDnaRoutes(app: FastifyInstance) {
  // POST /api/v1/video-dna/analyse
  app.post('/analyse', {
    preHandler: [
      authenticateFirebase,
    ],
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => req.user?.id || req.ip,
        errorResponseBuilder: () => ({
          success: false,
          error: 'RATE_LIMIT',
          message: 'Too many analyses. Please wait a moment.',
        }),
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['videoId'],
        properties: {
          url:     { type: 'string' },
          videoId: {
            type: 'string',
            pattern: '^[a-zA-Z0-9_-]{11}$',
            description: '11-character YouTube video ID',
          },
        },
      },
    },
  }, analyseVideo as any);

  // GET /api/v1/video-dna/history
  app.get('/history', {
    preHandler: [authenticateFirebase],
  }, getHistory);
}
