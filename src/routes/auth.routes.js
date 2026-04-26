'use strict'

const authController = require('../controllers/auth.controller')
const { authenticateFirebase } = require('../middleware/auth.middleware')

module.exports = async (app) => {
  app.post('/firebase', {
    schema: {
      body: {
        type: 'object',
        required: ['idToken'],
        properties: {
          idToken:  { type: 'string', minLength: 100 },
          fcmToken: { type: 'string' },
          platform: { type: 'string', enum: ['android', 'ios'] },
        },
      },
    },
  }, authController.firebaseLogin)

  app.post('/logout', {
    preHandler: [authenticateFirebase],
  }, authController.logout)

  app.get('/me', {
    preHandler: [authenticateFirebase],
  }, authController.getMe)

  app.delete('/account', {
    preHandler: [authenticateFirebase],
  }, authController.deleteAccount)
}