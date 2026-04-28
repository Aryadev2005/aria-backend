// src/routes/agent.routes.js
'use strict';

const ctrl = require('../controllers/agent.controller');
const { authenticateFirebase } = require('../middleware/auth.middleware');

module.exports = async (app) => {
  app.post('/message', {
    preHandler: [authenticateFirebase],
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message:   { type: 'string', minLength: 1, maxLength: 2000 },
          sessionId: { type: 'string' },
          history: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role:      { type: 'string' },
                content:   { type: 'string' },
                timestamp: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, ctrl.sendMessage);

  app.get('/memory',            { preHandler: [authenticateFirebase] }, ctrl.getMemory);
  app.delete('/memory/:key',    { preHandler: [authenticateFirebase] }, ctrl.deleteMemory);
};
