import { FastifyInstance } from "fastify";
import * as calendarController from "../controllers/calendar.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";
import { requireCredits } from "../middleware/credits.middleware";

export default async function calendarRoutes(fastify: FastifyInstance) {
  // POST /api/v1/calendar/generate (AI-powered)
  fastify.post(
    "/generate",
    {
      schema: {
        body: {
          type: "object",
          required: ["niche", "platform", "followerRange", "month", "year"],
          properties: {
            niche: { type: "string", maxLength: 100 },
            platform: {
              type: "string",
              enum: ["Instagram", "YouTube", "TikTok", "Twitter/X"],
            },
            followerRange: { type: "string" },
            month: { type: "string" },
            year: { type: "integer", minimum: 2024, maximum: 2030 },
          },
        },
      },
      preHandler: [authenticateFirebase, requireCredits("content_calendar")],
    },
    calendarController.generate as any,
  );

  // GET /api/v1/calendar/saved
  fastify.get(
    "/saved",
    {
      preHandler: [authenticateFirebase],
    },
    calendarController.getSaved,
  );

  // POST /api/v1/calendar/save
  fastify.post(
    "/save",
    {
      schema: {
        body: {
          type: "object",
          required: ["month", "year", "calendarData"],
          properties: {
            month: { type: "string" },
            year: { type: "integer" },
            calendarData: { type: "object" },
          },
        },
      },
      preHandler: [authenticateFirebase],
    },
    calendarController.save as any,
  );
}
