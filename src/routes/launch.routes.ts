import { FastifyInstance } from 'fastify'
import * as ctrl from '../controllers/launch.controller'
import { authenticateFirebase } from '../middleware/auth.middleware'

export default async function launchRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // POST /api/v1/launch/package
  app.post('/package', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        properties: {
          idea:   { type: 'string', maxLength: 300 },
          script: { type: 'string', maxLength: 2000 },
        },
      },
    },
  }, ctrl.getPostingPackage as any);

  // GET /api/v1/launch/timing
  app.get('/timing', auth, ctrl.getTimingIntelligence);

  // GET /api/v1/launch/brand-alert
  app.get('/brand-alert', auth, ctrl.getBrandAlert);
}
