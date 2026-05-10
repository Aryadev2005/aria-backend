// src/agent/aria_agent.ts
// ARIA autonomous agentic system built on LangGraph JS.
// Uses createReactAgent (ReAct pattern: Reason → Act → Observe → Repeat).
// Checkpointing via PostgresSaver — uses your existing Postgres DB.
// Tools get DB connection injected at runtime so they can query live data.

import { createAgent } from "langchain";
import { ChatOpenAI, tools as openaiTools } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// DB tools are imported inline inside each closure in createDBInjectedTools
// to avoid passing 'db' through schema-validated .invoke() calls.
import { getMcpTools } from "./mcp_tools";
import { hybridTools } from "./tools.hybrid";
import { observeTurn } from "../services/aria_observer.service";

import { buildARIASystemPrompt } from "../services/aria_prompt.service";
import {
  getMemory,
  extractLearningsFromTurn,
  storeSuggestion,
} from "../services/aria_memory.service";
import { logger } from "../utils/logger";
import { prisma } from "../config/database";

// ── PostgresSaver is loaded LAZILY — not at module load time ──────────────────
let PostgresSaver: any = null;
const getPostgresSaver = async () => {
  if (!PostgresSaver) {
    const mod = await import("@langchain/langgraph-checkpoint-postgres");
    PostgresSaver = mod.PostgresSaver;
  }
  return PostgresSaver;
};

// ── LLM setup ─────────────────────────────────────────────────────────────────
const createLLM = (streaming = false) =>
  new ChatOpenAI({
    model: "gpt-5.4-mini",
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
    maxTokens: 2048,
    streaming, // true for streamARIAAgent, false for invokeARIAAgent
  });

// ── Checkpointer setup — lazy, only runs on first chat request ────────────────
let _checkpointer: any = null;
export const getCheckpointer = async () => {
  if (_checkpointer) return _checkpointer;

  try {
    const Saver = await getPostgresSaver();
    _checkpointer = Saver.fromConnString(process.env.DATABASE_URL!);

    // 5s timeout — don't hang if DB is slow
    await Promise.race([
      _checkpointer.setup(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Checkpointer setup timeout")), 5000),
      ),
    ]);

    logger.info("LangGraph checkpointer ready");
    return _checkpointer;
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "LangGraph checkpointer setup failed — will retry on next request",
    );
    _checkpointer = null; // Reset so next request tries again
    return null; // Caller handles null gracefully
  }
};

// ── DB Tool injection ─────────────────────────────────────────────────────────
// 'db' is NOT in the Zod schemas (so the LLM never sees it as a parameter to fill).
// Instead we create fresh closures that capture 'db' from the outer scope.
const createDBInjectedTools = (db: any, user: any) => {
  const getUserProfileWithDB = tool(
    async (_args: {}) => {
      // Import inline to avoid circular dep at module level
      const { getUserProfile } = await import("./tools");
      return (getUserProfile as any).func({ userId: user.id, db });
    },
    {
      name: "get_user_profile",
      description:
        "Get the current user's full creator profile: archetype, niche, followers, engagement rate, health score, and all ARIA memory learnings. ALWAYS call this first for personal questions.",
      schema: z.object({}),
    },
  );

  const getDBTrendsWithDB = tool(
    async ({ niche, badge }: { niche?: string; badge?: string }) => {
      const { getDBLiveTrends } = await import("./tools");
      return (getDBLiveTrends as any).func({ niche, badge, db });
    },
    {
      name: "get_db_live_trends",
      description:
        "Fetch live trending topics from ARIA's database. Fastest source for trend data. Use for content advice and trend-based recommendations.",
      schema: z.object({
        niche: z
          .string()
          .optional()
          .describe('Niche filter e.g. "fashion", "fitness", or "all"'),
        badge: z
          .enum(["HOT", "RISING", "NEW", "ALL"])
          .optional()
          .describe("Velocity filter"),
      }),
    },
  );

  const getDBSongsWithDB = tool(
    async ({ language }: { language?: string }) => {
      const { getDBTrendingSongs } = await import("./tools");
      return (getDBTrendingSongs as any).func({ language, db });
    },
    {
      name: "get_db_trending_songs",
      description:
        "Fetch trending songs from ARIA's live songs database. Use for BGM/audio recommendations.",
      schema: z.object({
        language: z
          .string()
          .optional()
          .describe('Language filter: "Hindi", "English", "Punjabi"'),
      }),
    },
  );

  const getContentHistoryWithDB = tool(
    async ({ limit }: { limit?: number }) => {
      const { getUserContentHistory } = await import("./tools");
      return (getUserContentHistory as any).func({
        userId: user.id,
        limit,
        db,
      });
    },
    {
      name: "get_user_content_history",
      description:
        "Fetch what content the user has created recently. Use to avoid repetitive suggestions.",
      schema: z.object({
        limit: z
          .number()
          .optional()
          .describe("Max records to return, default 10"),
      }),
    },
  );

  const confirmNicheWithDB = tool(
    async (_args: {}) => {
      const { confirmNiche } = await import("./tools");
      return (confirmNiche as any).func({ userId: user.id, db });
    },
    {
      name: "confirm_niche",
      description:
        "Confirm the user's detected niche and archetype when user says yes/correct.",
      schema: z.object({}),
    },
  );

  return [
    getUserProfileWithDB,
    getDBTrendsWithDB,
    getDBSongsWithDB,
    getContentHistoryWithDB,
    confirmNicheWithDB,
  ];
};

// ── Build the ARIA agent ──────────────────────────────────────────────────────
export const buildARIAAgent = async (
  db: any,
  user: any,
  streaming = false,
  entryScreen = "direct",
  sessionContext: Record<string, any> = {},
) => {
  const llm = createLLM(streaming);
  const checkpointer = await getCheckpointer(); // null-safe — may be null if DB slow

  const mcpTools = await getMcpTools();

  // Initialize OpenAI native web search tool
  const webSearchTool = openaiTools.webSearch();

  // Import ALL_ARIA_TOOLS and filter to avoid duplicates
  const { ALL_ARIA_TOOLS } = await import("./tools");

  // Filter ALL_ARIA_TOOLS to remove tools that have DB-injected versions
  // in createDBInjectedTools — avoids duplicate tool names confusing the LLM
  const standaloneTools = ALL_ARIA_TOOLS.filter(
    (t) =>
      ![
        "get_user_profile",
        "get_db_live_trends",
        "get_db_trending_songs",
        "get_user_content_history",
        "confirm_niche",
      ].includes((t as any).name),
  );

  const tools = [
    ...createDBInjectedTools(db, user), // DB-injected versions (have access to prisma)
    ...hybridTools, // 4 RAG tools — get_hybrid_context, find_similar_trends etc.
    ...standaloneTools, // YouTube stats, Spotify, JioSaavn, Google Trends etc.
    ...mcpTools,
    webSearchTool,
  ];

  // Load memory, voice portrait, and pending suggestions in parallel
  const [memoryResult, voicePortraitResult, pendingSuggestionsResult] =
    await Promise.allSettled([
      getMemory(user.id),
      import("../services/voice.service").then((m) =>
        m.getVoicePortrait(user.id),
      ),
      import("../services/suggestion.service").then((m) =>
        m.getDueSuggestions(user.id),
      ),
    ]);

  const resolvedMemory =
    memoryResult.status === "fulfilled" ? memoryResult.value : {};
  const resolvedPortrait =
    voicePortraitResult.status === "fulfilled"
      ? voicePortraitResult.value
      : null;
  const resolvedPendingSuggestions =
    pendingSuggestionsResult.status === "fulfilled"
      ? pendingSuggestionsResult.value
      : [];

  const systemPrompt = buildARIASystemPrompt({
    user,
    memory: resolvedMemory,
    sessionContext,
    entryScreen,
    pendingSuggestions: resolvedPendingSuggestions,
    voicePortrait: resolvedPortrait,
  });

  const agentConfig: any = {
    model: llm,
    tools,
    systemPrompt,
    recursionLimit: 15,
  };

  // Only add checkpointer if it initialized successfully
  if (checkpointer) {
    agentConfig.checkpointer = checkpointer;
  } else {
    logger.warn(
      { userId: user.id },
      "Running without checkpointer — session memory disabled for this request",
    );
  }

  return createAgent(agentConfig);
};

// ── Main invocation ───────────────────────────────────────────────────────────
export const invokeARIAAgent = async ({
  message,
  sessionId,
  user,
  db,
  entryScreen = "brain",
  sessionContext = {},
  onToolCall = null,
}: {
  message: string;
  sessionId: string;
  user: any;
  db: any;
  entryScreen?: string;
  sessionContext?: any;
  onToolCall?: any;
}) => {
  const startTime = Date.now();

  try {
    logger.info({ userId: user.id, sessionId }, "ARIA agent invoked");

    const agent = await buildARIAAgent(
      db,
      user,
      false,
      entryScreen ?? "direct",
      sessionContext ?? {},
    );
    const config = {
      configurable: { thread_id: sessionId },
      recursionLimit: 15,
    };

    const result = await agent.invoke(
      { messages: [new HumanMessage(message)] },
      config,
    );
    const messages = result.messages as any[];
    const finalMsg = messages.findLast(
      (m) => m._getType?.() === "ai" && !m.tool_calls?.length,
    );
    const response =
      finalMsg?.content || "I was unable to generate a response.";

    const toolsUsed = messages
      .filter((m) => m._getType?.() === "tool")
      .map((m) => m.name)
      .filter(Boolean);

    const duration = Date.now() - startTime;
    logger.info(
      { userId: user.id, toolsUsed, duration },
      "ARIA agent completed",
    );

    // Non-blocking post-turn learning
    Promise.all([
      extractLearningsFromTurn(user.id, message, response),
      observeTurn(user.id, message, response, toolsUsed),
      _extractAndStoreSuggestions(user.id, sessionId, response),
    ]).catch((err) => logger.warn({ err }, "Post-turn learning failed"));

    // Fetch suggestions that were just created (or are pending)
    let followUpSuggestions: any[] = [];
    try {
      followUpSuggestions = await prisma.aria_suggestions.findMany({
        where: {
          user_id: user.id,
          status: "pending",
          session_id: sessionId,
        },
        select: {
          id: true,
          suggestion_type: true,
          suggestion_data: true,
        },
        orderBy: { created_at: "desc" },
        take: 3,
      });
    } catch (_) {
      // Non-fatal
    }

    return {
      message: response,
      toolsUsed,
      sessionId,
      duration,
      followUpSuggestions: followUpSuggestions.map((s) => ({
        id: s.id,
        type: s.suggestion_type,
        content: (s.suggestion_data as any)?.content,
      })),
    };
  } catch (err) {
    logger.error(
      { err, userId: user.id, sessionId },
      "ARIA agent failed — falling back",
    );
    return _fallbackResponse(message, user);
  }
};

// ── Streaming version ─────────────────────────────────────────────────────────
export async function* streamARIAAgent({
  message,
  sessionId,
  user,
  db,
  entryScreen,
  sessionContext,
}: {
  message: string;
  sessionId: string;
  user: any;
  db: any;
  entryScreen?: string;
  sessionContext?: Record<string, any>;
}) {
  try {
    // streaming:true so the LLM emits on_chat_model_stream token events
    const agent = await buildARIAAgent(
      db,
      user,
      true,
      entryScreen ?? "direct",
      sessionContext ?? {},
    );
    const config = {
      configurable: { thread_id: sessionId },
      recursionLimit: 15,
    };

    const stream = agent.streamEvents(
      { messages: [new HumanMessage(message)] },
      { ...config, version: "v2" },
    );

    let finalResponse = "";
    let toolsUsedInStream: string[] = [];

    for await (const event of stream) {
      if (event.event === "on_tool_start") {
        toolsUsedInStream.push(event.name);
        yield {
          type: "tool_start" as const,
          tool: event.name,
          input: event.data?.input,
        };
      }
      if (event.event === "on_tool_end") {
        yield {
          type: "tool_end" as const,
          tool: event.name,
          output: event.data?.output,
        };
      }
      if (event.event === "on_chat_model_stream") {
        const token = event.data?.chunk?.content;
        if (token) {
          finalResponse += token;
          yield { type: "token" as const, content: token };
        }
      }
      if (event.event === "on_chain_end" && event.name === "LangGraph") {
        const msgs = (event.data?.output?.messages || []) as any[];
        const final = msgs.findLast(
          (m) => m._getType?.() === "ai" && !m.tool_calls?.length,
        );
        if (final) {
          finalResponse = final.content as string;
          yield { type: "done" as const, message: finalResponse };

          // Non-blocking post-turn learning for streaming too
          Promise.all([
            extractLearningsFromTurn(user.id, message, finalResponse),
            observeTurn(user.id, message, finalResponse, toolsUsedInStream),
            _extractAndStoreSuggestions(user.id, sessionId, finalResponse),
          ]).catch((err) => logger.warn({ err }, "Post-turn learning failed"));
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "ARIA agent stream failed");
    yield {
      type: "error" as const,
      message: "ARIA encountered an error. Please try again.",
    };
  }
}

// ── Fallback: plain Groq call if agent fails ──────────────────────────────────
const _fallbackResponse = async (message: string, user: any) => {
  try {
    const llm = new ChatOpenAI({
      model: "gpt-5.4-mini",
      apiKey: process.env.OPENAI_API_KEY,
    });
    const res = await llm.invoke([
      new SystemMessage(
        `You are ARIA, India's AI creator assistant. Help ${user.archetype || "this creator"} with their question.`,
      ),
      new HumanMessage(message),
    ]);
    return {
      message: res.content as string,
      toolsUsed: [],
      sessionId: null,
      fallback: true,
    };
  } catch {
    return {
      message: "ARIA is currently unavailable. Please try again in a moment.",
      toolsUsed: [],
      fallback: true,
    };
  }
};

// ── Helper to call Groq ──────────────────────────────────────────────────────
const _callGroq = async (prompt: string, opts?: any) => {
  const { _callGroq: groqCall } = await import("../services/ai/groq.service");
  return groqCall(prompt, opts);
};

// ── Extract suggestions from response ────────────────────────────────────────
const _extractAndStoreSuggestions = async (
  userId: string,
  sessionId: string,
  response: string,
): Promise<void> => {
  try {
    // Only run if response is long enough to contain suggestions
    if (response.length < 100) return;

    // Use Groq to extract actionable suggestions from the response
    const extractionPrompt = `You are ARIA's suggestion tracker. Read this ARIA response and extract any concrete, actionable suggestions ARIA made to the creator.

ARIA SAID: "${response.substring(0, 1500)}"

Extract suggestions that the creator could actually follow up on — things like:
- "Post on Wednesday at 7pm"
- "Try this hook format"
- "Make a video about [topic]"
- "Post 4 times this week"
- "Use this hashtag strategy"
- "Collab with a creator in [niche]"

Do NOT extract vague advice like "be consistent" or "engage with your audience".
Only extract specific, actionable suggestions with a clear completion state.
If no specific actionable suggestions exist, return empty array.

Respond ONLY with valid JSON:
{
  "suggestions": [
    {
      "type": "posting_time | hook_format | topic_idea | posting_frequency | hashtag_strategy | collab | format_change | other",
      "content": "The exact suggestion made",
      "followUpDays": 3
    }
  ]
}`;

    const result = await _callGroq(extractionPrompt, {
      maxTokens: 400,
      useLlama: false,
    });

    if (!result?.suggestions?.length) return;

    for (const suggestion of result.suggestions) {
      if (!suggestion.content || !suggestion.type) continue;

      const followUpAt = new Date();
      followUpAt.setDate(followUpAt.getDate() + (suggestion.followUpDays || 3));

      await prisma.aria_suggestions
        .create({
          data: {
            user_id: userId,
            session_id: sessionId,
            suggestion_type: suggestion.type,
            suggestion_data: {
              content: suggestion.content,
              extractedAt: new Date(),
            },
            status: "pending",
            follow_up_at: followUpAt,
            follow_up_sent: false,
          },
        })
        .catch(() => {}); // Non-fatal
    }
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId },
      "Suggestion extraction failed — non-fatal",
    );
  }
};
