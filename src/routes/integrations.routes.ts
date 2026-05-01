import { FastifyInstance } from 'fastify';
import { authenticateFirebase } from '../middleware/auth.middleware';
import * as ctrl from '../controllers/integrations.controller';

export default async function integrationRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // GET /api/v1/integrations/instagram/auth-url
  // Returns the Instagram OAuth URL for the frontend to redirect to
  app.get('/instagram/auth-url', auth, ctrl.getInstagramAuthUrl);

  // GET /api/v1/integrations/youtube/auth-url  
  // Returns the YouTube OAuth URL for the frontend to redirect to
  app.get('/youtube/auth-url', auth, ctrl.getYoutubeAuthUrl);

  // GET /api/v1/integrations/instagram/callback
  // Google/Meta redirect lands here — exchanges code for token
  app.get<{ Querystring: { code: string; state: string; error?: string } }>('/instagram/callback', ctrl.instagramCallback);

  // GET /api/v1/integrations/youtube/callback
  app.get<{ Querystring: { code: string; state: string; error?: string } }>('/youtube/callback', ctrl.youtubeCallback);

  // GET /api/v1/integrations/status
  // Returns which accounts are connected for the current user
  app.get('/status', auth, ctrl.getConnectionStatus);

  // DELETE /api/v1/integrations/:platform
  // Disconnect a platform
  app.delete<{ Params: { platform: string } }>('/:platform', auth, ctrl.disconnectPlatform);
}
