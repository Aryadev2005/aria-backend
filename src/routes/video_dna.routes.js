'use strict'
// src/routes/video_dna.routes.js
// Register in src/app.js:
//   const videoDnaRoutes = require('./routes/video_dna.routes')
//   app.register(videoDnaRoutes, { prefix: `${API_PREFIX}/video-dna` })

const { analyseVideo, getHistory } = require('../controllers/video_dna.controller')
const { authenticateFirebase }     = require('../middleware/auth.middleware')
// Uncomment when ready to gate behind Pro:
// const { requirePro }            = require('../middleware/subscription.middleware')

module.exports = async (app) => {

  // POST /api/v1/video-dna/analyse
  app.post('/analyse', {
    preHandler: [
      authenticateFirebase,
      // requirePro,   // ← uncomment to gate behind Pro subscription
    ],
    config: {
      rateLimit: {
        max: 20,                 // 20 analyses per minute per user
        timeWindow: '1 minute',
        keyGenerator: (req) => req.user?.id || req.ip,
        errorResponseBuilder: () => ({
          success: false,
          error: 'RATE_LIMIT',
          message: 'Too many analyses. Please wait a moment.',
        }),
      },
    },
    schema: {
      body: {
        type: 'object',
        required: ['videoId'],
        properties: {
          url:     { type: 'string' },
          videoId: {
            type: 'string',
            pattern: '^[a-zA-Z0-9_-]{11}$',
            description: '11-character YouTube video ID',
          },
        },
      },
    },
  }, analyseVideo)

  // GET /api/v1/video-dna/history
  app.get('/history', {
    preHandler: [authenticateFirebase],
  }, getHistory)
}
