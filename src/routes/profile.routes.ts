import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/profile.controller";
import type { UpdatePlatformBody } from "../controllers/profile.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

export default async function profileRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // GET /api/v1/profile/me
  app.get("/me", auth, ctrl.getProfile);

  // GET /api/v1/profile/analytics
  app.get("/analytics", auth, ctrl.getAnalytics);

  // POST /api/v1/profile/refresh
  app.post("/refresh", auth, ctrl.refreshAnalytics);

  // PATCH /api/v1/profile/platform
  app.patch<{ Body: UpdatePlatformBody }>(
    "/platform",
    {
      ...auth,
      schema: {
        body: {
          type: "object",
          required: ["platform", "handle"],
          properties: {
            platform: { type: "string", enum: ["instagram", "youtube"] },
            handle: { type: "string", minLength: 1, maxLength: 60 },
          },
        },
      },
    },
    ctrl.updatePlatform,
  );
}
