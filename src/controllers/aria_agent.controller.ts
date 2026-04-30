import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import {
  getMemory,
  getPendingSuggestions,
} from "../services/aria_memory.service";
import { User } from "../types";
import { ChatGroq } from "@langchain/groq";

// Dynamic import for agent logic to avoid issues if they are not yet TS or have circular deps
// But since we are switching to ES Modules/TS, we can use import.
// For JS files, we might need to use require if they don't export correctly for ESM,
// but TS should handle it with esModuleInterop.
import { invokeARIAAgent, streamARIAAgent } from "../agent/aria_agent";

export interface ChatBody {
  message: string;
  sessionId: string;
  entryScreen?: string;
  context?: any;
}

// ── POST /api/v1/brain/chat ──────────────────────────────────────────────────
export const chat = async (
  req: FastifyRequest<{ Body: ChatBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const {
    message,
    sessionId,
    entryScreen = "direct",
    context: sessionContext = {},
  } = req.body;

  if (!message?.trim()) return errors.validation(reply, "message is required");
  if (!sessionId) return errors.validation(reply, "sessionId is required");

  const db = prisma;

  try {
    // Fetch full user for agent context (archetype, memory, platform, etc.)
    const fullUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        name: true,
        archetype: true,
        archetype_label: true,
        growth_stage: true,
        tone_profile: true,
        health_score: true,
        engagement_rate: true,
        follower_range: true,
        primary_platform: true,
        niches: true,
        scraped_summary: true,
        instagram_handle: true,
        youtube_handle: true,
        instagram_access_token: true,
        instagram_user_id: true,
      },
    });

    const result = await invokeARIAAgent({
      message,
      sessionId,
      user: fullUser,
      db,
      entryScreen,
      sessionContext,
    });

    return success(reply, result);
  } catch (err) {
    logger.error({ err, userId: user.id }, "Agent chat controller failed");
    return errors.serviceDown(reply, "ARIA Brain");
  }
};

export interface GreetQuery {
  entryScreen?: string;
  sessionId?: string;
  context?: string;
}

// ── GET /api/v1/brain/greet ──────────────────────────────────────────────────
export const greet = async (
  req: FastifyRequest<{ Querystring: GreetQuery }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { entryScreen = "direct", sessionId } = req.query;
  const sessionContext = req.query.context ? JSON.parse(req.query.context) : {};

  try {
    const db = prisma;
    const fullUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: {
        name: true,
        archetype: true,
        archetype_label: true,
        health_score: true,
        niches: true,
        primary_platform: true,
        follower_range: true,
      },
    });

    const [memory, pendingSuggestions] = await Promise.all([
      getMemory(user.id),
      getPendingSuggestions(user.id),
    ]);

    const firstName = (fullUser?.name || "yaar").split(" ")[0];
    const hasContext = sessionContext.idea || sessionContext.script;

    // Build a targeted greeting prompt for the agent
    const greetMessage = [
      `Generate a SHORT warm greeting (2-3 sentences max) for ${firstName}.`,
      entryScreen !== "direct"
        ? `They just came from the ${entryScreen} screen.`
        : "",
      hasContext
        ? `They were working on: "${sessionContext.idea || sessionContext.trendTitle}"`
        : "",
      pendingSuggestions.length > 0
        ? `You have ${pendingSuggestions.length} pending follow-up to close.`
        : "",
      `End with one specific question or offer to help. Use Hinglish naturally. DO NOT say "How can I help you today?".`,
    ]
      .filter(Boolean)
      .join(" ");

    const llm = new ChatGroq({
      model: "llama-3.3-70b-versatile",
      apiKey: process.env.GROQ_API_KEY,
      maxTokens: 120,
    });

    const nicheList = Array.isArray(fullUser?.niches) ? fullUser?.niches : [];

    const response = await llm.invoke([
      {
        role: "system",
        content: `You are ARIA, India's AI creator assistant. Archetype: ${fullUser?.archetype}. Niche: ${nicheList[0]}.`,
      },
      { role: "user", content: greetMessage },
    ]);

    return success(reply, {
      greeting: response.content,
      hasPendingFollowUps: pendingSuggestions.length > 0,
    });
  } catch (err) {
    logger.error({ err }, "Greet failed");
    return success(reply, {
      greeting: "Hey! What are we working on today?",
      hasPendingFollowUps: false,
    });
  }
};

// ── POST /api/v1/brain/chat/stream  (SSE streaming version) ──────────────────
export const chatStream = async (
  req: FastifyRequest<{ Body: ChatBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { message, sessionId, entryScreen = "direct" } = req.body;

  if (!message?.trim() || !sessionId) {
    return errors.validation(reply, "message and sessionId required");
  }

  const db = prisma;
  const fullUser = await prisma.users.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      archetype: true,
      niches: true,
      primary_platform: true,
      follower_range: true,
      engagement_rate: true,
      health_score: true,
      instagram_access_token: true,
      instagram_user_id: true,
    },
  });

  // Set SSE headers
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering
  });

  try {
    for await (const event of streamARIAAgent({
      message,
      sessionId,
      user: fullUser,
      db,
    })) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

      if (event.type === "done" || event.type === "error") {
        reply.raw.end();
        return;
      }
    }
  } catch (err) {
    reply.raw.write(
      `data: ${JSON.stringify({ type: "error", message: "Stream failed" })}\n\n`,
    );
    reply.raw.end();
  }
};
