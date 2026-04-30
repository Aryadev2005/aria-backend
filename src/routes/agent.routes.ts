import { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/agent.controller";
import type { SendMessageBody } from "../controllers/agent.controller";
import { authenticateFirebase } from "../middleware/auth.middleware";

export default async function agentRoutes(app: FastifyInstance) {
  app.post<{ Body: SendMessageBody }>(
    "/message",
    {
      preHandler: [authenticateFirebase],
      schema: {
        body: {
          type: "object",
          required: ["message"],
          properties: {
            message: { type: "string", minLength: 1, maxLength: 2000 },
            sessionId: { type: "string" },
            history: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  content: { type: "string" },
                  timestamp: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    ctrl.sendMessage,
  );

  app.get("/memory", { preHandler: [authenticateFirebase] }, ctrl.getMemory);
  app.delete<{ Params: { key: string } }>(
    "/memory/:key",
    { preHandler: [authenticateFirebase] },
    ctrl.deleteMemory,
  );
}
