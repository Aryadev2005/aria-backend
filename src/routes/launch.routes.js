// src/routes/launch.routes.js
'use strict';

const ctrl = require('../controllers/launch.controller');
const { authenticateFirebase } = require('../middleware/auth.middleware');

module.exports = async (app) => {
  const auth = { preHandler: [authenticateFirebase] };

  // POST /api/v1/launch/package
  // Body: { idea?: string, script?: string }
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
  }, ctrl.getPostingPackage);

  // GET /api/v1/launch/timing
  app.get('/timing', auth, ctrl.getTimingIntelligence);

  // GET /api/v1/launch/brand-alert
  app.get('/brand-alert', auth, ctrl.getBrandAlert);
};
