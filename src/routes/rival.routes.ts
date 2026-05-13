// src/routes/rival.routes.ts

import { FastifyInstance } from 'fastify';
import { streamRivalSpy, getRecentSessions } from '../controllers/rival.controller';
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

  // GET /api/v1/rival/sessions — recent spy sessions
  app.get('/sessions', auth, getRecentSessions);
}
