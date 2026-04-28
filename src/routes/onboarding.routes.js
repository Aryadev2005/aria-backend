// src/routes/onboarding.routes.js
'use strict';

const ctrl = require('../controllers/onboarding.controller');
const { authenticateFirebase } = require('../middleware/auth.middleware');

module.exports = async (app) => {
  // POST /api/v1/onboarding/connect
  // Body: { handle: string, platform: 'instagram'|'youtube' }
  app.post('/connect', {
    preHandler: [authenticateFirebase],
    schema: {
      body: {
        type: 'object',
        required: ['handle', 'platform'],
        properties: {
          handle:   { type: 'string', minLength: 1, maxLength: 60 },
          platform: { type: 'string', enum: ['instagram', 'youtube'] },
        },
      },
    },
  }, ctrl.connectHandle);

  // POST /api/v1/onboarding/finalise
  // Body: { confirmedNiches, confirmedArchetype, platform, followerRange }
  app.post('/finalise', {
    preHandler: [authenticateFirebase],
    schema: {
      body: {
        type: 'object',
        required: ['confirmedNiches', 'confirmedArchetype'],
        properties: {
          confirmedNiches:    { type: 'array', items: { type: 'string' } },
          confirmedArchetype: { type: 'string' },
          platform:           { type: 'string' },
          followerRange:      { type: 'string' },
        },
      },
    },
  }, ctrl.finaliseNiche);

  // GET /api/v1/onboarding/status
  app.get('/status', {
    preHandler: [authenticateFirebase],
  }, ctrl.getStatus);
};
