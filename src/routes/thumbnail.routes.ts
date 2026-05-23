// src/routes/thumbnail.routes.ts
// ══════════════════════════════════════════════════════════════════════════════
// Thumbnail Variants API Routes
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/thumbnail.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { requireCredits } from "../middleware/credits.middleware";

export default async function thumbnailRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // ── POST /api/v1/thumbnail/variants/generate ────────────────────────────────
  // Generate A/B/C thumbnail concepts after studio script generation
  // Auth: requireCredits('thumbnail_variants') enforces feature + credit check
  app.post(
    "/variants/generate",
    {
      preHandler: [authenticateFirebase, requireCredits("thumbnail_variants")],
      schema: {
        body: {
          type: "object",
          required: ["studioSessionId", "hookLine", "idea"],
          properties: {
            studioSessionId: { type: "string", minLength: 1 },
            hookLine: { type: "string", minLength: 5, maxLength: 200 },
            idea: { type: "string", minLength: 10, maxLength: 1000 },
            niche: { type: "string", maxLength: 50 },
            platform: { type: "string", enum: ["youtube", "instagram"] },
          },
        },
      },
    },
    ctrl.generateVariants as any,
  );

  // ── GET /api/v1/thumbnail/variants/:studioSessionId ────────────────────────
  // Fetch most recent non-expired draft for a studio session
  // Auth: authenticateFirebase only (no credit check needed)
  app.get(
    "/variants/:studioSessionId",
    {
      preHandler: [authenticateFirebase],
      schema: {
        params: {
          type: "object",
          required: ["studioSessionId"],
          properties: {
            studioSessionId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    ctrl.getVariants as any,
  );

  // ── PATCH /api/v1/thumbnail/variants/:id/status ────────────────────────────
  // Update variant status: draft → rotating → decided
  // Auth: authenticateFirebase only (no credit check needed)
  app.patch(
    "/variants/:id/status",
    {
      preHandler: [authenticateFirebase],
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1 },
          },
        },
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["rotating", "decided"] },
            winner: { type: "string", enum: ["a", "b", "c"] },
            videoId: { type: "string" },
          },
        },
      },
    },
    ctrl.updateVariantStatus as any,
  );
}
