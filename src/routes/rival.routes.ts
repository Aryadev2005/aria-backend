// src/routes/rival.routes.ts

import { FastifyInstance } from 'fastify';
import { streamRivalSpy, streamRivalScript, getRecentSessions } from '../controllers/rival.controller';
import { authenticateFirebase } from '../middleware/auth.middleware';
import { requireCredits } from '../middleware/credits.middleware';

export default async function rivalRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // POST /api/v1/rival/spy/stream — SSE stream
  app.post(
    '/spy/stream',
    {
      preHandler: [authenticateFirebase, requireCredits('rival_spy')],
      schema: {
        body: {
          type: 'object',
          required: ['handles'],
          properties: {
            handles: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
            platform: { type: 'string', enum: ['instagram', 'youtube', 'auto'] },
          },
        },
      },
    },
    streamRivalSpy as any,
  );

  // POST /api/v1/rival/generate-script/stream — per-card script + shoot plan
  app.post(
    '/generate-script/stream',
    {
      preHandler: [authenticateFirebase, requireCredits('rival_script')],
      schema: {
        body: {
          type: 'object',
          required: ['stealCard', 'cardIndex'],
          properties: {
            stealCard: { type: 'object' },
            cardIndex: { type: 'number' },
            niche: { type: 'string' },
          },
        },
      },
    },
    streamRivalScript as any,
  );

  // GET /api/v1/rival/sessions — recent spy sessions
  app.get('/sessions', auth, getRecentSessions);
}
