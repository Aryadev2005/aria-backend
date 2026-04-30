import { FastifyInstance } from "fastify";
import * as radarController from "../controllers/radar.controller";
import type { RadarQuery } from "../controllers/radar.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

export default async function radarRoutes(app: FastifyInstance) {
  // GET /api/v1/discover/intelligence
  app.get<{ Querystring: RadarQuery }>(
    "/intelligence",
    {
      preHandler: [authenticateFirebase],
      schema: {
        querystring: {
          type: "object",
          properties: {
            niche: { type: "string" },
            platform: { type: "string", enum: ["instagram", "youtube"] },
          },
        },
      },
    },
    radarController.getIntelligence,
  );

  // GET /api/v1/discover/competitors
  app.get<{ Querystring: RadarQuery }>(
    "/competitors",
    {
      preHandler: [authenticateFirebase],
      schema: {
        querystring: {
          type: "object",
          properties: {
            niche: { type: "string" },
            platform: { type: "string" },
          },
        },
      },
    },
    radarController.getCompetitors,
  );

  // GET /api/v1/discover/inspiration
  app.get<{ Querystring: RadarQuery }>(
    "/inspiration",
    {
      preHandler: [authenticateFirebase],
      schema: {
        querystring: {
          type: "object",
          properties: {
            niche: { type: "string" },
            platform: { type: "string" },
          },
        },
      },
    },
    radarController.getInspiration,
  );
}
