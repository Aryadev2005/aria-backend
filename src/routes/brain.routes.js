'use strict'
// brain.routes.js
// Register in src/app.js:
//   const brainRoutes = require('./routes/brain.routes')
//   app.register(brainRoutes, { prefix: `${API_PREFIX}/brain` })

const { chat, greet } = require('../controllers/aria_chat.controller')
const { authenticateFirebase } = require('../middleware/auth.middleware')

const aiRateLimit = {
  max: 60,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({
    success: false,
    error: 'RATE_LIMIT',
    message: 'Too many messages. Please slow down a little.',
  }),
}

module.exports = async (app) => {

  // POST /api/v1/brain/chat
  // Main chat endpoint — handles context, tools, memory, archetype
  app.post('/chat', {
    preHandler: [authenticateFirebase],
    config: { rateLimit: aiRateLimit },
    schema: {
      body: {
        type: 'object',
        required: ['message', 'sessionId'],
        properties: {
          message:   { type: 'string', minLength: 1, maxLength: 4000 },
          sessionId: { type: 'string', minLength: 1 },
          entryScreen: {
            type: 'string',
            enum: ['discover', 'studio', 'launch', 'profile', 'direct'],
            default: 'direct',
          },
          context: {
            type: 'object',
            properties: {
              idea:        { type: 'string' },
              script:      { type: 'string' },
              platform:    { type: 'string' },
              format:      { type: 'string' },
              trendTitle:  { type: 'string' },
            },
          },
          conversationHistory: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role:    { type: 'string', enum: ['user', 'assistant'] },
                content: { type: 'string' },
              },
            },
            maxItems: 20,
          },
        },
      },
    },
  }, chat)

  // GET /api/v1/brain/greet
  // Called when user opens Brain — returns proactive opening message
  app.get('/greet', {
    preHandler: [authenticateFirebase],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          entryScreen: { type: 'string', default: 'direct' },
          sessionId:   { type: 'string' },
          context:     { type: 'string' }, // JSON string
        },
      },
    },
  }, greet)

}
