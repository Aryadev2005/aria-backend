import { FastifyInstance } from "fastify";
import { authenticateFirebase } from "../middleware/auth.middleware";
import * as ctrl from "../controllers/integrations.controller";

export default async function integrationRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // POST /api/v1/integrations/instagram/connect-by-handle
  // New: user provides Instagram username → Apify scrapes → niche detection
  app.post("/instagram/connect-by-handle", auth, ctrl.connectInstagramByHandle);

  // GET /api/v1/integrations/youtube/auth-url
  // Returns the YouTube OAuth URL for the frontend to redirect to
  app.get("/youtube/auth-url", auth, ctrl.getYoutubeAuthUrl);

  // GET /api/v1/integrations/youtube/callback
  // YouTube OAuth redirect lands here — exchanges code for token
  app.get<{ Querystring: { code: string; state: string; error?: string } }>(
    "/youtube/callback",
    ctrl.youtubeCallback,
  );

  // POST /api/v1/integrations/youtube/fetch-analytics
  // On-demand: re-fetches YouTube analytics using stored OAuth token
  app.post("/youtube/fetch-analytics", auth, ctrl.fetchYouTubeAnalyticsHandler);

  // GET /api/v1/integrations/status
  // Returns which accounts are connected for the current user
  app.get("/status", auth, ctrl.getConnectionStatus);

  // DELETE /api/v1/integrations/:platform
  // Disconnect a platform
  app.delete<{ Params: { platform: string } }>(
    "/:platform",
    auth,
    ctrl.disconnectPlatform,
  );
}
