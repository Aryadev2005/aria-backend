// src/routes/webhook.routes.js
// ARIA Backend — Webhook routes (RevenueCat)
// Register in src/server.js as: app.register(webhookRoutes, { prefix: '/api/v1/webhooks' })

'use strict'

const { handleWebhook } = require('../controllers/revenuecat.controller')

module.exports = async (app) => {
  // POST /api/v1/webhooks/revenuecat
  // No auth middleware — RevenueCat uses its own Authorization header secret
  app.post('/revenuecat', {
    config: {
      // Skip Firebase auth for this route
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
  }, handleWebhook)
}
