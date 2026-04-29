'use strict'
// aria_tools.service.js
// Defines the tools ARIA can call autonomously during chat.
// Dispatches tool calls to real backend services — not training data.
// Plugs into Groq's tool_choice / tools[] parameter.

const { getDB } = require('../config/database')
const { cache } = require('../config/redis')
const { logger } = require('../utils/logger')
const Groq = require('groq-sdk')

// ── Tool definitions (passed to Groq as tools: []) ──────────────────────────
const ARIA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_live_trends',
      description: 'Get real-time trending topics for a niche and platform from live data. Call this whenever the user asks what is trending, what to post, or what is working right now. Do NOT use training data for trend questions.',
      parameters: {
        type: 'object',
        properties: {
          niche: {
            type: 'string',
            description: 'Creator niche e.g. fashion, fitness, finance, food, travel',
          },
          platform: {
            type: 'string',
            enum: ['instagram', 'youtube', 'both'],
            description: 'Target platform',
          },
          badge: {
            type: 'string',
            enum: ['HOT', 'RISING', 'ALL'],
            description: 'Filter by trend velocity',
          },
        },
        required: ['niche'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'match_bgm',
      description: 'Find trending background music / audio that matches the creator niche and content type. Call when user asks about audio, music, sounds, or BGM for their content.',
      parameters: {
        type: 'object',
        properties: {
          niche: { type: 'string', description: 'Creator niche' },
          mood:  { type: 'string', description: 'Content mood e.g. energetic, emotional, funny, aesthetic' },
          platform: { type: 'string', enum: ['instagram', 'youtube', 'both'] },
        },
        required: ['niche'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_best_posting_time',
      description: 'Get the optimal posting time for this specific creator based on their analytics and audience. Call when user asks when to post.',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['instagram', 'youtube'] },
          content_type: { type: 'string', description: 'e.g. Reel, Carousel, Short, Video' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_creator_analytics',
      description: 'Fetch the creator\'s real performance metrics — followers, engagement, top posts. Call when user asks how they are performing, what their stats are, or when discussing growth.',
      parameters: {
        type: 'object',
        properties: {
          metric: {
            type: 'string',
            enum: ['overview', 'top_posts', 'growth', 'engagement'],
            description: 'Which metric to fetch',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_hook_variations',
      description: 'Generate 3 hook variations for a specific piece of content, tailored to the creator\'s archetype. Call when user asks for hook ideas or wants to improve an opening line.',
      parameters: {
        type: 'object',
        properties: {
          topic:    { type: 'string', description: 'The content topic or idea' },
          platform: { type: 'string', description: 'Target platform' },
          format:   { type: 'string', description: 'Content format e.g. Reel, Carousel' },
        },
        required: ['topic'],
      },
    },
  },
]

// ── Tool dispatcher — maps LLM tool calls to real services ──────────────────
const dispatchTool = async (toolName, toolArgs, userId, userContext) => {
  logger.info({ toolName, toolArgs, userId }, 'ARIA tool called')

  try {
    switch (toolName) {

      case 'get_live_trends': {
        const sql = getDB()
        const cacheKey = `live_trends:${toolArgs.niche}:${toolArgs.platform || 'all'}`
        const cached = await cache.get(cacheKey)
        if (cached) return { source: 'live_db', data: cached }

        // Pull from live_trends table (fed by BullMQ trend worker)
        const niche = toolArgs.niche || userContext?.niche || 'general'
        const badge = toolArgs.badge || 'ALL'

        const trends = await sql`
          SELECT title, search_volume, velocity, badge, recommendation, expires_at
          FROM live_trends
          WHERE expires_at > NOW()
            AND (
              niche_tags @> ARRAY[${niche}]::text[]
              OR niche_tags = '{}'
            )
            ${badge !== 'ALL' ? sql`AND badge = ${badge}` : sql``}
          ORDER BY velocity DESC NULLS LAST, search_volume DESC NULLS LAST
          LIMIT 5
        `

        if (trends.length === 0) {
          // Fallback to groq-generated trends if DB is empty
          return {
            source: 'ai_generated',
            note: 'Live trend DB empty — using AI estimates. Run trend worker to populate.',
            data: [
              { title: `${niche} content gap`, velocity: 80, recommendation: 'Post original takes on this niche' },
            ],
          }
        }

        await cache.set(cacheKey, trends, 600) // 10 min cache
        return { source: 'live_db', data: trends }
      }

      case 'match_bgm': {
        const sql = getDB()
        const niche = toolArgs.niche || userContext?.niche || 'general'
        const platform = toolArgs.platform || userContext?.platform || 'instagram'

        const songs = await sql`
          SELECT title, artist, chart_position, language, streams_today
          FROM live_songs
          WHERE fetched_at > NOW() - INTERVAL '24 hours'
          ORDER BY
            CASE WHEN language = 'Hindi' THEN 0
                 WHEN language = 'English' THEN 1
                 ELSE 2 END,
            chart_position ASC NULLS LAST
          LIMIT 5
        `

        if (songs.length === 0) {
          return {
            source: 'fallback',
            note: 'Song worker not populated yet. Run song.worker.js.',
            data: [
              { title: 'Phir Aur Kya Chahiye', artist: 'Arijit Singh', recommendation: 'Trending for lifestyle/vlog content' },
              { title: 'Kesariya', artist: 'Arijit Singh', recommendation: 'High saves for emotional storytelling' },
            ],
          }
        }

        return { source: 'live_db', data: songs }
      }

      case 'get_best_posting_time': {
        const sql = getDB()

        // Check if we have scraped analytics
        const [user] = await sql`
          SELECT scraped_summary, primary_platform, engagement_rate
          FROM users WHERE id = ${userId}
        `

        const scrapedSummary = user?.scraped_summary

        if (scrapedSummary?.bestPostingTime) {
          return {
            source: 'personal_analytics',
            bestTime: scrapedSummary.bestPostingTime,
            bestDays: scrapedSummary.bestDays || ['Wednesday', 'Friday'],
            note: 'Based on your actual audience activity',
          }
        }

        // Generic India-optimised times by platform
        const platform = toolArgs.platform || userContext?.platform || 'instagram'
        const genericTimes = {
          instagram: { bestTime: '7:00 PM IST', bestDays: ['Wednesday', 'Friday', 'Saturday'], note: 'India audience peak hours' },
          youtube:   { bestTime: '6:00 PM IST', bestDays: ['Saturday', 'Sunday'], note: 'India audience peak hours' },
        }

        return { source: 'general_india_data', ...genericTimes[platform] }
      }

      case 'get_creator_analytics': {
        const sql = getDB()
        const [user] = await sql`
          SELECT follower_range, engagement_rate, health_score,
                 scraped_summary, archetype, growth_stage
          FROM users WHERE id = ${userId}
        `

        const metric = toolArgs.metric || 'overview'

        if (metric === 'overview') {
          return {
            followerRange: user?.follower_range || 'Unknown',
            engagementRate: user?.engagement_rate || 0,
            healthScore: user?.health_score || 0,
            growthStage: user?.growth_stage || 'GROWTH',
            archetype: user?.archetype || 'Unknown',
          }
        }

        if (metric === 'top_posts' && user?.scraped_summary?.topPosts) {
          return { topPosts: user.scraped_summary.topPosts.slice(0, 3) }
        }

        return { note: 'Connect your Instagram or YouTube handle in Profile to get real analytics.' }
      }

      case 'generate_hook_variations': {
        // Import groq service to generate hooks
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

        const archetype = userContext?.archetype || 'ENTERTAINER'
        const niche = userContext?.niche || 'general'

        const prompt = `Generate 3 hook variations for: "${toolArgs.topic}"
Creator: ${archetype} in ${niche} niche on ${toolArgs.platform || 'Instagram'}
Format: ${toolArgs.format || 'Reel'}

Return ONLY a JSON array:
[
  { "hook": "first 3 seconds script", "trigger": "curiosity|emotion|shock|aspiration", "rating": 85 },
  { "hook": "...", "trigger": "...", "rating": 80 },
  { "hook": "...", "trigger": "...", "rating": 78 }
]`

        const response = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }],
        })

        const raw = response.choices[0].message.content
          .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
        return { hooks: JSON.parse(raw) }
      }

      default:
        logger.warn({ toolName }, 'Unknown tool called')
        return { error: `Tool ${toolName} not found` }
    }
  } catch (err) {
    logger.error({ err, toolName, userId }, 'Tool dispatch failed')
    return { error: `Tool ${toolName} failed: ${err.message}`, fallback: true }
  }
}

module.exports = { ARIA_TOOLS, dispatchTool }
