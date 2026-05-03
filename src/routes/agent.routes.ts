import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/agent.controller";
import type { SendMessageBody } from "../controllers/agent.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

const aiRateLimit = {
  max: 30,
  timeWindow: "1 minute",
  errorResponseBuilder: () => ({
    success: false,
    error: "RATE_LIMIT",
    message: "Too many messages. Please slow down a little.",
  }),
};

export default async function agentRoutes(app: FastifyInstance) {
  // ── Messaging ──────────────────────────────────────────────────────────────

  // POST /api/v1/agent/message  — full response (non-streaming)
  app.post<{ Body: SendMessageBody }>(
    "/message",
    {
      preHandler: [authenticateFirebase],
      config: { rateLimit: aiRateLimit },
      schema: {
        body: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", minLength: 1, maxLength: 2000 },
            sessionId: { type: "string" },
          },
        },
      },
    },
    ctrl.sendMessage,
  );

  // POST /api/v1/agent/stream  — SSE streaming
  app.post<{ Body: SendMessageBody }>(
    "/stream",
    {
      preHandler: [authenticateFirebase],
      config: { rateLimit: aiRateLimit },
    },
    ctrl.streamMessage,
  );

  // ── Sessions ───────────────────────────────────────────────────────────────

  // GET /api/v1/agent/sessions  — list all sessions for user
  app.get("/sessions", { preHandler: [authenticateFirebase] }, ctrl.getSessions);

  // GET /api/v1/agent/sessions/:sessionId/messages  — load a past session
  app.get<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId/messages",
    { preHandler: [authenticateFirebase] },
    ctrl.getSessionMessages,
  );

  // PATCH /api/v1/agent/sessions/:sessionId  — rename a session
  app.patch<{ Params: { sessionId: string }; Body: { title: string } }>(
    "/sessions/:sessionId",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["title"],
          properties: { title: { type: "string", minLength: 1, maxLength: 80 } },
        },
      },
    },
    ctrl.renameSessionHandler,
  );

  // DELETE /api/v1/agent/sessions/:sessionId  — delete session + all messages
  app.delete<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId",
    { preHandler: [authenticateFirebase] },
    ctrl.deleteSessionHandler,
  );

  // ── Memory ─────────────────────────────────────────────────────────────────

  // GET /api/v1/agent/memory
  app.get("/memory", { preHandler: [authenticateFirebase] }, ctrl.getMemoryHandler);

  // DELETE /api/v1/agent/memory/:key
  app.delete<{ Params: { key: string } }>(
    "/memory/:key",
    { preHandler: [authenticateFirebase] },
    ctrl.deleteMemory,
  );
}
