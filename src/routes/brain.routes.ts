import { FastifyInstance } from "fastify";
import { chat, greet, chatStream } from "../controllers/aria_agent.controller";
import type {
  ChatBody,
  GreetQuery,
} from "../controllers/aria_agent.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

const aiRateLimit = {
  max: 60,
  timeWindow: "1 minute",
  errorResponseBuilder: () => ({
    success: false,
    error: "RATE_LIMIT",
    message: "Too many messages. Please slow down a little.",
  }),
};

export default async function brainRoutes(app: FastifyInstance) {
  // POST /api/v1/brain/chat
  app.post<{ Body: ChatBody }>(
    "/chat",
    {
      preHandler: [authenticateFirebase],
      config: { rateLimit: aiRateLimit },
      schema: {
        body: {
          type: "object",
          required: ["message", "sessionId"],
          properties: {
            message: { type: "string", minLength: 1, maxLength: 4000 },
            sessionId: { type: "string", minLength: 1 },
            entryScreen: {
              type: "string",
              enum: ["discover", "studio", "launch", "profile", "direct"],
              default: "direct",
            },
            context: {
              type: "object",
              properties: {
                idea: { type: "string" },
                script: { type: "string" },
                platform: { type: "string" },
                format: { type: "string" },
                trendTitle: { type: "string" },
              },
            },
            conversationHistory: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                },
              },
              maxItems: 20,
            },
          },
        },
      },
    },
    chat,
  );

  // POST /api/v1/brain/chat/stream
  app.post<{ Body: ChatBody }>(
    "/chat/stream",
    {
      preHandler: [authenticateFirebase],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    chatStream,
  );

  // GET /api/v1/brain/greet
  app.get<{ Querystring: GreetQuery }>(
    "/greet",
    {
      preHandler: [authenticateFirebase],
      schema: {
        querystring: {
          type: "object",
          properties: {
            entryScreen: { type: "string", default: "direct" },
            sessionId: { type: "string" },
            context: { type: "string" }, // JSON string
          },
        },
      },
    },
    greet,
  );
}
