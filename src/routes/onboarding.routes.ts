import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/onboarding.controller";
import type {
  ConnectHandleBody,
  FinaliseNicheBody,
} from "../controllers/onboarding.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

export default async function onboardingRoutes(app: FastifyInstance) {
  // POST /api/v1/onboarding/connect
  app.post<{ Body: ConnectHandleBody }>(
    "/connect",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["handle", "platform"],
          properties: {
            handle: { type: "string", minLength: 1, maxLength: 60 },
            platform: { type: "string", enum: ["instagram", "youtube"] },
          },
        },
      },
    },
    ctrl.connectHandle,
  );

  // POST /api/v1/onboarding/finalise
  app.post<{ Body: FinaliseNicheBody }>(
    "/finalise",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["confirmedNiches", "confirmedArchetype"],
          properties: {
            confirmedNiches: { type: "array", items: { type: "string" } },
            confirmedArchetype: { type: "string" },
            platform: { type: "string" },
            followerRange: { type: "string" },
          },
        },
      },
    },
    ctrl.finaliseNiche,
  );

  // GET /api/v1/onboarding/status
  app.get(
    "/status",
    {
      preHandler: [authenticateFirebase],
    },
    ctrl.getStatus,
  );
}
