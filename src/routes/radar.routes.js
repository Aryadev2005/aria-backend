// src/routes/radar.routes.js
'use strict';

const radarController = require('../controllers/radar.controller');
const { authenticateFirebase } = require('../middleware/auth.middleware');

module.exports = async (app) => {
  // GET /api/v1/discover/intelligence
  app.get('/intelligence', {
    preHandler: [authenticateFirebase],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          niche:    { type: 'string' },
          platform: { type: 'string', enum: ['instagram', 'youtube'] },
        },
      },
    },
  }, radarController.getIntelligence);

  // GET /api/v1/discover/competitors
  app.get('/competitors', {
    preHandler: [authenticateFirebase],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          niche:    { type: 'string' },
          platform: { type: 'string' },
        },
      },
    },
  }, radarController.getCompetitors);

  // GET /api/v1/discover/inspiration
  app.get('/inspiration', {
    preHandler: [authenticateFirebase],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          niche:    { type: 'string' },
          platform: { type: 'string' },
        },
      },
    },
  }, radarController.getInspiration);
};