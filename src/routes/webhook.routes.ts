import { FastifyInstance } from 'fastify'
import { handleWebhook } from '../controllers/revenuecat.controller'

export default async function webhookRoutes(app: FastifyInstance) {
  // POST /api/v1/webhooks/revenuecat
  app.post('/revenuecat', {
    config: {
      skipAuth: true,
    },
    schema: {
      body: {
        type: 'object',
        properties: {
          event: { type: 'object' },
        },
      },
    },
  }, handleWebhook);
}
