import { FastifyInstance } from "fastify";
import * as trendController from "../controllers/trend.controller";
import type {
  GetTrendsQuery,
  FeedbackBody,
} from "../controllers/trend.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { requireCredits } from "../middleware/credits.middleware";
import { getUpcomingEvents, getEventContentAngles } from "../services/culturalCalendar.service";

export default async function trendRoutes(app: FastifyInstance) {
  app.get<{ Querystring: GetTrendsQuery }>(
    "/",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            niche: { type: "string", default: "fashion" },
            platform: { type: "string", default: "instagram" },
            badge: { type: "string", default: "ALL" },
            page: { type: "integer", default: 1 },
            limit: { type: "integer", default: 10 },
          },
        },
      },
    },
    trendController.getTrends,
  );

  app.get(
    "/personalized",
    {
      preHandler: [authenticateFirebase],
    },
    trendController.getPersonalizedTrends,
  );

  app.get(
    "/opportunity-windows",
    {
      preHandler: [authenticateFirebase],
    },
    trendController.getOpportunityWindows,
  );

  app.get(
    "/viral-radar",
    {
      preHandler: [authenticateFirebase],
    },
    trendController.getViralRadar,
  );

  app.get(
    "/saved",
    {
      preHandler: [authenticateFirebase],
    },
    trendController.getSavedTrends,
  );

  app.get<{ Params: { id: string } }>("/:id", {}, trendController.getTrendById);

  app.post<{ Params: { id: string } }>(
    "/:id/save",
    {
      preHandler: [authenticateFirebase],
    },
    trendController.saveTrend,
  );

  app.delete<{ Params: { id: string } }>(
    "/:id/save",
    {
      preHandler: [authenticateFirebase],
    },
    trendController.unsaveTrend,
  );

  app.post<{ Body: FeedbackBody }>(
    "/feedback",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["recommendationType", "recommendationData", "wasHelpful"],
          properties: {
            recommendationType: { type: "string" },
            recommendationData: { type: "object" },
            wasHelpful: { type: "boolean" },
            resultNotes: { type: "string" },
          },
        },
      },
    },
    trendController.submitFeedback,
  );

  // GET /api/v1/trends/viral-ideas (AI-powered)
  app.get<{ Querystring: { force?: string; browseNiche?: string } }>(
    "/viral-ideas",
    {
      preHandler: [authenticateFirebase, requireCredits("viral_ideas")],
      schema: {
        querystring: {
          type: "object",
          properties: {
            force: { type: "string", enum: ["true", "false"] },
            browseNiche: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    trendController.getViralIdeas,
  );

  // GET /api/v1/trends/voice-fit-preview (free endpoint)
  app.get(
    "/voice-fit-preview",
    {
      preHandler: [authenticateFirebase],
    },
    trendController.getVoiceFitPreview,
  );

  // POST /api/v1/trends/interaction
  app.post<{
    Body: {
      trendId?: string;
      trendTitle: string;
      source?: string;
      niche?: string;
      action: "viewed" | "saved" | "created" | "dismissed";
    };
  }>(
    "/interaction",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["trendTitle", "action"],
          properties: {
            trendId: { type: "string" },
            trendTitle: { type: "string", maxLength: 200 },
            source: { type: "string" },
            niche: { type: "string" },
            action: {
              type: "string",
              enum: ["viewed", "saved", "created", "dismissed"],
            },
          },
        },
      },
    },
    trendController.recordTrendInteraction,
  );

  // ── GET /api/v1/trends/cultural-calendar ─────────────────────────────────
  app.get('/cultural-calendar', { preHandler: [authenticateFirebase] }, (_req, reply) => {
    try {
      const events = getUpcomingEvents(30);
      return reply.send({ success: true, data: { events } });
    } catch (err) {
      return reply.status(500).send({ success: false, error: 'cultural calendar failed' });
    }
  });

  // ── GET /api/v1/trends/cultural-calendar/:id/angles ───────────────────────
  app.get<{ Params: { id: string } }>(
    '/cultural-calendar/:id/angles',
    { preHandler: [authenticateFirebase] },
    (req, reply) => {
      const angles = getEventContentAngles(req.params.id);
      if (!angles.length) {
        return reply.status(404).send({ success: false, error: 'Event not found' });
      }
      return reply.send({ success: true, data: { angles } });
    },
  );
}
