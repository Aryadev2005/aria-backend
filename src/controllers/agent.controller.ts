import { FastifyRequest, FastifyReply } from "fastify";
import { invokeARIAAgent, streamARIAAgent } from "../agent/aria_agent";
import { getMemory } from "../services/ariaBrain.service";
import { success, errors, created, noContent } from "../utils/response";
import { logger } from "../utils/logger";
import { prisma } from "../config/database";
import { User } from "../types";
import {
  listSessions,
  getSession,
  deleteSession,
  renameSession,
  getMessages,
  saveMessage,
  upsertSession,
  autogenerateTitle,
} from "../services/aria_sessions.service";

/** Normalize OpenAI content-block arrays → plain string */
const extractText = (content: any): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "")
      .join("");
  if (content && typeof content === "object" && typeof content.text === "string")
    return content.text;
  return "";
};

export interface SendMessageBody {
  message: string;
  sessionId?: string;
  history?: any[];
  /** e.g. 'profile' | 'studio' | 'discover' | 'launch' | 'direct' */
  entryScreen?: string;
  /** Any extra session context the frontend wants to pass (idea, trendTitle, etc.) */
  context?: Record<string, any>;
}

// ── POST /api/v1/agent/message ─────────────────────────────────────────────────
export const sendMessage = async (
  req: FastifyRequest<{ Body: SendMessageBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { message, sessionId = `sess_${user.id}_${Date.now()}` } = req.body;

  if (!message?.trim()) return errors.notFound(reply, "Message");

  try {
    // Ensure session exists
    const isFirstMessage = !(await getSession(user.id, sessionId));
    await upsertSession(user.id, sessionId, {
      title: isFirstMessage ? autogenerateTitle(message) : undefined,
      incrMessages: false,
    });

    // Save user message
    await saveMessage(user.id, sessionId, "user", message.trim());

    const result = await invokeARIAAgent({
      message: message.trim(),
      sessionId,
      user,
      db: prisma,
      entryScreen: req.body.entryScreen,
      sessionContext: req.body.context,
    });

    // Save assistant reply
    await saveMessage(
      user.id,
      sessionId,
      "assistant",
      result.message,
      (result as any).toolsUsed?.map((t: string) => ({ name: t })),
    );

    return success(reply, {
      reply: result.message,
      toolsUsed: (result as any).toolsUsed ?? [],
      sessionId,
      duration: (result as any).duration ?? 0,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "Agent message failed");
    return errors.serviceDown(reply, "ARIA");
  }
};

// ── POST /api/v1/agent/stream ──────────────────────────────────────────────────
export const streamMessage = async (
  req: FastifyRequest<{ Body: SendMessageBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { message, sessionId = `sess_${user.id}_${Date.now()}` } = req.body;

  if (!message?.trim()) {
    return reply.code(400).send({ success: false, error: "Message required" });
  }

  // Ensure session row exists before we start streaming
  const isFirstMessage = !(await getSession(user.id, sessionId));
  await upsertSession(user.id, sessionId, {
    title: isFirstMessage ? autogenerateTitle(message.trim()) : undefined,
    incrMessages: false,
  });

  // Save user message immediately (before streaming starts)
  await saveMessage(user.id, sessionId, "user", message.trim());

  // ⚠️ reply.raw.writeHead() bypasses Fastify's entire response pipeline,
  // including @fastify/cors. We must manually forward CORS headers here or the
  // browser will block the SSE stream even though the server returns 200 OK.
  const requestOrigin = req.headers.origin ?? "*";
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": requestOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  });

  const send = (data: object) => {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let fullReply = "";
  const toolsUsed: string[] = [];

  try {
    const gen = streamARIAAgent({
      message: message.trim(),
      sessionId,
      user,
      db: prisma,
      entryScreen: req.body.entryScreen,
      sessionContext: req.body.context,
    });

    for await (const event of gen) {
      send(event);

      // Collect data for persistence
      if ((event as any).type === "token") fullReply += extractText((event as any).content);
      if ((event as any).type === "tool_start") toolsUsed.push((event as any).tool);
      if ((event as any).type === "done") {
        fullReply = extractText((event as any).message) || fullReply;
        break;
      }
      if ((event as any).type === "error") break;
    }
  } catch (err: any) {
    logger.error({ err, userId: user.id }, "Agent stream failed");
    send({ type: "error", message: "ARIA encountered an error. Please try again." });
  } finally {
    // Persist the assistant reply after streaming completes
    if (fullReply) {
      saveMessage(
        user.id,
        sessionId,
        "assistant",
        fullReply,
        toolsUsed.map((t) => ({ name: t })),
      ).catch((err) => logger.warn({ err }, "Failed to save assistant message"));
    }
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
  }
};

// ── GET /api/v1/agent/sessions ─────────────────────────────────────────────────
export const getSessions = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    const sessions = await listSessions(user.id);
    return success(reply, sessions);
  } catch (err) {
    logger.error({ err, userId: user.id }, "List sessions failed");
    return errors.internal(reply);
  }
};

// ── GET /api/v1/agent/sessions/:sessionId/messages ────────────────────────────
export const getSessionMessages = async (
  req: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { sessionId } = req.params;
  try {
    const session = await getSession(user.id, sessionId);
    if (!session) return errors.notFound(reply, "Session");

    const messages = await getMessages(user.id, sessionId);
    return success(reply, { session, messages });
  } catch (err) {
    logger.error({ err, userId: user.id }, "Get session messages failed");
    return errors.internal(reply);
  }
};

// ── DELETE /api/v1/agent/sessions/:sessionId ──────────────────────────────────
export const deleteSessionHandler = async (
  req: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { sessionId } = req.params;
  try {
    const session = await getSession(user.id, sessionId);
    if (!session) return errors.notFound(reply, "Session");

    await deleteSession(user.id, sessionId);
    return noContent(reply);
  } catch (err) {
    logger.error({ err, userId: user.id }, "Delete session failed");
    return errors.internal(reply);
  }
};

// ── PATCH /api/v1/agent/sessions/:sessionId ───────────────────────────────────
export const renameSessionHandler = async (
  req: FastifyRequest<{ Params: { sessionId: string }; Body: { title: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { sessionId } = req.params;
  const { title } = req.body;

  if (!title?.trim()) return errors.badRequest(reply, "Title is required");

  try {
    await renameSession(user.id, sessionId, title.trim());
    return success(reply, { updated: true });
  } catch (err) {
    logger.error({ err, userId: user.id }, "Rename session failed");
    return errors.internal(reply);
  }
};

// ── GET /api/v1/agent/memory ───────────────────────────────────────────────────
export const getMemoryHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    const memory = await getMemory(user.id);
    return success(reply, { memory, count: Object.keys(memory).length });
  } catch (err) {
    logger.error({ err, userId: user.id }, "Get memory failed");
    return errors.internal(reply);
  }
};

// ── DELETE /api/v1/agent/memory/:key ──────────────────────────────────────────
export const deleteMemory = async (
  req: FastifyRequest<{ Params: { key: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { key } = req.params;
  try {
    await (prisma as any).aria_memory.deleteMany({
      where: { user_id: user.id, key },
    });
    return success(reply, { deleted: true });
  } catch (err) {
    logger.error({ err, userId: user.id, key }, "Delete memory failed");
    return errors.internal(reply);
  }
};
