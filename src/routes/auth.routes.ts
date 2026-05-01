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
          name: { type: 'string' },
          phone: { type: 'string' }
        },
      },
    },
  }, authController.firebaseLogin);

  app.get('/check-email', authController.checkEmail);

  app.post<{ Body: { name: string; phone: string } }>('/update-profile', {
    preHandler: [authenticateFirebase],
  }, authController.updateRegistrationProfile);

  app.post('/logout', {
    preHandler: [authenticateFirebase],
  }, authController.logout);
}
