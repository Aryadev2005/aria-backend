// src/routes/deepAnalysis.routes.ts
// Add this file and register it in app.ts as:
//   import deepAnalysisRoutes from "./routes/deepAnalysis.routes";
//   app.register(deepAnalysisRoutes, { prefix: "/api/v1/studio" });
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyInstance } from "fastify";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { streamDeepAnalysis } from "../controllers/deepAnalysis.controller";

export default async function deepAnalysisRoutes(app: FastifyInstance) {
  // POST /api/v1/studio/deep-analysis/stream
  // Body: { topic, platform?, niche?, contentType?, angle? }
  // Response: text/event-stream SSE
  app.post(
    "/deep-analysis/stream",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["topic"],
          properties: {
            topic: { type: "string", minLength: 2, maxLength: 300 },
            platform: { type: "string" },
            niche: { type: "string" },
            contentType: { type: "string" },
            angle: { type: "string" },
          },
        },
      },
    },
    streamDeepAnalysis as any,
  );
}
