// src/routes/profile.routes.js
'use strict';

const ctrl = require('../controllers/profile.controller');
const { authenticateFirebase } = require('../middleware/auth.middleware');

module.exports = async (app) => {
  const auth = { preHandler: [authenticateFirebase] };

  // GET /api/v1/profile/me
  app.get('/me', auth, ctrl.getProfile);

  // GET /api/v1/profile/analytics
  // Platform-aware — routes to YouTube or Instagram handler automatically
  app.get('/analytics', auth, ctrl.getAnalytics);

  // POST /api/v1/profile/refresh
  // Force re-scrape + clear cache
  app.post('/refresh', auth, ctrl.refreshAnalytics);

  // PATCH /api/v1/profile/platform
  // Update which platform this creator is on
  app.patch('/platform', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        required: ['platform', 'handle'],
        properties: {
          platform: { type: 'string', enum: ['instagram', 'youtube'] },
          handle:   { type: 'string', minLength: 1, maxLength: 60 },
        },
      },
    },
  }, ctrl.updatePlatform);
};
