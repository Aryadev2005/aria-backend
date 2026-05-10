import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/launch.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { requireCredits } from "../middleware/credits.middleware";

export default async function launchRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // POST /api/v1/launch/package (AI-powered)
  app.post(
    "/package",
    {
      preHandler: [authenticateFirebase, requireCredits("posting_package")],
      schema: {
        body: {
          type: "object",
          properties: {
            idea: { type: "string", maxLength: 300 },
            script: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
    ctrl.getPostingPackage as any,
  );

  // GET /api/v1/launch/timing (AI-powered)
  app.get(
    "/timing",
    { preHandler: [authenticateFirebase, requireCredits("posting_package")] },
    ctrl.getTimingIntelligence,
  );

  // GET /api/v1/launch/brand-alert (AI-powered)
  app.get(
    "/brand-alert",
    { preHandler: [authenticateFirebase, requireCredits("brand_alert")] },
    ctrl.getBrandAlert,
  );
}
