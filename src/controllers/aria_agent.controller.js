'use strict'
// src/controllers/aria_agent.controller.js
// Replaces aria_chat.controller.js — same routes, same Flutter API contract.
// Internally uses LangGraph ReAct agent instead of single Groq call.
// Drop-in replacement — Flutter sees no difference in the response format.

const { invokeARIAAgent, streamARIAAgent } = require('../agent/aria_agent')
const { getDB }           = require('../config/database')
const { success, errors } = require('../utils/response')
const { logger }          = require('../utils/logger')
const { getMemory, getPendingSuggestions } = require('../services/aria_memory.service')

// ── POST /api/v1/brain/chat ──────────────────────────────────────────────────
// Exact same request/response shape as the old aria_chat.controller.js
const chat = async (req, reply) => {
  const user = req.user
  const {
    message,
    sessionId,
    entryScreen  = 'direct',
    context: sessionContext = {},
  } = req.body

  if (!message?.trim())  return errors.validation(reply, 'message is required')
  if (!sessionId)        return errors.validation(reply, 'sessionId is required')

  const db = getDB()

  try {
    // Fetch full user for agent context (archetype, memory, platform, etc.)
    const [fullUser] = await db`
      SELECT
        u.id, u.name, u.archetype, u.archetype_label, u.growth_stage,
        u.tone_profile, u.health_score, u.engagement_rate, u.follower_range,
        u.primary_platform, u.niches, u.scraped_summary,
        u.instagram_handle, u.youtube_handle,
        u.instagram_access_token, u.instagram_user_id
      FROM users u
      WHERE u.id = ${user.id}
    `

    const result = await invokeARIAAgent({
      message,
      sessionId,
      user:           fullUser,
      db,
      entryScreen,
      sessionContext,
    })

    return success(reply, result)

  } catch (err) {
    logger.error({ err, userId: user.id }, 'Agent chat controller failed')
    return errors.serviceDown(reply, 'ARIA Brain')
  }
}

// ── GET /api/v1/brain/greet ──────────────────────────────────────────────────
const greet = async (req, reply) => {
  const user = req.user
  const { entryScreen = 'direct', sessionId } = req.query
  const sessionContext = req.query.context ? JSON.parse(req.query.context) : {}

  try {
    const db = getDB()
    const [fullUser] = await db`
      SELECT name, archetype, archetype_label, health_score, niches,
             primary_platform, follower_range
      FROM users WHERE id = ${user.id}
    `

    const [memory, pendingSuggestions] = await Promise.all([
      getMemory(user.id),
      getPendingSuggestions(user.id),
    ])

    const firstName = (fullUser?.name || 'yaar').split(' ')[0]
    const hasContext = sessionContext.idea || sessionContext.script

    // Build a targeted greeting prompt for the agent
    const greetMessage = [
      `Generate a SHORT warm greeting (2-3 sentences max) for ${firstName}.`,
      entryScreen !== 'direct' ? `They just came from the ${entryScreen} screen.` : '',
      hasContext ? `They were working on: "${sessionContext.idea || sessionContext.trendTitle}"` : '',
      pendingSuggestions.length > 0 ? `You have ${pendingSuggestions.length} pending follow-up to close.` : '',
      `End with one specific question or offer to help. Use Hinglish naturally. DO NOT say "How can I help you today?".`,
    ].filter(Boolean).join(' ')

    // Use a lightweight single-turn call for the greeting (no tools needed)
    const { ChatGroq } = require('@langchain/groq')
    const llm = new ChatGroq({
      model: 'llama-3.3-70b-versatile',
      apiKey: process.env.GROQ_API_KEY,
      maxTokens: 120,
    })

    const { content } = await llm.invoke([
      { role: 'system', content: `You are ARIA, India's AI creator assistant. Archetype: ${fullUser?.archetype}. Niche: ${fullUser?.niches?.[0]}.` },
      { role: 'user', content: greetMessage },
    ])

    return success(reply, {
      greeting: content,
      hasPendingFollowUps: pendingSuggestions.length > 0,
    })

  } catch (err) {
    logger.error({ err }, 'Greet failed')
    return success(reply, { greeting: 'Hey! What are we working on today?', hasPendingFollowUps: false })
  }
}

// ── POST /api/v1/brain/chat/stream  (SSE streaming version) ──────────────────
// Optional — use if you want real-time token streaming to Flutter
// Flutter would use EventSource or dio streaming to consume SSE events
const chatStream = async (req, reply) => {
  const user = req.user
  const { message, sessionId, entryScreen = 'direct' } = req.body

  if (!message?.trim() || !sessionId) {
    return errors.validation(reply, 'message and sessionId required')
  }

  const db = getDB()
  const [fullUser] = await db`
    SELECT id, archetype, niches, primary_platform, follower_range,
           engagement_rate, health_score, instagram_access_token, instagram_user_id
    FROM users WHERE id = ${user.id}
  `

  // Set SSE headers
  reply.raw.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',  // disable nginx buffering
  })

  try {
    for await (const event of streamARIAAgent({ message, sessionId, user: fullUser, db })) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)

      if (event.type === 'done' || event.type === 'error') {
        reply.raw.end()
        return
      }
    }
  } catch (err) {
    reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream failed' })}\n\n`)
    reply.raw.end()
  }
}

module.exports = {
  chat,
  greet,
  chatStream
}