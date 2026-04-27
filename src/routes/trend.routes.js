'use strict'

const trendController = require('../controllers/trend.controller')
const { authenticateFirebase } = require('../middleware/auth.middleware')

module.exports = async (app) => {
  app.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          niche: { type: 'string', default: 'fashion' },
          platform: { type: 'string', default: 'instagram' },
          badge: { type: 'string', default: 'ALL' },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 10 },
        },
      },
    },
  }, trendController.getTrends)

  app.get('/personalized', {
    preHandler: [authenticateFirebase],
  }, trendController.getPersonalizedTrends)

  app.get('/opportunity-windows', {
    preHandler: [authenticateFirebase],
  }, trendController.getOpportunityWindows)

  app.get('/viral-radar', {
    preHandler: [authenticateFirebase],
  }, trendController.getViralRadar)

  app.get('/saved', {
    preHandler: [authenticateFirebase],
  }, trendController.getSavedTrends)

  app.get('/:id', {}, trendController.getTrendById)

  app.post('/:id/save', {
    preHandler: [authenticateFirebase],
  }, trendController.saveTrend)

  app.delete('/:id/save', {
    preHandler: [authenticateFirebase],
  }, trendController.unsaveTrend)

  app.post('/feedback', {
    preHandler: [authenticateFirebase],
    schema: {
      body: {
        type: 'object',
        required: ['recommendationType', 'recommendationData', 'wasHelpful'],
        properties: {
          recommendationType: { type: 'string' },
          recommendationData: { type: 'object' },
          wasHelpful: { type: 'boolean' },
          resultNotes: { type: 'string' },
        },
      },
    },
  }, trendController.submitFeedback)
}