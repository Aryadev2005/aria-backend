import { FastifyInstance, FastifyRequest } from 'fastify';
import {
  analyseVideo,
  getHistory,
  getCompetitorGap,
} from '../controllers/video_dna.controller';
import { authenticateFirebase } from '../middleware/auth.middleware';

export default async function videoDnaRoutes(app: FastifyInstance) {

  // ── POST /api/v1/video-dna/analyse ────────────────────────────────────────
  app.post('/analyse', {
    preHandler: [authenticateFirebase],
    config: {
      rateLimit: {
        max: 15,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => (req as any).user?.id ?? req.ip,
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
          videoId: {
            type: 'string',
            pattern: '^[a-zA-Z0-9_-]{11}$',
            description: '11-character YouTube video ID',
          },
        },
      },
    },
  }, analyseVideo as any);

  // ── GET /api/v1/video-dna/history ─────────────────────────────────────────
  app.get('/history', {
    preHandler: [authenticateFirebase],
  }, getHistory);

  // ── POST /api/v1/video-dna/competitor-gap ─────────────────────────────────
  app.post('/competitor-gap', {
    preHandler: [authenticateFirebase],
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 hour',
        keyGenerator: (req: FastifyRequest) => (req as any).user?.id ?? req.ip,
        errorResponseBuilder: () => ({
          success: false,
          error: 'RATE_LIMIT',
          message: 'Competitor gap analysis is limited to 5 per hour.',
        }),
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['niche'],
        properties: {
          niche: { type: 'string', minLength: 2, maxLength: 50 },
        },
      },
    },
  }, getCompetitorGap as any);
}
