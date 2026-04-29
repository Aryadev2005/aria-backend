'use strict'
// src/agent/aria_agent.js
// ARIA autonomous agentic system built on LangGraph JS.
// Uses createReactAgent (ReAct pattern: Reason → Act → Observe → Repeat).
// Checkpointing via PostgresSaver — uses your existing Postgres DB.
// Tools get DB connection injected at runtime so they can query live data.

const { createReactAgent } = require('@langchain/langgraph/prebuilt')
const { ChatGroq } = require('@langchain/groq')
const { PostgresSaver } = require('@langchain/langgraph-checkpoint-postgres')
const { HumanMessage, SystemMessage } = require('@langchain/core/messages')
const { tool } = require('@langchain/core/tools')
const { z } = require('zod')

const {
  getYouTubeVideoStats,
  getYouTubeChannelStats,
  searchYouTube,
  getSpotifyTrending,
  getJioSaavnTrending,
  getGoogleTrends,
  getInstagramPersonalStats,
  getUserProfile,
  getDBLiveTrends,
  getDBTrendingSongs,
  getUserContentHistory,
  analyseYouTubeVideoQuick,
} = require('./tools')

const { buildARIASystemPrompt } = require('../services/aria_prompt.service')
const { getMemory, extractLearningsFromTurn, storeSuggestion } = require('../services/aria_memory.service')
const { logger } = require('../utils/logger')

// ── LLM setup ─────────────────────────────────────────────────────────────────
// Using ChatGroq — same API key you already have.
// For deeper analysis, swap to ChatAnthropic with claude-sonnet-4-6.
const createLLM = () => new ChatGroq({
  model: 'llama-3.3-70b-versatile',
  apiKey: process.env.GROQ_API_KEY,
  temperature: 0,          // deterministic for agent tool-calling
  maxTokens: 2048,
  streaming: false,
})

// ── Checkpointer setup ────────────────────────────────────────────────────────
// PostgresSaver uses your existing DATABASE_URL — creates its own checkpoints table.
let _checkpointer = null
const getCheckpointer = async () => {
  if (_checkpointer) return _checkpointer
  _checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL)
  await _checkpointer.setup()  // Creates checkpoints table if not exists
  return _checkpointer
}

// ── DB Tool injection ─────────────────────────────────────────────────────────
// LangGraph tools can't access server state directly, so we create
// DB-injected versions of tools that need database access.
const createDBInjectedTools = (db, user) => {
  // Wrap DB tools with the actual db connection baked in
  const getUserProfileWithDB = tool(
    async () => {
      return getUserProfile.invoke({ userId: user.id, db })
    },
    {
      name: 'get_user_profile',
      description: 'Get the current user\'s full creator profile: archetype, niche, followers, engagement rate, health score, and all ARIA memory learnings. ALWAYS call this first for personal questions.',
      schema: z.object({}),
    }
  )

  const getDBTrendsWithDB = tool(
    async ({ niche, badge }) => {
      return getDBLiveTrends.invoke({ niche, badge, db })
    },
    {
      name: 'get_db_live_trends',
      description: 'Fetch live trending topics from ARIA\'s database. Fastest source for trend data. Use for content advice and trend-based recommendations.',
      schema: z.object({
        niche: z.string().optional(),
        badge: z.enum(['HOT', 'RISING', 'NEW', 'ALL']).optional(),
      }),
    }
  )

  const getDBSongsWithDB = tool(
    async ({ language }) => {
      return getDBTrendingSongs.invoke({ language, db })
    },
    {
      name: 'get_db_trending_songs',
      description: 'Fetch trending songs from ARIA\'s live songs database. Use for BGM/audio recommendations.',
      schema: z.object({
        language: z.string().optional(),
      }),
    }
  )

  const getContentHistoryWithDB = tool(
    async ({ limit }) => {
      return getUserContentHistory.invoke({ userId: user.id, limit, db })
    },
    {
      name: 'get_user_content_history',
      description: 'Fetch what content the user has created recently. Use to avoid repetitive suggestions.',
      schema: z.object({
        limit: z.number().optional(),
      }),
    }
  )

  const getInstagramWithToken = tool(
    async ({ metric }) => {
      return getInstagramPersonalStats.invoke({
        userId:      user.instagram_user_id,
        accessToken: user.instagram_access_token,
        metric,
      })
    },
    {
      name: 'get_instagram_personal_stats',
      description: 'Fetch user\'s own Instagram post performance and account insights. Only works if Instagram Business account is connected.',
      schema: z.object({
        metric: z.enum(['posts', 'insights']).optional(),
      }),
    }
  )

  return [
    getUserProfileWithDB,
    getDBTrendsWithDB,
    getDBSongsWithDB,
    getContentHistoryWithDB,
    getInstagramWithToken,
  ]
}

// ── Build the ARIA agent ──────────────────────────────────────────────────────
const buildARIAAgent = async (db, user) => {
  const llm         = createLLM()
  const checkpointer = await getCheckpointer()

  // Combine: DB-injected tools + pure API tools (no DB needed)
  const tools = [
    ...createDBInjectedTools(db, user),
    getYouTubeVideoStats,
    getYouTubeChannelStats,
    searchYouTube,
    getSpotifyTrending,
    getJioSaavnTrending,
    getGoogleTrends,
    analyseYouTubeVideoQuick,
  ]

  // Load user memory for system prompt
  const memory = await getMemory(user.id).catch(() => ({}))

  // Build dynamic system prompt (same function from your existing aria_prompt.service.js)
  const systemPrompt = buildARIASystemPrompt({
    user,
    memory,
    sessionContext: {},
    entryScreen:    'brain',
    pendingSuggestions: [],
  })

  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: checkpointer,
    // Inject system prompt as state modifier
    stateModifier: (state) => {
      const hasSystem = state.messages.some(m => m._getType?.() === 'system')
      if (hasSystem) return state.messages
      return [new SystemMessage(systemPrompt), ...state.messages]
    },
    // Safety: prevent runaway tool loops
    recursionLimit: 15,
  })

  return agent
}

// ── Main invocation function (called by controller) ───────────────────────────
const invokeARIAAgent = async ({
  message,
  sessionId,
  user,
  db,
  entryScreen = 'brain',
  sessionContext = {},
  onToolCall = null,    // optional callback for streaming tool use events
}) => {
  const startTime = Date.now()

  try {
    logger.info({ userId: user.id, sessionId }, 'ARIA agent invoked')

    const agent = await buildARIAAgent(db, user)

    // Thread ID = sessionId → PostgresSaver checkpoints per session automatically
    const config = {
      configurable: { thread_id: sessionId },
      recursionLimit: 15,
    }

    const result = await agent.invoke(
      { messages: [new HumanMessage(message)] },
      config
    )

    // Extract the final AI message
    const messages = result.messages
    const finalMsg = messages.findLast(m => m._getType?.() === 'ai' && !m.tool_calls?.length)
    const response = finalMsg?.content || 'I was unable to generate a response.'

    // Which tools did the agent call?
    const toolsUsed = messages
      .filter(m => m._getType?.() === 'tool')
      .map(m => m.name)
      .filter(Boolean)

    const duration = Date.now() - startTime
    logger.info({ userId: user.id, toolsUsed, duration }, 'ARIA agent completed')

    // Extract learnings + suggestions asynchronously (non-blocking)
    Promise.all([
      extractLearningsFromTurn(user.id, message, response),
      _extractAndStoreSuggestions(user.id, sessionId, response),
    ]).catch(err => logger.warn({ err }, 'Post-turn learning extraction failed'))

    return {
      message: response,
      toolsUsed,
      sessionId,
      duration,
    }

  } catch (err) {
    logger.error({ err, userId: user.id, sessionId }, 'ARIA agent failed')

    // Graceful degradation — fall back to simple Groq call without tools
    return _fallbackResponse(message, user)
  }
}

// ── Streaming version (token by token + tool events) ─────────────────────────
async function* streamARIAAgent({ message, sessionId, user, db }) {
  try {
    const agent = await buildARIAAgent(db, user)
    const config = { configurable: { thread_id: sessionId }, recursionLimit: 15 }

    const stream = agent.streamEvents(
      { messages: [new HumanMessage(message)] },
      { ...config, version: 'v2' }
    )

    for await (const event of stream) {
      // Tool call started
      if (event.event === 'on_tool_start') {
        yield { type: 'tool_start', tool: event.name, input: event.data?.input }
      }
      // Tool call finished
      if (event.event === 'on_tool_end') {
        yield { type: 'tool_end', tool: event.name }
      }
      // Token streamed
      if (event.event === 'on_chat_model_stream') {
        const token = event.data?.chunk?.content
        if (token) yield { type: 'token', content: token }
      }
      // Final message complete
      if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
        const msgs = event.data?.output?.messages || []
        const final = msgs.findLast(m => m._getType?.() === 'ai' && !m.tool_calls?.length)
        if (final) {
          yield { type: 'done', message: final.content }
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'ARIA agent stream failed')
    yield { type: 'error', message: 'ARIA encountered an error. Please try again.' }
  }
}

// ── Fallback: plain Groq call if agent fails ──────────────────────────────────
const _fallbackResponse = async (message, user) => {
  try {
    const llm = new ChatGroq({ model: 'llama-3.3-70b-versatile', apiKey: process.env.GROQ_API_KEY })
    const res = await llm.invoke([
      new SystemMessage(`You are ARIA, India's AI creator assistant. Help ${user.archetype || 'this creator'} with their question.`),
      new HumanMessage(message),
    ])
    return { message: res.content, toolsUsed: [], sessionId: null, fallback: true }
  } catch {
    return { message: 'ARIA is currently unavailable. Please try again in a moment.', toolsUsed: [], fallback: true }
  }
}

// ── Extract suggestions from response ────────────────────────────────────────
const _extractAndStoreSuggestions = async (userId, sessionId, response) => {
  const lower = response.toLowerCase()
  if (lower.includes('post') && /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lower)) {
    const day = response.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i)?.[1]
    if (day) await storeSuggestion(userId, sessionId, 'posting_time', { day }).catch(() => {})
  }
}

module.exports = {
  invokeARIAAgent,
  streamARIAAgent,
  buildARIAAgent,
  getCheckpointer,
}
