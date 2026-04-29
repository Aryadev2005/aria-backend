'use strict'
// src/agent/tools.js
// All 12 ARIA tools — each fetches live data, normalizes it, returns lean JSON.
// The agent (LLM) decides which tools to call based on the user's query.
// Raw API response never touches the LLM — only the normalized output does.

const axios = require('axios')
const { tool } = require('@langchain/core/tools')
const { z } = require('zod')

const {
  normalizeYouTubeVideo,
  normalizeYouTubeChannel,
  normalizeYouTubeSearch,
  normalizeSpotifyTracks,
  normalizeJioSaavnSongs,
  normalizeGoogleTrends,
  normalizeInstagramMedia,
  normalizeInstagramInsights,
  normalizeDBTrends,
  normalizeUserProfile,
  normalizeDBSongs,
} = require('./normalizer')

const YT_KEY = process.env.YOUTUBE_API_KEY
const YT_BASE = 'https://www.googleapis.com/youtube/v3'

// ── TOOL 1: YouTube video stats ───────────────────────────────────────────────
const getYouTubeVideoStats = tool(
  async ({ videoId }) => {
    try {
      const { data } = await axios.get(`${YT_BASE}/videos`, {
        params: { key: YT_KEY, id: videoId, part: 'snippet,statistics,contentDetails' },
        timeout: 8000,
      })
      return JSON.stringify(normalizeYouTubeVideo(data))
    } catch (err) {
      return JSON.stringify({ error: `YouTube video fetch failed: ${err.message}` })
    }
  },
  {
    name: 'get_youtube_video_stats',
    description: 'Fetch real-time stats for a YouTube video: views, likes, comments, engagement rate, duration, tags, publish date. Use when user pastes a YouTube URL or asks about a specific video.',
    schema: z.object({
      videoId: z.string().length(11).describe('11-character YouTube video ID extracted from URL'),
    }),
  }
)

// ── TOOL 2: YouTube channel stats ─────────────────────────────────────────────
const getYouTubeChannelStats = tool(
  async ({ channelId }) => {
    try {
      const { data } = await axios.get(`${YT_BASE}/channels`, {
        params: { key: YT_KEY, id: channelId, part: 'snippet,statistics' },
        timeout: 8000,
      })
      return JSON.stringify(normalizeYouTubeChannel(data))
    } catch (err) {
      return JSON.stringify({ error: `Channel fetch failed: ${err.message}` })
    }
  },
  {
    name: 'get_youtube_channel_stats',
    description: 'Fetch a YouTube channel\'s subscriber count, total views, video count, and average views per video. Use for channel-level analysis or competitor research.',
    schema: z.object({
      channelId: z.string().describe('YouTube channel ID (starts with UC...)'),
    }),
  }
)

// ── TOOL 3: YouTube search (live competitor / trend research) ─────────────────
const searchYouTube = tool(
  async ({ query, maxResults = 8 }) => {
    try {
      const { data } = await axios.get(`${YT_BASE}/search`, {
        params: {
          key: YT_KEY, q: query,
          part: 'snippet', type: 'video',
          order: 'viewCount', regionCode: 'IN',
          relevanceLanguage: 'hi',
          maxResults,
        },
        timeout: 8000,
      })
      return JSON.stringify(normalizeYouTubeSearch(data))
    } catch (err) {
      return JSON.stringify({ error: `YouTube search failed: ${err.message}` })
    }
  },
  {
    name: 'search_youtube',
    description: 'Search YouTube for videos matching a topic, trend, or niche. Returns top results by view count. Use to research what\'s performing well on YouTube India for a given topic.',
    schema: z.object({
      query: z.string().describe('Search query — e.g. "budget fashion haul india 2025"'),
      maxResults: z.number().min(1).max(10).optional().describe('Number of results, default 8'),
    }),
  }
)

// ── TOOL 4: Spotify India trending tracks ─────────────────────────────────────
const getSpotifyTrending = tool(
  async () => {
    try {
      // Fetch Spotify India Daily Charts via charts page
      const { data } = await axios.get(
        'https://charts.spotify.com/charts/view/regional-in-daily/latest',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 12000 }
      )

      // Extract __NEXT_DATA__ which contains chart data
      const match = data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
      if (!match) throw new Error('Could not extract Spotify chart data')

      const parsed   = JSON.parse(match[1])
      const entries  = parsed?.props?.pageProps?.chartEntryData || []
      const tracks   = entries.slice(0, 30).map((e, i) => ({
        rank:    i + 1,
        title:   e.trackMetadata?.trackName,
        artist:  (e.trackMetadata?.artists || []).map(a => a.name).join(', '),
        streams: e.chartEntryData?.rankingMetric?.value || 0,
        peakRank: e.chartEntryData?.peakRank || i + 1,
      })).filter(t => t.title)

      return JSON.stringify({ source: 'spotify_india_daily', tracks })
    } catch (err) {
      // Fallback: return empty, agent will try JioSaavn
      return JSON.stringify({ source: 'spotify_india_daily', tracks: [], error: err.message })
    }
  },
  {
    name: 'get_spotify_trending',
    description: 'Fetch Spotify India daily trending tracks — real chart positions and stream counts. Use when user asks about trending music, audio for Reels, or BGM recommendations.',
    schema: z.object({}),
  }
)

// ── TOOL 5: JioSaavn trending (Indian music chart) ────────────────────────────
const getJioSaavnTrending = tool(
  async () => {
    try {
      const { data } = await axios.get('https://www.jiosaavn.com/api.php', {
        params: { __call: 'webapi.get', _format: 'json', _marker: '0', ctx: 'web6', n: 20, p: 1, query: 'trending' },
        timeout: 10000,
      })
      const songs = (data.results || []).slice(0, 15)
      return JSON.stringify({ source: 'jiosaavn_trending', songs: normalizeJioSaavnSongs(songs) })
    } catch (err) {
      return JSON.stringify({ source: 'jiosaavn_trending', songs: [], error: err.message })
    }
  },
  {
    name: 'get_jiosaavn_trending',
    description: 'Fetch JioSaavn India trending songs — specifically useful for Hindi/regional language music trends. Use alongside Spotify for comprehensive Indian music trend coverage.',
    schema: z.object({}),
  }
)

// ── TOOL 6: Google Trends (live search interest) ──────────────────────────────
const getGoogleTrends = tool(
  async ({ keyword, geo = 'IN', timeframe = 'now 7-d' }) => {
    try {
      const googleTrends = require('google-trends-api')
      const result = await googleTrends.interestOverTime({
        keyword,
        geo,
        startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      })
      const parsed = JSON.parse(result)
      return JSON.stringify({
        keyword,
        trend: normalizeGoogleTrends(parsed),
      })
    } catch (err) {
      return JSON.stringify({ error: `Google Trends failed: ${err.message}` })
    }
  },
  {
    name: 'get_google_trends',
    description: 'Get real-time Google search interest for a keyword in India. Returns trend direction (rising/falling), average interest (0-100), and peak. Use when user asks what\'s trending or for keyword research.',
    schema: z.object({
      keyword: z.string().describe('Search keyword or topic to check trend for'),
      geo: z.string().optional().describe('Country code, default "IN" for India'),
      timeframe: z.string().optional().describe('Timeframe: "now 1-d", "now 7-d", "today 1-m". Default "now 7-d"'),
    }),
  }
)

// ── TOOL 7: Instagram personal analytics (Graph API) ─────────────────────────
const getInstagramPersonalStats = tool(
  async ({ userId, accessToken, metric = 'posts' }) => {
    try {
      const baseUrl = 'https://graph.instagram.com'
      let endpoint, params

      if (metric === 'posts') {
        endpoint = `${baseUrl}/${userId}/media`
        params = {
          fields: 'id,media_type,timestamp,caption,like_count,comments_count,reach,saved,impressions,permalink',
          access_token: accessToken,
        }
      } else {
        endpoint = `${baseUrl}/${userId}/insights`
        params = {
          metric: 'reach,impressions,profile_views,follower_count,website_clicks,email_contacts',
          access_token: accessToken,
        }
      }

      const { data: response } = await axios.get(endpoint, { params, timeout: 10000 })

      return JSON.stringify({
        metric,
        data: metric === 'posts'
          ? normalizeInstagramMedia(response)
          : normalizeInstagramInsights(response),
      })
    } catch (err) {
      return JSON.stringify({ error: `Instagram Graph API failed: ${err.message}` })
    }
  },
  {
    name: 'get_instagram_personal_stats',
    description: 'Fetch the creator\'s own Instagram post performance and account insights via Instagram Graph API. Only works if user has connected their Instagram Business account. Use for personal analytics questions.',
    schema: z.object({
      userId: z.string().describe('Instagram user ID from DB'),
      accessToken: z.string().describe('Instagram Graph API access token from DB'),
      metric: z.enum(['posts', 'insights']).optional().describe('"posts" for media performance, "insights" for account-level metrics'),
    }),
  }
)

// ── TOOL 8: User personal profile from ARIA DB ────────────────────────────────
const getUserProfile = tool(
  async ({ userId, db }) => {
    try {
      const [user] = await db`
        SELECT id, archetype, archetype_label, niche, niches, primary_platform,
               follower_range, engagement_rate, health_score, growth_stage, tone_profile,
               instagram_user_id, instagram_access_token
        FROM users WHERE id = ${userId}
      `

      if (!user) return JSON.stringify({ error: 'user_not_found' })

      // Fetch memory learnings if available
      const memory = await db`
        SELECT learning_type, data FROM aria_memory WHERE user_id = ${userId}
      `

      user.memory = memory.reduce((acc, m) => {
        acc[m.learning_type] = m.data
        return acc
      }, {})

      return JSON.stringify(normalizeUserProfile(user))
    } catch (err) {
      return JSON.stringify({ error: `Failed to fetch user profile: ${err.message}` })
    }
  },
  {
    name: 'get_user_profile',
    description: 'Fetch the current user\'s full creator profile: archetype, niche, follower range, engagement rate, health score, platform, and all persistent ARIA memory learnings. Always call this first when answering personal questions about the user\'s performance or strategy.',
    schema: z.object({
      userId: z.string().uuid().describe('User UUID from auth context'),
      db: z.any().describe('Database connection — injected by agent runtime, do not pass manually'),
    }),
  }
)

// ── TOOL 9: ARIA DB live trends ───────────────────────────────────────────────
const getDBLiveTrends = tool(
  async ({ niche, badge, db }) => {
    try {
      let query = db`
        SELECT title, badge, velocity, search_volume, niche_tags, recommendation, expires_at
        FROM live_trends WHERE expires_at > NOW()
      `

      if (niche && niche !== 'all') {
        query = db`
          SELECT title, badge, velocity, search_volume, niche_tags, recommendation, expires_at
          FROM live_trends WHERE expires_at > NOW() AND ${niche} = ANY(niche_tags)
        `
      }

      if (badge && badge !== 'ALL') {
        query = db`
          SELECT title, badge, velocity, search_volume, niche_tags, recommendation, expires_at
          FROM live_trends WHERE expires_at > NOW() AND badge = ${badge}
        `
      }

      const trends = await query

      return JSON.stringify(normalizeDBTrends(trends))
    } catch (err) {
      return JSON.stringify({ error: `Failed to fetch live trends: ${err.message}` })
    }
  },
  {
    name: 'get_db_live_trends',
    description: 'Fetch live trending topics from ARIA\'s real-time trends database (populated by BullMQ workers from pytrends + Reddit). Faster than Google Trends API. Use for trend-based content advice.',
    schema: z.object({
      niche: z.string().optional().describe('Creator niche filter e.g. "fashion", "fitness". Use "all" for all niches.'),
      badge: z.enum(['HOT', 'RISING', 'NEW', 'ALL']).optional().describe('Trend velocity filter'),
      db: z.any().describe('Database connection — injected by agent runtime'),
    }),
  }
)

// ── TOOL 10: ARIA DB trending songs ──────────────────────────────────────────
const getDBTrendingSongs = tool(
  async ({ platform, language, db }) => {
    try {
      let query = db`SELECT title, artist, chart_position, language, streams_today, posting_signal, lifecycle FROM live_songs ORDER BY chart_position ASC LIMIT 20`

      if (language) {
        query = db`
          SELECT title, artist, chart_position, language, streams_today, posting_signal, lifecycle
          FROM live_songs WHERE language = ${language} ORDER BY chart_position ASC LIMIT 20
        `
      }

      const songs = await query

      return JSON.stringify(normalizeDBSongs(songs))
    } catch (err) {
      return JSON.stringify({ error: `Failed to fetch trending songs: ${err.message}` })
    }
  },
  {
    name: 'get_db_trending_songs',
    description: 'Fetch currently trending songs/audio from ARIA\'s live song database. Updated every few hours from Spotify + JioSaavn. Use for BGM/audio recommendations for Reels and Shorts.',
    schema: z.object({
      platform: z.string().optional().describe('Target platform: "instagram" or "youtube"'),
      language: z.string().optional().describe('Language filter: "Hindi", "English", "Punjabi", etc.'),
      db: z.any().describe('Database connection — injected by agent runtime'),
    }),
  }
)

// ── TOOL 11: User's past content performance ──────────────────────────────────
const getUserContentHistory = tool(
  async ({ userId, limit = 10, db }) => {
    try {
      const content = await db`
        SELECT title, format, platform, posted_at, engagement_score, views
        FROM user_content WHERE user_id = ${userId}
        ORDER BY posted_at DESC LIMIT ${limit}
      `

      return JSON.stringify({
        content: content.map(c => ({
          title: c.title,
          format: c.format,
          platform: c.platform,
          postedAt: c.posted_at,
          engagementScore: c.engagement_score,
          views: c.views,
        })),
      })
    } catch (err) {
      return JSON.stringify({ error: `Failed to fetch content history: ${err.message}` })
    }
  },
  {
    name: 'get_user_content_history',
    description: 'Fetch the user\'s recent content creation history from ARIA — what they\'ve created, which formats, which platforms. Use to avoid repeating suggestions and to identify content gaps.',
    schema: z.object({
      userId: z.string().uuid(),
      limit: z.number().optional().describe('Number of records, default 10'),
      db: z.any().describe('Database connection — injected by agent runtime'),
    }),
  }
)

// ── TOOL 12: Video DNA quick analysis (uses already-built service) ─────────────
const analyseYouTubeVideoQuick = tool(
  async ({ videoId }) => {
    try {
      // Fetch video stats
      const videoRes = await axios.get(`${YT_BASE}/videos`, {
        params: { key: YT_KEY, id: videoId, part: 'snippet,statistics,contentDetails' },
        timeout: 8000,
      })

      const video = normalizeYouTubeVideo(videoRes.data)

      if (video.error) return JSON.stringify({ error: 'video_not_found' })

      // Search for similar videos to benchmark
      const searchRes = await axios.get(`${YT_BASE}/search`, {
        params: {
          key: YT_KEY,
          q: video.title,
          part: 'snippet',
          type: 'video',
          order: 'viewCount',
          regionCode: 'IN',
          maxResults: 5,
        },
        timeout: 8000,
      })

      const similar = normalizeYouTubeSearch(searchRes.data)

      return JSON.stringify({
        video,
        benchmarkingAgainst: similar.results.length > 0 ? similar : { message: 'No benchmarks found' },
      })
    } catch (err) {
      return JSON.stringify({ error: `Video analysis failed: ${err.message}` })
    }
  },
  {
    name: 'analyse_youtube_video_quick',
    description: 'Fetch a YouTube video\'s stats AND top performing videos in the same category for comparison. Use when user wants to analyse a specific video and benchmark it against competitors.',
    schema: z.object({
      videoId: z.string().length(11).describe('11-character YouTube video ID'),
    }),
  }
)

// ── Export all tools as array ─────────────────────────────────────────────────
const ALL_ARIA_TOOLS = [
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
]

module.exports = {
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
  ALL_ARIA_TOOLS,
}
