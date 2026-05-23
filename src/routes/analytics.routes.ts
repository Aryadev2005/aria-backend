import { FastifyInstance } from "fastify";
import * as analyticsController from "../controllers/analytics.controller";
import * as roadmapController from "../controllers/roadmap.controller";
import type { TriggerScrapeBody } from "../controllers/analytics.controller";
import {
  authenticateFirebase,
  requirePro,
} from "../middleware/auth.middleware";
import { requireCredits } from "../middleware/credits.middleware";

const auth = { preHandler: [authenticateFirebase] };
const authPro = { preHandler: [authenticateFirebase, requirePro] };

// Credit-protected auth variants
const authArchetype = {
  preHandler: [authenticateFirebase, requireCredits("archetype_detection")],
};
const authRoadmap = {
  preHandler: [authenticateFirebase, requireCredits("growth_roadmap")],
};
const authWeeklyReport = {
  preHandler: [
    authenticateFirebase,
    requirePro,
    requireCredits("weekly_report"),
  ],
};

export default async function analyticsRoutes(app: FastifyInstance) {
  // ── Existing analytics routes ───────────────────────────────────────────
  // Dashboard archetype detection only charges on first detection (cached after)
  // Note: archetype uses auth (no credits) - controller handles credit logic internally
  app.get("/dashboard", auth, analyticsController.getDashboard);
  app.get("/growth", authPro, analyticsController.getGrowthPrediction);
  app.get("/best-times", auth, analyticsController.getBestPostingTimes);
  app.get(
    "/weekly-report",
    authWeeklyReport,
    analyticsController.getWeeklyReport,
  );
  app.get("/archetype", auth, analyticsController.getArchetype);

  // ── Roadmap ─────────────────────────────────────────────────────────────

  // GET /api/v1/analytics/roadmap          → serve (cached or fresh)
  // GET /api/v1/analytics/roadmap?force=true → bypass cache + regenerate
  app.get("/roadmap", authRoadmap, roadmapController.getPersonalisedRoadmap);

  // GET /api/v1/analytics/roadmap/refresh  → explicit refresh endpoint
  app.get("/roadmap/refresh", authRoadmap, roadmapController.refreshRoadmap);

  // GET /api/v1/analytics/roadmap/action-states?version=xxx
  app.get("/roadmap/action-states", auth, roadmapController.getActionStates);

  // POST /api/v1/analytics/roadmap/action/complete
  app.post<{
    Body: {
      roadmapVersion: string;
      weekNumber: number;
      actionIndex: number;
      actionText: string;
    };
  }>(
    "/roadmap/action/complete",
    {
      ...auth,
      schema: {
        body: {
          type: "object",
          required: [
            "roadmapVersion",
            "weekNumber",
            "actionIndex",
            "actionText",
          ],
          properties: {
            roadmapVersion: { type: "string", minLength: 1 },
            weekNumber: { type: "integer", minimum: 1, maximum: 4 },
            actionIndex: { type: "integer", minimum: 0 },
            actionText: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    roadmapController.completeRoadmapAction,
  );

  // POST /api/v1/analytics/roadmap/action/dismiss
  app.post<{
    Body: {
      roadmapVersion: string;
      weekNumber: number;
      actionIndex: number;
      actionText: string;
    };
  }>(
    "/roadmap/action/dismiss",
    {
      ...auth,
      schema: {
        body: {
          type: "object",
          required: [
            "roadmapVersion",
            "weekNumber",
            "actionIndex",
            "actionText",
          ],
          properties: {
            roadmapVersion: { type: "string", minLength: 1 },
            weekNumber: { type: "integer", minimum: 1, maximum: 4 },
            actionIndex: { type: "integer", minimum: 0 },
            actionText: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    roadmapController.dismissRoadmapActionHandler,
  );

  // ── Scrape ──────────────────────────────────────────────────────────────
  app.post<{ Body: TriggerScrapeBody }>(
    "/scrape",
    {
      ...auth,
      schema: {
        body: {
          type: "object",
          required: ["handle", "platform"],
          properties: {
            handle: { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-zA-Z0-9._@-]{1,100}$" },
            platform: { type: "string", enum: ["instagram", "youtube"] },
          },
        },
      },
    },
    analyticsController.triggerScrape,
  );
}
