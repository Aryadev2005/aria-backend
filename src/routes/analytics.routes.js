'use strict'

const analyticsController = require('../controllers/analytics.controller')
const { authenticateFirebase, requirePro } = require('../middleware/auth.middleware')

module.exports = async (app) => {
  app.get('/dashboard', {
    preHandler: [authenticateFirebase],
  }, analyticsController.getDashboard)

  app.get('/growth', {
    preHandler: [authenticateFirebase, requirePro],
  }, analyticsController.getGrowthPrediction)

  app.get('/best-times', {
    preHandler: [authenticateFirebase],
  }, analyticsController.getBestPostingTimes)

  app.get('/competitors', {
    preHandler: [authenticateFirebase, requirePro],
  }, analyticsController.getCompetitorInsights)

  app.get('/weekly-report', {
    preHandler: [authenticateFirebase, requirePro],
  }, analyticsController.getWeeklyReport)

  app.get('/archetype', {
    preHandler: [authenticateFirebase],
  }, analyticsController.getArchetype)

  app.post('/scrape', {
    preHandler: [authenticateFirebase],
    schema: {
      body: {
        type: 'object',
        required: ['handle', 'platform'],
        properties: {
          handle: { type: 'string', minLength: 1 },
          platform: { type: 'string', enum: ['instagram', 'youtube'] },
        },
      },
    },
  }, analyticsController.triggerScrape)
}