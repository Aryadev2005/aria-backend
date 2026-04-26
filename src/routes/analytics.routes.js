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
}