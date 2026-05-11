// src/controllers/deepAnalysis.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// SSE endpoint controller — streams deep analysis events to the frontend.
// Uses Fastify's raw reply to write Server-Sent Events.
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import { runDeepAnalysis, SSEEvent } from "../services/deep_analysis.service";
import { logger } from "../utils/logger";
import { User } from "../types";

interface DeepAnalysisBody {
  topic: string;
  platform?: string;
  niche?: string;
  contentType?: string;
  angle?: string;
}

export const streamDeepAnalysis = async (
  req: FastifyRequest<{ Body: DeepAnalysisBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { topic, platform, niche, contentType = "reel", angle } = req.body;

  if (!topic?.trim()) {
    return reply.status(400).send({ error: "topic is required" });
  }

  // ── Set up SSE headers ────────────────────────────────────────────────────
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
    "Access-Control-Allow-Origin": "*",
  });

  // Helper to write a single SSE event
  const sendSSE = (event: SSEEvent) => {
    try {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      // Client disconnected mid-stream — ignore
    }
  };

  // Keepalive ping every 15s so the connection doesn't time out
  const keepAlive = setInterval(() => {
    try {
      reply.raw.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 15_000);

  try {
    await runDeepAnalysis(
      {
        topic: topic.trim(),
        platform: platform || user.primary_platform || "instagram",
        niche: niche || user.niches?.[0] || "general",
        contentType,
        angle,
        creatorName: user.name || undefined,
      },
      sendSSE,
    );
  } catch (err: any) {
    logger.error(
      { err: err.message, userId: user.id },
      "Deep analysis stream failed",
    );
    sendSSE({
      type: "error",
      message: "Something went wrong. Please try again.",
    });
  } finally {
    clearInterval(keepAlive);
    reply.raw.end();
  }
};
