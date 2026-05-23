// src/routes/trials.routes.ts
// ══════════════════════════════════════════════════════════════════════════════
// First Experience Trials Routes
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/trials.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

export default async function trialRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticateFirebase] };

  // ── GET /api/v1/trials/status ─────────────────────────────────────────────
  // Check trial eligibility for all 3 features
  app.get("/status", auth, ctrl.getTrialStatus);

  // ── POST /api/v1/trials/mark-used ──────────────────────────────────────────
  // Mark a trial as consumed after successful use
  app.post<{
    Body: {
      action: string;
      resultData?: Record<string, any>;
    };
  }>(
    "/mark-used",
    {
      ...auth,
      schema: {
        body: {
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string" },
            resultData: { type: "object" },
          },
        },
      },
    },
    ctrl.markTrialUsed,
  );

  // ── POST /api/v1/trials/convert ────────────────────────────────────────────
  // Convert all used trials to "converted" on upgrade
  app.post("/convert", auth, ctrl.convertTrialsOnUpgrade);
}
