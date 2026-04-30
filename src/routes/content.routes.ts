import { FastifyInstance } from "fastify";
import * as contentController from "../controllers/content.controller";
import type {
  GenerateContentBody,
  GenerateHooksBody,
  RewriteHookBody,
  RepurposeBody,
  AnalyseBody,
} from "../controllers/content.controller";
import {
  authenticateFirebase,
  requirePro,
} from "../middleware/auth.middleware";

const aiRateLimitConfig = {
  max: parseInt(process.env.RATE_LIMIT_AI_MAX || "10", 10),
  timeWindow: parseInt(process.env.RATE_LIMIT_AI_WINDOW || "60000", 10),
  errorResponseBuilder: () => ({
    success: false,
    error: "AI_RATE_LIMITED",
    message:
      "AI generation limit reached. Upgrade to Pro for unlimited generations.",
  }),
};

export default async function contentRoutes(app: FastifyInstance) {
  app.post<{ Body: GenerateContentBody }>(
    "/generate",
    {
      preHandler: [authenticateFirebase],
      config: { rateLimit: aiRateLimitConfig },
      schema: {
        body: {
          type: "object",
          required: ["trendTitle", "platform"],
          properties: {
            trendTitle: { type: "string", minLength: 2, maxLength: 200 },
            platform: {
              type: "string",
              enum: ["instagram", "youtube", "tiktok", "twitter", "linkedin"],
            },
            niche: { type: "string" },
            songTitle: { type: "string" },
            tone: {
              type: "string",
              enum: ["casual", "professional", "humorous", "inspiring"],
              default: "casual",
            },
            language: {
              type: "string",
              enum: ["english", "hindi", "hinglish"],
              default: "hinglish",
            },
          },
        },
      },
    },
    contentController.generateContent,
  );

  app.post<{ Body: GenerateHooksBody }>(
    "/hooks",
    {
      preHandler: [authenticateFirebase],
      config: { rateLimit: aiRateLimitConfig },
      schema: {
        body: {
          type: "object",
          required: ["topic", "platform"],
          properties: {
            topic: { type: "string", minLength: 2, maxLength: 200 },
            platform: { type: "string" },
            niche: { type: "string" },
          },
        },
      },
    },
    contentController.generateHooks,
  );

  app.post<{ Body: RewriteHookBody }>(
    "/rewrite-hook",
    {
      preHandler: [authenticateFirebase, requirePro],
      config: { rateLimit: aiRateLimitConfig },
      schema: {
        body: {
          type: "object",
          required: ["hook"],
          properties: {
            hook: { type: "string", minLength: 5, maxLength: 500 },
            platform: { type: "string" },
            niche: { type: "string" },
          },
        },
      },
    },
    contentController.rewriteHook,
  );

  app.post<{ Body: RepurposeBody }>(
    "/repurpose",
    {
      preHandler: [authenticateFirebase, requirePro],
      config: { rateLimit: aiRateLimitConfig },
      schema: {
        body: {
          type: "object",
          required: ["content", "sourcePlatform"],
          properties: {
            content: { type: "string", minLength: 10, maxLength: 2000 },
            sourcePlatform: { type: "string" },
            targetPlatforms: {
              type: "array",
              items: { type: "string" },
              default: ["instagram", "youtube", "twitter"],
            },
          },
        },
      },
    },
    contentController.repurposeContent,
  );

  app.post<{ Body: AnalyseBody }>(
    "/analyse",
    {
      preHandler: [authenticateFirebase],
      config: { rateLimit: aiRateLimitConfig },
      schema: {
        body: {
          type: "object",
          required: ["caption", "platform"],
          properties: {
            caption: { type: "string", minLength: 5, maxLength: 2200 },
            platform: { type: "string" },
            niche: { type: "string" },
          },
        },
      },
    },
    contentController.analyseContent,
  );

  app.get<{ Querystring: { page?: number; limit?: number } }>(
    "/history",
    {
      preHandler: [authenticateFirebase],
      schema: {
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    contentController.getHistory,
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [authenticateFirebase],
    },
    contentController.deleteContent,
  );
}
