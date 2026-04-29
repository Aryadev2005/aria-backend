'use strict'
// aria_memory.service.js
// Reads, writes and injects persistent learnings into ARIA chat sessions.
// Called by aria_chat.controller.js at the start of every session.

const { getDB } = require('../config/database')
const { cache } = require('../config/redis')
const { logger } = require('../utils/logger')

const MEMORY_CACHE_TTL = 300 // 5 minutes

// ── Read all memories for a user ────────────────────────────────────────────
const getMemory = async (userId) => {
  const cacheKey = `aria_memory:${userId}`
  const cached = await cache.get(cacheKey)
  if (cached) return cached

  const sql = getDB()
  const rows = await sql`
    SELECT category, key, value, confidence, source, times_seen
    FROM aria_memory
    WHERE user_id = ${userId}
      AND confidence >= 40
    ORDER BY confidence DESC, times_seen DESC
    LIMIT 30
  `

  const memory = {}
  for (const row of rows) {
    if (!memory[row.category]) memory[row.category] = []
    memory[row.category].push({
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      source: row.source,
    })
  }

  await cache.set(cacheKey, memory, MEMORY_CACHE_TTL)
  return memory
}

// ── Write or reinforce a memory ──────────────────────────────────────────────
const upsertMemory = async (userId, { category, key, value, source = 'inferred' }) => {
  try {
    const sql = getDB()

    await sql`
      INSERT INTO aria_memory (user_id, category, key, value, source, confidence, times_seen, last_seen_at)
      VALUES (
        ${userId}, ${category}, ${key}, ${value}, ${source},
        CASE ${source}
          WHEN 'explicit' THEN 85
          WHEN 'observed' THEN 70
          ELSE 55
        END,
        1, NOW()
      )
      ON CONFLICT (user_id, category, key) DO UPDATE SET
        value        = EXCLUDED.value,
        times_seen   = aria_memory.times_seen + 1,
        confidence   = LEAST(95, aria_memory.confidence + CASE
          WHEN EXCLUDED.value = aria_memory.value THEN 5
          ELSE -10
        END),
        last_seen_at = NOW()
    `

    // Bust cache so next session gets fresh memory
    await cache.del(`aria_memory:${userId}`)
  } catch (err) {
    logger.warn({ err, userId, category, key }, 'Memory upsert failed — non-fatal')
  }
}

// ── Extract and save learnings from a completed ARIA response ────────────────
// Call this after every chat turn. Looks for explicit statements and patterns.
const extractLearningsFromTurn = async (userId, userMessage, ariaResponse) => {
  const lowerMsg = userMessage.toLowerCase()
  const lowerRes = ariaResponse.toLowerCase()

  const extractions = []

  // Hook language preference
  if (lowerMsg.includes('hindi') || lowerRes.includes('hindi hook')) {
    extractions.push({ category: 'hook_language', key: 'preferred_language', value: 'Hindi', source: 'explicit' })
  }
  if (lowerMsg.includes('english hook') || lowerMsg.includes('in english')) {
    extractions.push({ category: 'hook_language', key: 'preferred_language', value: 'English', source: 'explicit' })
  }
  if (lowerMsg.includes('hinglish')) {
    extractions.push({ category: 'hook_language', key: 'preferred_language', value: 'Hinglish', source: 'explicit' })
  }

  // Tone preferences
  if (lowerMsg.includes('more casual') || lowerMsg.includes('too formal')) {
    extractions.push({ category: 'tone', key: 'preferred_tone', value: 'casual', source: 'explicit' })
  }
  if (lowerMsg.includes('more professional') || lowerMsg.includes('too casual')) {
    extractions.push({ category: 'tone', key: 'preferred_tone', value: 'professional', source: 'explicit' })
  }
  if (lowerMsg.includes('funny') || lowerMsg.includes('humorous')) {
    extractions.push({ category: 'tone', key: 'preferred_tone', value: 'humorous', source: 'explicit' })
  }

  // Content format preferences
  if (lowerMsg.includes('i like reels') || lowerMsg.includes('prefer reels')) {
    extractions.push({ category: 'content_format', key: 'preferred_format', value: 'Reel', source: 'explicit' })
  }
  if (lowerMsg.includes('i like carousels') || lowerMsg.includes('prefer carousels')) {
    extractions.push({ category: 'content_format', key: 'preferred_format', value: 'Carousel', source: 'explicit' })
  }

  // Schedule preferences
  const timeMatch = lowerMsg.match(/(\d{1,2}(?::\d{2})?\s?(?:am|pm)\s?(?:ist)?)/i)
  if (timeMatch && (lowerMsg.includes('post') || lowerMsg.includes('schedule'))) {
    extractions.push({ category: 'schedule', key: 'preferred_post_time', value: timeMatch[1].trim(), source: 'explicit' })
  }

  // Brand voice
  if (lowerMsg.includes('no emojis') || lowerMsg.includes('without emojis')) {
    extractions.push({ category: 'brand_voice', key: 'emoji_preference', value: 'none', source: 'explicit' })
  }
  if (lowerMsg.includes('more emojis') || lowerMsg.includes('add emojis')) {
    extractions.push({ category: 'brand_voice', key: 'emoji_preference', value: 'heavy', source: 'explicit' })
  }

  // Save all extracted learnings
  for (const learning of extractions) {
    await upsertMemory(userId, learning)
  }

  return extractions
}

// ── Build the memory injection block for the system prompt ──────────────────
const buildMemoryBlock = (memory) => {
  if (!memory || Object.keys(memory).length === 0) return ''

  const lines = []

  if (memory.hook_language?.length) {
    const lang = memory.hook_language.find(m => m.key === 'preferred_language')
    if (lang) lines.push(`- Always write hooks and captions in ${lang.value}`)
  }

  if (memory.tone?.length) {
    const tone = memory.tone.find(m => m.key === 'preferred_tone')
    if (tone) lines.push(`- Use a ${tone.value} tone in all responses`)
  }

  if (memory.content_format?.length) {
    const fmt = memory.content_format.find(m => m.key === 'preferred_format')
    if (fmt) lines.push(`- User prefers ${fmt.value} format — bias suggestions toward it`)
  }

  if (memory.schedule?.length) {
    const time = memory.schedule.find(m => m.key === 'preferred_post_time')
    if (time) lines.push(`- User's preferred posting time is ${time.value} IST`)
  }

  if (memory.brand_voice?.length) {
    const emoji = memory.brand_voice.find(m => m.key === 'emoji_preference')
    if (emoji) {
      if (emoji.value === 'none') lines.push('- Do NOT use emojis in any output')
      if (emoji.value === 'heavy') lines.push('- Use emojis liberally in captions and hooks')
    }
  }

  if (memory.audience_insight?.length) {
    memory.audience_insight.forEach(m => {
      lines.push(`- ${m.key}: ${m.value}`)
    })
  }

  if (lines.length === 0) return ''

  return `\nPERSONAL LEARNINGS (apply these to every response — user has told you this over time):
${lines.join('\n')}`
}

// ── Save ARIA's own suggestions so we can follow up ─────────────────────────
const storeSuggestion = async (userId, sessionId, suggestionType, suggestionData) => {
  try {
    const sql = getDB()
    const followUpAt = new Date(Date.now() + 48 * 60 * 60 * 1000) // 48 hours

    await sql`
      INSERT INTO aria_suggestions (user_id, session_id, suggestion_type, suggestion_data, follow_up_at)
      VALUES (${userId}, ${sessionId}, ${suggestionType}, ${JSON.stringify(suggestionData)}, ${followUpAt})
    `
  } catch (err) {
    logger.warn({ err }, 'Store suggestion failed — non-fatal')
  }
}

// ── Get pending suggestions for the 48hr follow-up nudge ────────────────────
const getPendingSuggestions = async (userId) => {
  try {
    const sql = getDB()
    return await sql`
      SELECT id, suggestion_type, suggestion_data, created_at
      FROM aria_suggestions
      WHERE user_id = ${userId}
        AND status = 'pending'
        AND follow_up_at <= NOW()
        AND follow_up_sent = FALSE
      ORDER BY created_at DESC
      LIMIT 3
    `
  } catch (err) {
    return []
  }
}

// ── Observe analytics data and auto-write memories ─────────────────────────
// Call this from a weekly BullMQ worker that scans user analytics
const observeFromAnalytics = async (userId, analyticsData) => {
  const observations = []

  if (analyticsData.bestDay) {
    observations.push({
      category: 'schedule',
      key: 'best_posting_day',
      value: analyticsData.bestDay,
      source: 'observed',
    })
  }

  if (analyticsData.bestTime) {
    observations.push({
      category: 'schedule',
      key: 'best_posting_time_observed',
      value: analyticsData.bestTime,
      source: 'observed',
    })
  }

  if (analyticsData.topFormat) {
    observations.push({
      category: 'content_format',
      key: 'best_performing_format',
      value: analyticsData.topFormat,
      source: 'observed',
    })
  }

  if (analyticsData.engagementRate) {
    observations.push({
      category: 'audience_insight',
      key: 'avg_engagement_rate',
      value: `${analyticsData.engagementRate}%`,
      source: 'observed',
    })
  }

  for (const obs of observations) {
    await upsertMemory(userId, obs)
  }
}

module.exports = {
  getMemory,
  upsertMemory,
  extractLearningsFromTurn,
  buildMemoryBlock,
  storeSuggestion,
  getPendingSuggestions,
  observeFromAnalytics,
}
