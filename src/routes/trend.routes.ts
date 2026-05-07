import { FastifyInstance } from "fastify";
import * as trendController from "../controllers/trend.controller";
import type {
  GetTrendsQuery,
  FeedbackBody,
} from "../controllers/trend.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

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

  // GET /api/v1/trends/viral-ideas
  app.get<{ Querystring: { force?: string; browseNiche?: string } }>(
    "/viral-ideas",
    {
      preHandler: [authenticateFirebase],
      schema: {
        querystring: {
          type: "object",
          properties: {
            force:       { type: "string", enum: ["true", "false"] },
            browseNiche: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    trendController.getViralIdeas
  );

  // POST /api/v1/trends/interaction
  app.post<{
    Body: {
      trendId?: string; trendTitle: string;
      source?: string; niche?: string;
      action: string;
    }
  }>(
    '/interaction',
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: 'object',
          required: ['trendTitle', 'action'],
          properties: {
            trendId:    { type: 'string' },
            trendTitle: { type: 'string', maxLength: 200 },
            source:     { type: 'string' },
            niche:      { type: 'string' },
            action:     { type: 'string', enum: ['viewed', 'saved', 'created', 'dismissed'] },
          },
        },
      },
    },
    trendController.recordTrendInteraction,
  );
}
