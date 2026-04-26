'use strict'

const userController = require('../controllers/user.controller')
const { authenticateFirebase } = require('../middleware/auth.middleware')

module.exports = async (app) => {
  app.get('/profile', {
    preHandler: [authenticateFirebase],
  }, userController.getProfile)

  app.put('/profile', {
    preHandler: [authenticateFirebase],
    schema: {
      body: {
        type: 'object',
        properties: {
          name:            { type: 'string', minLength: 2, maxLength: 100 },
          instagramHandle: { type: 'string' },
          youtubeHandle:   { type: 'string' },
          bio:             { type: 'string', maxLength: 500 },
          fcmToken:        { type: 'string' },
        },
      },
    },
  }, userController.updateProfile)

  app.put('/onboarding', {
    preHandler: [authenticateFirebase],
    schema: {
      body: {
        type: 'object',
        required: ['followerRange', 'primaryPlatform', 'niches'],
        properties: {
          followerRange:   { type: 'string' },
          primaryPlatform: { type: 'string' },
          niches: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 5,
          },
        },
      },
    },
  }, userController.completeOnboarding)

  app.get('/stats', {
    preHandler: [authenticateFirebase],
  }, userController.getStats)

  app.put('/subscription', {
    preHandler: [authenticateFirebase],
    schema: {
      body: {
        type: 'object',
        required: ['tier'],
        properties: {
          tier:        { type: 'string', enum: ['free', 'pro', 'brand', 'agency'] },
          receiptData: { type: 'string' },
          platform:    { type: 'string', enum: ['ios', 'android'] },
        },
      },
    },
  }, userController.updateSubscription)
}