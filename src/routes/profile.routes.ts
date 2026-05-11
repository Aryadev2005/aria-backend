import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/profile.controller";
import * as identityCtrl from "../controllers/aria_identity.controller";
import type {
  UpdatePlatformBody,
  SwitchPlatformBody,
} from "../controllers/profile.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { requireCredits } from "../middleware/credits.middleware";

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

  // ── NEW: PATCH /api/v1/profile/switch-platform ────────────────────────────
  // User-facing primary platform switch. Both accounts must be connected.
  // YouTube requires analytics to be fetched first.
  app.patch<{ Body: SwitchPlatformBody }>(
    "/switch-platform",
    {
      ...auth,
      schema: {
        body: {
          type: "object",
          required: ["platform"],
          properties: {
            platform: { type: "string", enum: ["instagram", "youtube"] },
          },
        },
      },
    },
    ctrl.switchPrimary,
  );

  // GET /api/v1/profile/aria-identity
  app.get("/aria-identity", auth, identityCtrl.getIdentity);

  // PUT /api/v1/profile/aria-identity/memory
  app.put(
    "/aria-identity/memory",
    {
      ...auth,
      schema: {
        body: {
          type: "object",
          required: ["category", "key", "value"],
          properties: {
            category: { type: "string", minLength: 1 },
            key: { type: "string", minLength: 1 },
            value: { type: "string", minLength: 1 },
          },
        },
      },
    },
    identityCtrl.updateMemory,
  );

  // DELETE /api/v1/profile/aria-identity/memory
  app.delete(
    "/aria-identity/memory",
    {
      ...auth,
      schema: {
        body: {
          type: "object",
          required: ["category", "key"],
          properties: {
            category: { type: "string", minLength: 1 },
            key: { type: "string", minLength: 1 },
          },
        },
      },
    },
    identityCtrl.deleteMemory,
  );

  // GET /api/v1/profile/creator-analytics
  app.get("/creator-analytics", auth, ctrl.getCreatorAnalytics);

  // POST /api/v1/profile/creator-analytics/refresh
  app.post("/creator-analytics/refresh", auth, ctrl.refreshCreatorAnalytics);

  // POST /api/v1/profile/voice-portrait/rebuild (AI-powered)
  app.post(
    "/voice-portrait/rebuild",
    { preHandler: [authenticateFirebase, requireCredits("voice_portrait")] },
    ctrl.rebuildVoicePortrait,
  );
}
