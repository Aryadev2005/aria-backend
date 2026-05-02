import { FastifyRequest, FastifyReply } from "fastify";
import OpenAI from "openai";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";

import { buildARIASystemPrompt } from "../services/aria_prompt.service";
import { ARIA_TOOLS, dispatchTool } from "../services/aria_tools.service";
import {
  getMemory,
  extractLearningsFromTurn,
  storeSuggestion,
  getPendingSuggestions,
} from "../services/aria_memory.service";

let _openai: OpenAI | null = null;
const groq = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!_openai) _openai = new OpenAI({ apiKey });
  return _openai;
};
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_HISTORY = 20; // rolling window to stay under token budget

/**
 * Save a message to the session
 */
const saveMessage = async ({
  userId,
  sessionId,
  role,
  content,
  toolCalls,
  toolResult,
  entryScreen,
  contextSnapshot,
}: any) => {
  try {
    await prisma.aria_chat_sessions.create({
      data: {
        user_id: userId,
        session_id: sessionId,
        role,
        content,
        tool_calls: toolCalls || null,
        tool_result: toolResult || null,
        entry_screen: entryScreen || null,
        context_snapshot: contextSnapshot || null,
      },
    });
  } catch (err) {
    logger.warn({ err }, "Save message failed — non-fatal");
  }
};

/**
 * Load session history (last N messages)
 */
const loadHistory = async (userId: string, sessionId: string) => {
  const rows = await prisma.aria_chat_sessions.findMany({
    where: {
      user_id: userId,
      session_id: sessionId,
      role: { in: ["user", "assistant"] },
    },
    orderBy: { created_at: "desc" },
    take: MAX_HISTORY,
    select: { role: true, content: true },
  });
  return rows.reverse(); // chronological order
};

/**
 * Detect if ARIA made trackable suggestions
 */
const extractSuggestions = async (
  userId: string,
  sessionId: string,
  ariaResponse: string,
) => {
  const lower = ariaResponse.toLowerCase();

  if (
    lower.includes("post") &&
    (lower.includes("wednesday") ||
      lower.includes("friday") ||
      lower.includes("saturday"))
  ) {
    const dayMatch = ariaResponse.match(
      /(?:post|upload|go live).*?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
    );
    if (dayMatch) {
      await storeSuggestion(userId, sessionId, "posting_time", {
        day: dayMatch[1],
        raw: ariaResponse.slice(0, 200),
      });
    }
  }

  if (lower.includes("hook") && lower.includes('"')) {
    const hookMatch = ariaResponse.match(/"([^"]{10,80})"/g);
    if (hookMatch) {
      await storeSuggestion(userId, sessionId, "hook", {
        hooks: hookMatch.slice(0, 3),
      });
    }
  }

  if (
    lower.includes("carousel") ||
    lower.includes("reel") ||
    lower.includes("short")
  ) {
    const fmtMatch = ariaResponse.match(
      /\b(carousel|reel|short|youtube video|story)\b/i,
    );
    if (fmtMatch) {
      await storeSuggestion(userId, sessionId, "format", {
        format: fmtMatch[1],
      });
    }
  }
};

export interface ChatBody {
  message: string;
  sessionId: string;
  entryScreen?: string;
  context?: any;
  conversationHistory?: any[];
}

/**
 * Main chat handler
 */
export const chat = async (
  req: FastifyRequest<{ Body: ChatBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as any;
  const {
    message,
    sessionId,
    entryScreen = "direct",
    context: sessionContext = {}, // { idea, script, platform, format, trendTitle }
    conversationHistory = [], // optional: client can send history directly
  } = req.body;

  if (!message?.trim()) {
    return errors.validation(reply, "message is required");
  }
  if (!sessionId) {
    return errors.validation(reply, "sessionId is required");
  }

  try {
    // ── 1. Load everything in parallel ──────────────────────────────────────
    const [memory, dbHistory, pendingSuggestions, fullUser] = await Promise.all(
      [
        getMemory(user.id),
        loadHistory(user.id, sessionId),
        getPendingSuggestions(user.id),
        prisma.users.findUnique({
          where: { id: user.id },
          select: {
            id: true,
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
          },
        }),
      ],
    );

    // ── 2. Build the dynamic system prompt ──────────────────────────────────
    const resolvedUser = fullUser || {
      id: user.id,
      archetype: user.archetype || null,
      archetype_label: user.archetype_label || null,
      growth_stage: user.growth_stage || null,
      tone_profile: user.tone_profile || null,
      health_score: user.health_score || null,
      engagement_rate: user.engagement_rate || null,
      follower_range: user.follower_range || null,
      primary_platform: user.primary_platform || null,
      niches: user.niches || [],
      scraped_summary: user.scraped_summary || null,
    };

    const systemPrompt = buildARIASystemPrompt({
      user: resolvedUser as any,
      memory,
      sessionContext,
      entryScreen,
      pendingSuggestions,
    });

    // ── 3. Build message history ─────────────────────────────────────────────
    // Use DB history if available, fall back to client-sent history
    const history =
      dbHistory.length > 0
        ? dbHistory.map((r: any) => ({ role: r.role, content: r.content }))
        : conversationHistory.slice(-MAX_HISTORY);

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    // ── 4. Save user message ─────────────────────────────────────────────────
    await saveMessage({
      userId: user.id,
      sessionId,
      role: "user",
      content: message,
      entryScreen,
      contextSnapshot: sessionContext,
    });

    // ── 5. First LLM call — with tools enabled ───────────────────────────────
    let finalResponse = "";
    let toolsUsed: any[] = [];

    const firstCall = await groq().chat.completions.create({
      model: MODEL,
      max_tokens: 1200,
      messages,
      tools: ARIA_TOOLS as any,
      tool_choice: "auto",
    });

    const firstChoice = firstCall.choices[0];

    // ── 6. Handle tool calls (agentic loop — max 3 tool calls) ───────────────
    if (
      firstChoice.finish_reason === "tool_calls" &&
      firstChoice.message.tool_calls
    ) {
      const toolCallMessages: any[] = [...messages, firstChoice.message];

      for (const toolCall of firstChoice.message.tool_calls as any[]) {
        const toolName = (toolCall as any).function.name;
        const toolArgs = JSON.parse((toolCall as any).function.arguments || "{}");

        const nicheList = Array.isArray(resolvedUser.niches)
          ? resolvedUser.niches
          : [];
        const userContext = {
          niche: nicheList[0] || "general",
          platform: resolvedUser.primary_platform || "instagram",
          archetype: resolvedUser.archetype || undefined,
        };

        const toolResult = await dispatchTool(
          toolName,
          toolArgs,
          user.id,
          userContext,
        );
        toolsUsed.push({ tool: toolName, result: toolResult });

        toolCallMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });
      }

      // Second LLM call with tool results injected
      const secondCall = await groq().chat.completions.create({
        model: MODEL,
        max_tokens: 1200,
        messages: toolCallMessages,
      });

      finalResponse = secondCall.choices[0].message.content || "";
    } else {
      // No tools needed — use direct response
      finalResponse = firstChoice.message.content || "";
    }

    // ── 7. Save ARIA's response ──────────────────────────────────────────────
    await saveMessage({
      userId: user.id,
      sessionId,
      role: "assistant",
      content: finalResponse,
      toolCalls: toolsUsed.length > 0 ? toolsUsed : null,
    });

    // ── 8. Extract learnings and suggestions asynchronously ──────────────────
    // Non-blocking — don't await these, they run in background
    Promise.all([
      extractLearningsFromTurn(user.id, message, finalResponse),
      extractSuggestions(user.id, sessionId, finalResponse),
    ]).catch((err) =>
      logger.warn({ err }, "Background learning extraction failed"),
    );

    // ── 9. Return response ───────────────────────────────────────────────────
    return success(reply, {
      message: finalResponse,
      toolsUsed: toolsUsed.map((t) => t.tool), // tell Flutter which tools fired
      sessionId,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "ARIA chat failed");
    return errors.serviceDown(reply, "ARIA Brain");
  }
};

export interface GreetQuery {
  entryScreen?: string;
  sessionId?: string;
  context?: string;
}

/**
 * Proactive opening message (called when user first opens Brain)
 */
export const greet = async (
  req: FastifyRequest<{ Querystring: GreetQuery }>,
  reply: FastifyReply,
) => {
  const user = req.user as any;
  const { entryScreen = "direct" } = req.query;
  const sessionContext = req.query.context ? JSON.parse(req.query.context) : {};

  try {
    const [memory, pendingSuggestions, fullUser] = await Promise.all([
      getMemory(user.id),
      getPendingSuggestions(user.id),
      prisma.users.findUnique({
        where: { id: user.id },
        select: {
          archetype: true,
          archetype_label: true,
          growth_stage: true,
          health_score: true,
          engagement_rate: true,
          follower_range: true,
          primary_platform: true,
          niches: true,
          name: true,
        },
      }),
    ]);

    const resolvedUser = fullUser || {
      name: user.name,
      archetype: user.archetype || null,
      archetype_label: user.archetype_label || null,
      growth_stage: user.growth_stage || null,
      health_score: user.health_score || null,
      engagement_rate: user.engagement_rate || null,
      follower_range: user.follower_range || null,
      primary_platform: user.primary_platform || null,
      niches: user.niches || [],
    };

    const firstName = (resolvedUser?.name || "yaar").split(" ")[0];
    const hasContext = sessionContext.idea || sessionContext.script;

    const systemPrompt = buildARIASystemPrompt({
      user: resolvedUser as any,
      memory,
      sessionContext,
      entryScreen,
      pendingSuggestions,
    });

    const greetingInstruction = `The user just opened ARIA Brain.
${hasContext ? `They were working on: "${sessionContext.idea || sessionContext.trendTitle || "a piece of content"}"` : ""}
${pendingSuggestions.length > 0 ? `You have ${pendingSuggestions.length} pending follow-up(s) from previous sessions.` : ""}
${entryScreen === "studio" ? "They came from Studio — they are in creation mode." : ""}
${entryScreen === "discover" ? "They came from Discover — they are exploring trends." : ""}
${entryScreen === "launch" ? "They came from Launch — they are about to post." : ""}

Write a SHORT, warm, specific opening message (2-3 sentences max).
- Address them by first name: ${firstName}
- Be specific to their context — do NOT be generic
- End with one clear question or offer to help
- Use Hinglish naturally if it fits
- Do NOT list features, do NOT say "How can I help you today?"`;

    const response = await groq().chat.completions.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: greetingInstruction },
      ],
    });

    return success(reply, {
      greeting: response.choices[0].message.content,
      hasPendingFollowUps: pendingSuggestions.length > 0,
    });
  } catch (err) {
    logger.error({ err }, "Greet failed");
    // Graceful fallback — don't break the UI
    return success(reply, {
      greeting: `Hey! What are we working on today?`,
      hasPendingFollowUps: false,
    });
  }
};
