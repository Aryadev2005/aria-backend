import { FastifyRequest, FastifyReply } from "fastify";
import { invokeARIAAgent, streamARIAAgent } from "../agent/aria_agent";
import { getMemory } from "../services/ariaBrain.service";
import { success, errors, created, noContent } from "../utils/response";
import { logger } from "../utils/logger";
import { prisma } from "../config/database";
import { User } from "../types";
import { debitCredits } from "../services/credits.service";
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
  if (
    content &&
    typeof content === "object" &&
    typeof content.text === "string"
  )
    return content.text;
  return "";
};

// ─────────────────────────────────────────────────────────────────────────────
// AI SDK v6 UIMessageChunk stream protocol helpers
// Each SSE event carries a JSON object validated against uiMessageChunkSchema.
// ─────────────────────────────────────────────────────────────────────────────
const sdkLine = (chunk: object) =>
  `data: ${JSON.stringify(chunk)}\n\n`;

// Map our internal tool names → display-friendly names for useChat parts
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  get_db_live_trends: "get_db_live_trends",
  get_db_trending_songs: "get_db_trending_songs",
  get_user_profile: "get_user_profile",
  get_youtube_video_stats: "get_youtube_video_stats",
  get_youtube_channel_stats: "get_youtube_channel_stats",
  get_youtube_search: "get_youtube_search",
  get_hybrid_context: "get_hybrid_context",
  find_similar_trends: "find_similar_trends",
  viral_ideas_engine: "viral_ideas_engine",
  confirm_niche: "confirm_niche",
  get_user_content_history: "get_user_content_history",
  web_search: "web_search",
};

// Tools that should emit a ui_block annotation for generative UI rendering
const UI_BLOCK_TOOLS = new Set([
  "get_db_live_trends",
  "get_db_trending_songs",
  "get_user_profile",
  "get_youtube_video_stats",
  "get_youtube_channel_stats",
  "get_youtube_search",
  "get_hybrid_context",
  "find_similar_trends",
  "viral_ideas_engine",
]);

export interface SendMessageBody {
  message: string;
  sessionId?: string;
  history?: any[];
  entryScreen?: string;
  context?: Record<string, any>;
}

// ── POST /api/v1/agent/message  (non-streaming, legacy) ───────────────────────
export const sendMessage = async (
  req: FastifyRequest<{ Body: SendMessageBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { message, sessionId = `sess_${user.id}_${Date.now()}` } = req.body;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  if (!message?.trim()) return errors.notFound(reply, "Message");

  try {
    const isFirstMessage = !(await getSession(user.id, sessionId));
    await upsertSession(user.id, sessionId, {
      title: isFirstMessage ? autogenerateTitle(message.trim()) : undefined,
      incrMessages: false,
    });

    await saveMessage(user.id, sessionId, "user", message.trim());

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
      },
    });

    const result = await invokeARIAAgent({
      message: message.trim(),
      sessionId,
      user: fullUser,
      db: prisma,
      entryScreen: req.body.entryScreen,
      sessionContext: req.body.context,
    });

    await debitCredits(user.id, "aria_chat", modelToUse, 2000, 800).catch(
      (err) => logger.warn({ err }, "Debit failed — non-fatal"),
    );

    if (result.message) {
      await saveMessage(
        user.id,
        sessionId,
        "assistant",
        result.message,
        result.toolsUsed?.map((t: string) => ({ name: t })),
      ).catch((err) =>
        logger.warn({ err }, "Failed to save assistant message"),
      );
    }

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.cost ?? 0,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "Agent message failed");
    return errors.serviceDown(reply, "ARIA Brain");
  }
};

// ── POST /api/v1/agent/stream  (AI SDK Data Stream Protocol) ─────────────────
// Consumed by @ai-sdk/react useChat({ api: '/api/v1/agent/stream' })
export const streamMessage = async (
  req: FastifyRequest<{ Body: SendMessageBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const {
    message,
    sessionId = `sess_${user.id}_${Date.now()}`,
    entryScreen = "direct",
    context: sessionContext = {},
  } = req.body;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  if (!message?.trim() || !sessionId) {
    return errors.validation(reply, "message and sessionId required");
  }

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
    },
  });

  // Session housekeeping
  const isFirstMessage = !(await getSession(user.id, sessionId));
  await upsertSession(user.id, sessionId, {
    title: isFirstMessage ? autogenerateTitle(message.trim()) : undefined,
    incrMessages: false,
  });
  await saveMessage(user.id, sessionId, "user", message.trim());

  // ─── SSE headers — must be set before first write ────────────────────────
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

  // AI SDK v6 stream helper — writes one UIMessageChunk SSE event
  const write = (chunk: object) => reply.raw.write(sdkLine(chunk));

  let fullReply = "";
  const toolsUsed: string[] = [];
  const pendingCalls = new Map<string, string>();
  let toolCallCounter = 0;
  // Each text run gets a stable id so text-start/delta/end triplets are linked
  const textPartId = `txt_${Date.now()}`;

  // v6: open the message
  write({ type: "start" });
  write({ type: "start-step" });

  try {
    const gen = streamARIAAgent({
      message: message.trim(),
      sessionId,
      user: fullUser,
      db: prisma,
      entryScreen,
      sessionContext,
    });

    let textOpen = false;

    for await (const event of gen) {
      const ev = event as any;

      switch (ev.type) {
        case "token": {
          const delta =
            typeof ev.content === "string"
              ? ev.content
              : extractText(ev.content);
          if (delta) {
            fullReply += delta;
            if (!textOpen) {
              write({ type: "text-start", id: textPartId });
              textOpen = true;
            }
            write({ type: "text-delta", id: textPartId, delta });
          }
          break;
        }

        case "tool_start": {
          // Close any open text part before emitting tool chunks
          if (textOpen) {
            write({ type: "text-end", id: textPartId });
            textOpen = false;
          }
          toolsUsed.push(ev.tool);
          const callId = `call_${++toolCallCounter}`;
          pendingCalls.set(ev.tool, callId);
          const toolName = TOOL_DISPLAY_NAMES[ev.tool] ?? ev.tool;

          write({
            type: "tool-input-available",
            toolCallId: callId,
            toolName,
            input: ev.input ?? {},
          });

          // Custom data chunk — carries our ToolPill metadata
          write({
            type: "data-tool_running",
            data: {
              tool: ev.tool,
              callId,
              displayName: toolName
                .replace(/_/g, " ")
                .replace(/\b\w/g, (c: string) => c.toUpperCase()),
            },
          });
          break;
        }

        case "tool_end": {
          const callId = pendingCalls.get(ev.tool) ?? `call_${toolCallCounter}`;
          pendingCalls.delete(ev.tool);

          const toolName = TOOL_DISPLAY_NAMES[ev.tool] ?? ev.tool;
          let result = ev.output ?? ev.result ?? null;
          if (typeof result === "string") {
            try { result = JSON.parse(result); } catch { /* keep as string */ }
          }

          write({
            type: "tool-output-available",
            toolCallId: callId,
            output: result ?? {},
          });

          write({
            type: "data-tool_done",
            data: { tool: ev.tool, callId },
          });

          if (UI_BLOCK_TOOLS.has(ev.tool) && result) {
            write({
              type: "data-ui_block",
              data: { blockType: ev.tool, payload: result },
            });
          }
          break;
        }

        case "done": {
          fullReply = extractText(ev.message) || fullReply;
          break;
        }

        case "error": {
          logger.error({ userId: user.id }, "ARIA stream error event");
          break;
        }
      }
    }

    if (textOpen) {
      write({ type: "text-end", id: textPartId });
    }
  } catch (err: any) {
    logger.error({ err, userId: user.id }, "Agent stream failed");
    write({ type: "text-start", id: textPartId });
    write({ type: "text-delta", id: textPartId, delta: "\n\n⚠️ ARIA encountered an error. Please try again." });
    write({ type: "text-end", id: textPartId });
  } finally {
    await debitCredits(user.id, "aria_chat", modelToUse, 2000, 1200).catch(
      (err) => logger.warn({ err }, "Debit failed — non-fatal"),
    );

    if (fullReply) {
      saveMessage(
        user.id,
        sessionId,
        "assistant",
        fullReply,
        toolsUsed.map((t) => ({ name: t })),
      ).catch((err) =>
        logger.warn({ err }, "Failed to save assistant message"),
      );
    }

    try {
      const followUpSuggestions = await prisma.aria_suggestions.findMany({
        where: { user_id: user.id, status: "pending", session_id: sessionId },
        select: { id: true, suggestion_type: true, suggestion_data: true },
        orderBy: { created_at: "desc" },
        take: 3,
      });
      if (followUpSuggestions.length > 0) {
        write({
          type: "data-suggestions",
          data: followUpSuggestions.map((s) => ({
            id: s.id,
            type: s.suggestion_type,
            content: (s.suggestion_data as any)?.content,
          })),
        });
      }
    } catch (err: any) {
      logger.warn({ err }, "Failed to fetch follow-up suggestions");
    }

    write({ type: "finish-step" });
    write({ type: "finish", finishReason: "stop" });

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
    await deleteSession(user.id, sessionId);
    return noContent(reply);
  } catch (err) {
    logger.error({ err }, "Delete session failed");
    return errors.internal(reply);
  }
};

// ── PATCH /api/v1/agent/sessions/:sessionId ───────────────────────────────────
export const renameSessionHandler = async (
  req: FastifyRequest<{
    Params: { sessionId: string };
    Body: { title: string };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { sessionId } = req.params;
  const { title } = req.body;
  try {
    await renameSession(user.id, sessionId, title);
    return success(reply, { ok: true });
  } catch (err) {
    logger.error({ err }, "Rename session failed");
    return errors.internal(reply);
  }
};

// ── GET /api/v1/agent/memory ───────────────────────────────────────────────────
export const getMemoryHandler = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
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
