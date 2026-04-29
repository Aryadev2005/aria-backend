'use strict'
// aria_chat.controller.js
// The main brain of ARIA chat. Orchestrates:
//   1. Context continuity (idea/script/platform from Flutter)
//   2. Tool use (LLM calls real endpoints autonomously)
//   3. Archetype awareness (dynamic system prompt)
//   4. Persistent memory (learnings injected + extracted)
//   5. Proactive intelligence (opening message, follow-ups)
//
// Route: POST /api/v1/brain/chat
// Register in app.js: app.register(brainRoutes, { prefix: `${API_PREFIX}/brain` })

const Groq = require('groq-sdk')
const { getDB } = require('../config/database')
const { success, errors } = require('../utils/response')
const { logger } = require('../utils/logger')

const { buildARIASystemPrompt } = require('../services/aria_prompt.service')
const { ARIA_TOOLS, dispatchTool } = require('../services/aria_tools.service')
const {
  getMemory,
  extractLearningsFromTurn,
  storeSuggestion,
  getPendingSuggestions,
} = require('../services/aria_memory.service')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const MODEL = 'llama-3.3-70b-versatile'
const MAX_HISTORY = 20  // rolling window to stay under token budget

// ── Save a message to the session ────────────────────────────────────────────
const saveMessage = async (sql, { userId, sessionId, role, content, toolCalls, toolResult, entryScreen, contextSnapshot }) => {
  try {
    await sql`
      INSERT INTO aria_chat_sessions
        (user_id, session_id, role, content, tool_calls, tool_result, entry_screen, context_snapshot)
      VALUES (
        ${userId}, ${sessionId}, ${role}, ${content},
        ${toolCalls ? JSON.stringify(toolCalls) : null},
        ${toolResult ? JSON.stringify(toolResult) : null},
        ${entryScreen || null},
        ${contextSnapshot ? JSON.stringify(contextSnapshot) : null}
      )
    `
  } catch (err) {
    logger.warn({ err }, 'Save message failed — non-fatal')
  }
}

// ── Load session history (last N messages) ───────────────────────────────────
const loadHistory = async (sql, userId, sessionId) => {
  const rows = await sql`
    SELECT role, content
    FROM aria_chat_sessions
    WHERE user_id = ${userId}
      AND session_id = ${sessionId}
      AND role IN ('user', 'assistant')
    ORDER BY created_at DESC
    LIMIT ${MAX_HISTORY}
  `
  return rows.reverse() // chronological order
}

// ── Detect if ARIA made trackable suggestions ─────────────────────────────────
const extractSuggestions = async (userId, sessionId, ariaResponse) => {
  const lower = ariaResponse.toLowerCase()

  if (lower.includes('post') && (lower.includes('wednesday') || lower.includes('friday') || lower.includes('saturday'))) {
    const dayMatch = ariaResponse.match(/(?:post|upload|go live).*?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i)
    if (dayMatch) {
      await storeSuggestion(userId, sessionId, 'posting_time', { day: dayMatch[1], raw: ariaResponse.slice(0, 200) })
    }
  }

  if (lower.includes('hook') && lower.includes('"')) {
    const hookMatch = ariaResponse.match(/"([^"]{10,80})"/g)
    if (hookMatch) {
      await storeSuggestion(userId, sessionId, 'hook', { hooks: hookMatch.slice(0, 3) })
    }
  }

  if (lower.includes('carousel') || lower.includes('reel') || lower.includes('short')) {
    const fmtMatch = ariaResponse.match(/\b(carousel|reel|short|youtube video|story)\b/i)
    if (fmtMatch) {
      await storeSuggestion(userId, sessionId, 'format', { format: fmtMatch[1] })
    }
  }
}

// ── Main chat handler ────────────────────────────────────────────────────────
const chat = async (req, reply) => {
  const user = req.user
  const {
    message,
    sessionId,
    entryScreen = 'direct',
    context: sessionContext = {}, // { idea, script, platform, format, trendTitle }
    conversationHistory = [],     // optional: client can send history directly
  } = req.body

  if (!message?.trim()) {
    return errors.validation(reply, 'message is required')
  }
  if (!sessionId) {
    return errors.validation(reply, 'sessionId is required')
  }

  const sql = getDB()

  try {
    // ── 1. Load everything in parallel ──────────────────────────────────────
    const [memory, dbHistory, pendingSuggestions, fullUser] = await Promise.all([
      getMemory(user.id),
      loadHistory(sql, user.id, sessionId),
      getPendingSuggestions(user.id),
      sql`
        SELECT id, archetype, archetype_label, growth_stage, tone_profile,
               health_score, engagement_rate, follower_range, primary_platform,
               niches, scraped_summary
        FROM users WHERE id = ${user.id}
      `.then(r => r[0]),
    ])

    // ── 2. Build the dynamic system prompt ──────────────────────────────────
    const systemPrompt = buildARIASystemPrompt({
      user: fullUser,
      memory,
      sessionContext,
      entryScreen,
      pendingSuggestions,
    })

    // ── 3. Build message history ─────────────────────────────────────────────
    // Use DB history if available, fall back to client-sent history
    const history = dbHistory.length > 0
      ? dbHistory.map(r => ({ role: r.role, content: r.content }))
      : conversationHistory.slice(-MAX_HISTORY)

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ]

    // ── 4. Save user message ─────────────────────────────────────────────────
    await saveMessage(sql, {
      userId: user.id,
      sessionId,
      role: 'user',
      content: message,
      entryScreen,
      contextSnapshot: sessionContext,
    })

    // ── 5. First LLM call — with tools enabled ───────────────────────────────
    let finalResponse = ''
    let toolsUsed = []

    const firstCall = await groq.chat.completions.create({
      model: MODEL,
      max_tokens: 1200,
      messages,
      tools: ARIA_TOOLS,
      tool_choice: 'auto',
    })

    const firstChoice = firstCall.choices[0]

    // ── 6. Handle tool calls (agentic loop — max 3 tool calls) ───────────────
    if (firstChoice.finish_reason === 'tool_calls' && firstChoice.message.tool_calls) {
      const toolCallMessages = [...messages, firstChoice.message]

      for (const toolCall of firstChoice.message.tool_calls) {
        const toolName = toolCall.function.name
        const toolArgs = JSON.parse(toolCall.function.arguments || '{}')

        const userContext = {
          niche: fullUser?.niches?.[0] || 'general',
          platform: fullUser?.primary_platform || 'instagram',
          archetype: fullUser?.archetype,
        }

        const toolResult = await dispatchTool(toolName, toolArgs, user.id, userContext)
        toolsUsed.push({ tool: toolName, result: toolResult })

        toolCallMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        })
      }

      // Second LLM call with tool results injected
      const secondCall = await groq.chat.completions.create({
        model: MODEL,
        max_tokens: 1200,
        messages: toolCallMessages,
      })

      finalResponse = secondCall.choices[0].message.content

    } else {
      // No tools needed — use direct response
      finalResponse = firstChoice.message.content
    }

    // ── 7. Save ARIA's response ──────────────────────────────────────────────
    await saveMessage(sql, {
      userId: user.id,
      sessionId,
      role: 'assistant',
      content: finalResponse,
      toolCalls: toolsUsed.length > 0 ? toolsUsed : null,
    })

    // ── 8. Extract learnings and suggestions asynchronously ──────────────────
    // Non-blocking — don't await these, they run in background
    Promise.all([
      extractLearningsFromTurn(user.id, message, finalResponse),
      extractSuggestions(user.id, sessionId, finalResponse),
    ]).catch(err => logger.warn({ err }, 'Background learning extraction failed'))

    // ── 9. Return response ───────────────────────────────────────────────────
    return success(reply, {
      message: finalResponse,
      toolsUsed: toolsUsed.map(t => t.tool), // tell Flutter which tools fired
      sessionId,
    })

  } catch (err) {
    logger.error({ err, userId: user.id }, 'ARIA chat failed')
    return errors.serviceDown(reply, 'ARIA Brain')
  }
}

// ── Proactive opening message (called when user first opens Brain) ───────────
// GET /api/v1/brain/greet?entryScreen=studio&context={...}
const greet = async (req, reply) => {
  const user = req.user
  const { entryScreen = 'direct', sessionId } = req.query
  const sessionContext = req.query.context ? JSON.parse(req.query.context) : {}

  try {
    const sql = getDB()

    const [memory, pendingSuggestions, fullUser] = await Promise.all([
      getMemory(user.id),
      getPendingSuggestions(user.id),
      sql`
        SELECT archetype, archetype_label, growth_stage, health_score,
               engagement_rate, follower_range, primary_platform, niches, name
        FROM users WHERE id = ${user.id}
      `.then(r => r[0]),
    ])

    const firstName = (fullUser?.name || 'yaar').split(' ')[0]
    const hasContext = sessionContext.idea || sessionContext.script

    const systemPrompt = buildARIASystemPrompt({
      user: fullUser,
      memory,
      sessionContext,
      entryScreen,
      pendingSuggestions,
    })

    const greetingInstruction = `The user just opened ARIA Brain.
${hasContext ? `They were working on: "${sessionContext.idea || sessionContext.trendTitle || 'a piece of content'}"` : ''}
${pendingSuggestions.length > 0 ? `You have ${pendingSuggestions.length} pending follow-up(s) from previous sessions.` : ''}
${entryScreen === 'studio' ? 'They came from Studio — they are in creation mode.' : ''}
${entryScreen === 'discover' ? 'They came from Discover — they are exploring trends.' : ''}
${entryScreen === 'launch' ? 'They came from Launch — they are about to post.' : ''}

Write a SHORT, warm, specific opening message (2-3 sentences max).
- Address them by first name: ${firstName}
- Be specific to their context — do NOT be generic
- End with one clear question or offer to help
- Use Hinglish naturally if it fits
- Do NOT list features, do NOT say "How can I help you today?"`

    const response = await groq.chat.completions.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: greetingInstruction },
      ],
    })

    return success(reply, {
      greeting: response.choices[0].message.content,
      hasPendingFollowUps: pendingSuggestions.length > 0,
    })

  } catch (err) {
    logger.error({ err }, 'Greet failed')
    // Graceful fallback — don't break the UI
    return success(reply, {
      greeting: `Hey! What are we working on today?`,
      hasPendingFollowUps: false,
    })
  }
}

module.exports = { chat, greet }
