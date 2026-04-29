'use strict'
// src/controllers/video_dna.controller.js
// POST /api/v1/video-dna/analyse
// 1. Extracts video ID from URL
// 2. Calls YouTube Data API v3 for real stats
// 3. Feeds stats + user archetype into ARIA (Groq) for deep analysis
// 4. Returns structured DNA report

const axios  = require('axios')
const Groq   = require('groq-sdk')
const { getDB }            = require('../config/database')
const { cache }            = require('../config/redis')
const { success, errors }  = require('../utils/response')
const { logger }           = require('../utils/logger')

const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY })
const YT_KEY = process.env.YOUTUBE_API_KEY  // already in your .env
const MODEL  = 'llama-3.3-70b-versatile'

// ── Format helpers ────────────────────────────────────────────────────────────

const formatCount = (n) => {
  const num = parseInt(n, 10) || 0
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000)     return `${(num / 1_000).toFixed(1)}K`
  return String(num)
}

const formatDuration = (iso) => {
  // ISO 8601 duration: PT4M13S → "4:13"
  const match = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return '—'
  const h = parseInt(match[1] || '0')
  const m = parseInt(match[2] || '0')
  const s = parseInt(match[3] || '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

const formatDate = (iso) => {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// ── Step 1: Fetch YouTube video data ─────────────────────────────────────────

const fetchYouTubeData = async (videoId) => {
  const cacheKey = `yt_video:${videoId}`
  const cached = await cache.get(cacheKey)
  if (cached) return cached

  const url = 'https://www.googleapis.com/youtube/v3/videos'
  const params = {
    key:  YT_KEY,
    id:   videoId,
    part: 'snippet,statistics,contentDetails',
  }

  const response = await axios.get(url, { params, timeout: 10000 })
  const items = response.data?.items

  if (!items || items.length === 0) {
    throw new Error('Video not found or is private')
  }

  const video = items[0]
  const snippet = video.snippet
  const stats   = video.statistics
  const content = video.contentDetails

  const views    = parseInt(stats.viewCount    || '0')
  const likes    = parseInt(stats.likeCount    || '0')
  const comments = parseInt(stats.commentCount || '0')

  // Engagement: (likes + comments) / views * 100
  const engagementRate = views > 0
    ? parseFloat(((likes + comments) / views * 100).toFixed(2))
    : 0

  const data = {
    videoId,
    videoTitle:   snippet.title,
    channelName:  snippet.channelTitle,
    channelId:    snippet.channelId,
    description:  (snippet.description || '').slice(0, 500),
    tags:         (snippet.tags || []).slice(0, 15),
    categoryId:   snippet.categoryId,
    publishedAt:  formatDate(snippet.publishedAt),
    publishedRaw: snippet.publishedAt,
    duration:     formatDuration(content.duration),
    durationRaw:  content.duration,
    thumbnailUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url,
    viewCount:    formatCount(stats.viewCount),
    likeCount:    formatCount(stats.likeCount),
    commentCount: formatCount(stats.commentCount),
    viewsRaw:     views,
    likesRaw:     likes,
    commentsRaw:  comments,
    engagementRate,
  }

  // Cache for 2 hours (stats don't change that fast)
  await cache.set(cacheKey, data, 7200)
  return data
}

// ── Step 2: Build ARIA analysis prompt ───────────────────────────────────────

const buildAnalysisPrompt = (videoData, user) => {
  const archetype    = user?.archetype      || 'CREATOR'
  const niche        = user?.niches?.[0]    || 'general'
  const platform     = user?.primary_platform || 'youtube'
  const followerRange = user?.follower_range || 'unknown'
  const engRate      = user?.engagement_rate || 0

  return `You are ARIA — India's most intelligent creator analytics engine. Analyse this YouTube video for an Indian creator and give a brutally honest, data-backed report.

VIDEO DATA:
- Title: "${videoData.videoTitle}"
- Channel: ${videoData.channelName}
- Published: ${videoData.publishedAt}
- Duration: ${videoData.duration}
- Views: ${videoData.viewsRaw.toLocaleString()}
- Likes: ${videoData.likesRaw.toLocaleString()}
- Comments: ${videoData.commentsRaw.toLocaleString()}
- Engagement Rate: ${videoData.engagementRate}%
- Tags: ${videoData.tags.join(', ') || 'none'}
- Description preview: "${videoData.description.slice(0, 200)}"

CREATOR ANALYSING THIS VIDEO:
- Archetype: ${archetype}
- Niche: ${niche}
- Platform: ${platform}
- Follower Range: ${followerRange}
- Their Engagement Rate: ${engRate}%

INDIA-SPECIFIC CONTEXT:
- Use Indian creator economy benchmarks (₹ for money references)
- Reference Indian platforms, festivals, cultural moments where relevant
- For niche benchmarks: Indian YouTube/Reels performance data
- Typical Indian YouTube benchmarks by size:
  - 0–10K subscribers: 500–5K views is average
  - 10K–100K subscribers: 5K–50K views is average
  - 100K–1M subscribers: 50K–500K views is average
  - 1M+ subscribers: 500K+ views is average

RESPOND ONLY with this exact JSON structure, no markdown, no preamble:
{
  "overallScore": <integer 0-100>,
  "scoreVerdict": "<Strong Performer|Good Start|Needs Work|Underperforming>",
  "scoreSummary": "<2 sentences: overall take on this video's performance>",

  "hookScore": <integer 0-100>,
  "hookAnalysis": "<2-3 sentences: rate the title as a hook. First 3 seconds implied by the title. What emotion does it trigger? Curiosity? FOMO? None?>",
  "improvedHook": "<rewrite the title as a stronger hook for Indian audience, or null if already strong>",

  "titleScore": <integer 0-100>,
  "titleAnalysis": "<2 sentences: SEO strength, keyword usage, clarity, length>",
  "betterTitle": "<optimised title with better keywords, or null>",

  "benchmarkScore": <integer 0-100>,
  "benchmarkAnalysis": "<2-3 sentences: how does this perform vs Indian creators of this size in this niche?>",
  "benchmarkStats": [
    "<specific stat comparison e.g. '4.2% engagement is 2x the Indian fashion creator average of 2.1%'>",
    "<another comparison>",
    "<one more if relevant>"
  ],

  "ariaInsight": "<3-4 sentences: ARIA's personal, direct, Hinglish-flavoured take on this video. Be honest. What's working, what's not, what's the single biggest thing holding this video back?>",
  "actionItems": [
    "<specific action #1 the creator can take right now>",
    "<specific action #2>",
    "<specific action #3>"
  ],

  "nextVideoSuggestion": "<title of the EXACT next video they should make, based on this one's performance>",
  "nextVideoReason": "<2 sentences: why this is the logical next video based on the data>"
}`
}

// ── Step 3: Call ARIA (Groq) ──────────────────────────────────────────────────

const callARIA = async (prompt) => {
  const response = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 1800,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = response.choices[0].message.content
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()

  return JSON.parse(raw)
}

// ── Main handler ──────────────────────────────────────────────────────────────

const analyseVideo = async (req, reply) => {
  const { videoId } = req.body
  const user = req.user

  if (!videoId) {
    return errors.validation(reply, 'videoId is required')
  }

  // Basic video ID format check
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return errors.validation(reply, 'Invalid YouTube video ID')
  }

  try {
    const sql = getDB()

    // Get full user profile for archetype-aware analysis
    const [fullUser] = await sql`
      SELECT archetype, niches, primary_platform, follower_range,
             engagement_rate, health_score, tone_profile
      FROM users WHERE id = ${user.id}
    `

    logger.info({ videoId, userId: user.id }, 'Video DNA analysis started')

    // Step 1: YouTube API
    let videoData
    try {
      videoData = await fetchYouTubeData(videoId)
    } catch (ytErr) {
      logger.warn({ ytErr, videoId }, 'YouTube API failed')
      if (ytErr.message.includes('not found') || ytErr.message.includes('private')) {
        return errors.notFound(reply, 'Video')
      }
      return errors.serviceDown(reply, 'YouTube API')
    }

    // Step 2: ARIA Analysis
    const prompt = buildAnalysisPrompt(videoData, fullUser)
    let ariaAnalysis
    try {
      ariaAnalysis = await callARIA(prompt)
    } catch (ariaErr) {
      logger.error({ ariaErr, videoId }, 'ARIA analysis failed')
      return errors.serviceDown(reply, 'ARIA analysis engine')
    }

    // Step 3: Merge and return
    const result = {
      // Video metadata
      videoId:        videoData.videoId,
      videoTitle:     videoData.videoTitle,
      channelName:    videoData.channelName,
      publishedAt:    videoData.publishedAt,
      duration:       videoData.duration,
      thumbnailUrl:   videoData.thumbnailUrl,

      // Stats
      viewCount:      videoData.viewCount,
      likeCount:      videoData.likeCount,
      commentCount:   videoData.commentCount,
      engagementRate: videoData.engagementRate,

      // ARIA scores + analysis (from Groq)
      ...ariaAnalysis,
    }

    // Save to DB for history (non-blocking)
    sql`
      INSERT INTO video_dna_analyses
        (user_id, video_id, video_title, channel_name, result_data, analysed_at)
      VALUES
        (${user.id}, ${videoId}, ${videoData.videoTitle},
         ${videoData.channelName}, ${JSON.stringify(result)}, NOW())
      ON CONFLICT (user_id, video_id)
      DO UPDATE SET result_data = EXCLUDED.result_data, analysed_at = NOW()
    `.catch(err => logger.warn({ err }, 'Video DNA history save failed'))

    logger.info({ videoId, userId: user.id, score: ariaAnalysis.overallScore },
      'Video DNA analysis complete')

    return success(reply, result)

  } catch (err) {
    logger.error({ err, videoId, userId: user.id }, 'Video DNA failed')
    return errors.internal(reply)
  }
}

// ── GET /api/v1/video-dna/history ─────────────────────────────────────────────

const getHistory = async (req, reply) => {
  try {
    const sql = getDB()
    const analyses = await sql`
      SELECT video_id, video_title, channel_name,
             result_data->>'overallScore' AS score,
             result_data->>'scoreVerdict' AS verdict,
             result_data->>'thumbnailUrl' AS thumbnail_url,
             analysed_at
      FROM video_dna_analyses
      WHERE user_id = ${req.user.id}
      ORDER BY analysed_at DESC
      LIMIT 10
    `
    return success(reply, analyses)
  } catch (err) {
    logger.error({ err }, 'Video DNA history failed')
    return errors.internal(reply)
  }
}

module.exports = { analyseVideo, getHistory }
