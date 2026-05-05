import { FastifyInstance } from "fastify";
import * as analyticsController from "../controllers/analytics.controller";
import * as roadmapController from "../controllers/roadmap.controller";
import type { TriggerScrapeBody } from "../controllers/analytics.controller";
import {
  authenticateFirebase,
  requirePro,
} from "../middleware/auth.middleware";

export default async function analyticsRoutes(app: FastifyInstance) {
  app.get(
    "/dashboard",
    {
      preHandler: [authenticateFirebase],
    },
    analyticsController.getDashboard,
  );

  app.get(
    "/growth",
    {
      preHandler: [authenticateFirebase, requirePro],
    },
    analyticsController.getGrowthPrediction,
  );

  app.get(
    "/best-times",
    {
      preHandler: [authenticateFirebase],
    },
    analyticsController.getBestPostingTimes,
  );

  app.get(
    "/competitors",
    {
      preHandler: [authenticateFirebase, requirePro],
    },
    analyticsController.getCompetitorInsights,
  );

  app.get(
    "/weekly-report",
    {
      preHandler: [authenticateFirebase, requirePro],
    },
    analyticsController.getWeeklyReport,
  );

  app.get(
    "/archetype",
    {
      preHandler: [authenticateFirebase],
    },
    analyticsController.getArchetype,
  );

  app.get(
    "/roadmap",
    {
      preHandler: [authenticateFirebase],
    },
    roadmapController.getPersonalisedRoadmap,
  );

  app.get(
    "/roadmap/refresh",
    {
      preHandler: [authenticateFirebase],
    },
    roadmapController.refreshRoadmap,
  );

  app.post<{ Body: TriggerScrapeBody }>(
    "/scrape",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["handle", "platform"],
          properties: {
            handle: { type: "string", minLength: 1 },
            platform: { type: "string", enum: ["instagram", "youtube"] },
          },
        },
      },
    },
    analyticsController.triggerScrape,
  );
}
