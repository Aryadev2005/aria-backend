// trendai-backend/src/routes/calendar.js

'use strict';
const calendarController = require('../controllers/calendarController');
const { authenticateFirebase } = require('../middleware/auth.middleware');

module.exports = async function calendarRoutes(fastify, opts) {
  // POST /api/v1/calendar/generate
  fastify.post('/generate', {
    schema: {
      body: {
        type: 'object',
        required: ['niche', 'platform', 'followerRange', 'month', 'year'],
        properties: {
          niche:         { type: 'string', maxLength: 100 },
          platform:      { type: 'string', enum: ['Instagram', 'YouTube', 'TikTok', 'Twitter/X'] },
          followerRange: { type: 'string' },
          month:         { type: 'string' },
          year:          { type: 'integer', minimum: 2024, maximum: 2030 },
        },
      },
    },
    preHandler: [authenticateFirebase],
  }, calendarController.generate);

  // GET /api/v1/calendar/saved — Get user's saved calendar from DB
  fastify.get('/saved', {
    preHandler: [authenticateFirebase],
  }, calendarController.getSaved);

  // POST /api/v1/calendar/save — Save generated calendar to DB
  fastify.post('/save', {
    schema: {
      body: {
        type: 'object',
        required: ['month', 'year', 'calendarData'],
        properties: {
          month:        { type: 'string' },
          year:         { type: 'integer' },
          calendarData: { type: 'object' },
        },
      },
    },
    preHandler: [authenticateFirebase],
  }, calendarController.save);
};
