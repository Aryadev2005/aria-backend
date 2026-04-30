import { FastifyInstance } from 'fastify'
import * as authController from '../controllers/auth.controller'
import { authenticateFirebase } from '../middleware/auth.middleware'

export default async function authRoutes(app: FastifyInstance) {
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
  }, authController.firebaseLogin);

  app.post('/logout', {
    preHandler: [authenticateFirebase],
  }, authController.logout);

  app.get('/me', {
    preHandler: [authenticateFirebase],
  }, authController.getMe);

  app.delete('/account', {
    preHandler: [authenticateFirebase],
  }, authController.deleteAccount);
}
