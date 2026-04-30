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
}
