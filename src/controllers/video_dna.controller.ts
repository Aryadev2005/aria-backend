import { FastifyRequest, FastifyReply } from 'fastify';
import axios from 'axios';
import OpenAI from 'openai';
import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { success, errors } from '../utils/response';
import { logger } from '../utils/logger';
import { User } from '../types';
import { computeVideoDNAReport, RawSignals } from '../services/videoDnaScoring.service';
import { runCompetitorGapAnalysis } from '../services/competitorGap.service';

let _openai: OpenAI | null = null;
const groq = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 30_000 });
  return _openai;
};

const YT_KEY = process.env.YOUTUBE_API_KEY;
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────

const formatCount = (n: string | number): string => {
  const num = typeof n === 'string' ? parseInt(n, 10) : n;
  if (isNaN(num)) return '0';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000)     return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
};

const formatDuration = (iso: string): string => {
  const match = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '—';
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0');
  const s = parseInt(match[3] || '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const formatDate = (iso: string): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Fetch YouTube data
// ─────────────────────────────────────────────────────────────────────────────

interface YouTubeVideoData {
  videoId: string;
  videoTitle: string;
  channelName: string;
  channelId: string;
  description: string;
  tags: string[];
  categoryId: string;
  publishedAt: string;
  duration: string;
  durationSeconds: number;
  thumbnailUrl: string;
  viewCount: string;
  likeCount: string;
  commentCount: string;
  viewsRaw: number;
  likesRaw: number;
  commentsRaw: number;
  hasChapters: number;
  hasDescription: boolean;
  tagCount: number;
}

const fetchYouTubeData = async (videoId: string): Promise<YouTubeVideoData> => {
  const cacheKey = `yt_video_v2:${videoId}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as ReturnType<typeof fetchYouTubeData>;

  const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
    params: { key: YT_KEY, id: videoId, part: 'snippet,statistics,contentDetails' },
    timeout: 10_000,
  });

  const items = response.data?.items;
  if (!items?.length) throw new Error('Video not found or is private');

  const video   = items[0];
  const snippet = video.snippet;
  const stats   = video.statistics;
  const content = video.contentDetails;

  const views    = parseInt(stats.viewCount    || '0');
  const likes    = parseInt(stats.likeCount    || '0');
  const comments = parseInt(stats.commentCount || '0');

  // Parse ISO 8601 duration to seconds
  const durationMatch = content.duration?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const durationSeconds = durationMatch
    ? parseInt(durationMatch[1] || '0') * 3600
      + parseInt(durationMatch[2] || '0') * 60
      + parseInt(durationMatch[3] || '0')
    : 0;

  const data = {
    videoId,
    videoTitle:      snippet.title,
    channelName:     snippet.channelTitle,
    channelId:       snippet.channelId,
    description:     (snippet.description || '').slice(0, 600),
    tags:            (snippet.tags || []).slice(0, 20),
    categoryId:      snippet.categoryId || '22',
    publishedAt:     formatDate(snippet.publishedAt),
    duration:        formatDuration(content.duration),
    durationSeconds,
    thumbnailUrl:    snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || '',
    viewCount:       formatCount(views),
    likeCount:       formatCount(likes),
    commentCount:    formatCount(comments),
    viewsRaw:        views,
    likesRaw:        likes,
    commentsRaw:     comments,
    hasChapters:     (snippet.description || '').includes('0:00') ? 5 : 1, // chaptered? bonus
    hasDescription:  (snippet.description || '').length > 100,
    tagCount:        (snippet.tags || []).length,
  };

  await cache.set(cacheKey, data, 7200);
  return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Signal extraction prompt
// AI ONLY extracts bounded integers and qualitative text.
// IT DOES NOT COMPUTE ANY FINAL SCORES.
// Temperature is 0 — extraction, not generation.
// ─────────────────────────────────────────────────────────────────────────────

const buildSignalExtractionPrompt = (videoData: any, user: Partial<User>): string => {
  const archetype    = user?.archetype    || 'CREATOR';
  const niche        = (Array.isArray(user?.niches) ? user.niches[0] : user?.niches) || 'general';
  const platform     = user?.primary_platform  || 'youtube';
  const followerRange = user?.follower_range || 'unknown';
  const engRate      = user?.engagement_rate || 0;

  return `You are ARIA — India's creator intelligence engine. Extract raw signals from this YouTube video.

IMPORTANT: You are a SENSOR, not a calculator. Your job is ONLY to rate the signals below.
Do NOT compute any overall score. Do NOT invent engagement numbers. Extract only what the title, description, and tags tell you.

VIDEO DATA:
Title: "${videoData.videoTitle}"
Channel: ${videoData.channelName}
Duration: ${videoData.duration}
Views: ${videoData.viewsRaw.toLocaleString()}
Likes: ${videoData.likesRaw.toLocaleString()}
Comments: ${videoData.commentsRaw.toLocaleString()}
Tags: ${videoData.tags.join(', ') || 'none'}
Description preview: "${videoData.description.slice(0, 400)}"
Has chapters: ${videoData.hasChapters > 1 ? 'Yes' : 'No'}

CREATOR CONTEXT:
Archetype: ${archetype} | Niche: ${niche} | Platform: ${platform}
Their followers: ${followerRange} | Their engagement: ${engRate}%

INDIA CONTEXT:
Rate India relevance for Indian YouTube audience (cultural fit, language, topics, festivals).

RESPOND ONLY with this exact JSON. ALL numeric fields MUST be integers within stated bounds:
{
  "titleCuriosity":      <integer 1-10: does title make you NEED to click?>,
  "titleClarity":        <integer 1-10: is the topic 100% clear in 2 seconds?>,
  "titleEmotionalPull":  <integer 1-10: does title trigger curiosity/FOMO/emotion?>,

  "keywordPresence":     <integer 1-5: 1=no keywords, 5=perfect keyword optimisation>,
  "descriptionQuality":  <integer 1-5: 1=blank/spam, 5=timestamped+links+keywords>,
  "tagRelevance":        <integer 1-5: 1=irrelevant/spammy, 5=highly targeted tags>,

  "thumbnailTitleSync":  <integer 1-10: does title promise match what thumbnail likely shows?>,
  "topicDepth":          <integer 1-10: 1=completely generic, 10=hyper-specific valuable angle>,
  "indiaRelevance":      <integer 1-10: how relevant to Indian YouTube audience?>,

  "hasStrongHook":       <integer 1-5: inferred from title — does it promise a payoff?>,
  "hasCTA":              <integer 1-5: 1=no CTA in desc, 5=strong subscribe/like/comment CTA>,
  "hasChapters":         ${videoData.hasChapters},

  "ariaInsight":         "<3-4 sentences: ARIA's honest take. What's working, what's not, one concrete improvement. Hinglish tone OK. Reference actual title/data.>",
  "actionItems":         [
    "<specific action 1 referencing actual title/data>",
    "<specific action 2>",
    "<specific action 3>"
  ],
  "improvedHook":        "<rewrite the title as a stronger hook for Indian audience, or null if already strong>",
  "betterTitle":         "<SEO-optimised title alternative, or null if already optimal>",
  "nextVideoSuggestion": "<exact title of the logical next video to make>",
  "nextVideoReason":     "<2 sentences: why this is the right next video based on the data>",
  "benchmarkAnalysis":   "<2-3 sentences: how does this video compare to Indian ${niche} creators of similar size?>",
  "benchmarkStats":      [
    "<specific comparison stat 1>",
    "<specific comparison stat 2>"
  ]
}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Call AI (signal extraction only)
// Temperature 0 = deterministic extraction, minimal variance
// ─────────────────────────────────────────────────────────────────────────────

const extractSignals = async (prompt: string): Promise<Partial<RawSignals>> => {
  const response = await groq().chat.completions.create({
    model: MODEL,
    max_tokens: 800,
    temperature: 0,          // ← CRITICAL: temperature 0 for extraction tasks
    messages: [
      {
        role: 'system',
        content: 'You are a signal extractor. Respond ONLY with a valid JSON object. No markdown, no preamble, no explanation. Start with { end with }.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Empty response from AI');

  const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Handler: POST /api/v1/video-dna/analyse
// ─────────────────────────────────────────────────────────────────────────────

export const analyseVideo = async (
  req: FastifyRequest<{ Body: { videoId: string } }>,
  reply: FastifyReply,
) => {
  const { videoId } = req.body;
  const user = req.user as User;

  if (!videoId) {
    return errors.error(reply, 'videoId is required', 400, 'VALIDATION_ERROR');
  }
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return errors.error(reply, 'Invalid YouTube video ID', 400, 'VALIDATION_ERROR');
  }

  try {
    // Fetch full user profile for personalised signals
    const fullUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: {
        archetype: true, niches: true, primary_platform: true,
        follower_range: true, engagement_rate: true,
        health_score: true, tone_profile: true,
      },
    });

    logger.info({ videoId, userId: user.id }, 'Video DNA analysis started');

    // Step 1: Fetch YouTube metadata
    let videoData: any;
    try {
      videoData = await fetchYouTubeData(videoId);
    } catch (ytErr: any) {
      logger.warn({ ytErr: ytErr.message, videoId }, 'YouTube API failed');
      if (ytErr.message.includes('not found') || ytErr.message.includes('private')) {
        return errors.notFound(reply, 'Video');
      }
      return errors.serviceDown(reply, 'YouTube API');
    }

    // Step 2: AI extracts raw signals (sensor role only)
    const prompt = buildSignalExtractionPrompt(videoData, fullUser as Partial<User>);
    let rawSignals: Partial<RawSignals>;
    try {
      rawSignals = await extractSignals(prompt);
    } catch (aiErr: any) {
      logger.error({ aiErr: aiErr.message, videoId }, 'Signal extraction failed');
      return errors.serviceDown(reply, 'ARIA signal extraction');
    }

    // Step 3: TypeScript computes all scores deterministically
    const niche = (Array.isArray(fullUser?.niches as unknown[]) ? (fullUser?.niches as string[])[0] : fullUser?.niches as string) || 'general';
    const scoredReport = await computeVideoDNAReport(
      rawSignals,
      videoData.viewsRaw,
      videoData.likesRaw,
      videoData.commentsRaw,
      videoData.durationSeconds,
      niche,
    );

    // Assemble final result (matches existing frontend field expectations)
    const result = {
      // Video metadata
      videoId:      videoData.videoId,
      videoTitle:   videoData.videoTitle,
      channelName:  videoData.channelName,
      publishedAt:  videoData.publishedAt,
      duration:     videoData.duration,
      thumbnailUrl: videoData.thumbnailUrl,
      viewCount:    videoData.viewCount,
      likeCount:    videoData.likeCount,
      commentCount: videoData.commentCount,

      // All scores — computed in TypeScript, not AI
      ...scoredReport,

      // Analysis provenance — useful for debugging
      analysisEngine: 'v2_deterministic',
      scoringVersion: '2.0',
    };

    // Persist (fire-and-forget)
    (prisma as any).video_dna_analyses.upsert({
      where:  { user_id_video_id: { user_id: user.id, video_id: videoId } },
      update: {
        result_data:      result,
        analysis_version: 'v2',
        analysed_at:      new Date(),
      },
      create: {
        user_id:          user.id,
        video_id:         videoId,
        video_title:      videoData.videoTitle,
        channel_name:     videoData.channelName,
        result_data:      result,
        analysis_version: 'v2',
        analysed_at:      new Date(),
      },
    }).catch((err: any) => logger.warn({ err }, 'Video DNA history save failed'));

    logger.info({ videoId, userId: user.id, overallScore: result.overallScore, grade: result.grade }, 'Video DNA v2 complete');

    return success(reply, result);

  } catch (err: any) {
    logger.error({ err: err.message, videoId, userId: user.id }, 'Video DNA failed');
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/video-dna/history
// ─────────────────────────────────────────────────────────────────────────────

export const getHistory = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    const rows = await (prisma as any).video_dna_analyses.findMany({
      where:   { user_id: user.id },
      orderBy: { analysed_at: 'desc' },
      take:    10,
      select: {
        video_id:         true,
        video_title:      true,
        channel_name:     true,
        result_data:      true,
        analysed_at:      true,
        analysis_version: true,
      },
    });

    return success(reply, rows.map((row: any) => ({
      video_id:         row.video_id,
      video_title:      row.video_title,
      channel_name:     row.channel_name,
      score:            row.result_data?.overallScore,
      grade:            row.result_data?.grade,
      verdict:          row.result_data?.scoreVerdict,
      thumbnail_url:    row.result_data?.thumbnailUrl,
      analysed_at:      row.analysed_at,
      analysis_version: row.analysis_version,
    })));
  } catch (err) {
    logger.error({ err }, 'Video DNA history failed');
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/video-dna/competitor-gap
// ─────────────────────────────────────────────────────────────────────────────
export const getCompetitorGap = async (req: FastifyRequest, reply: FastifyReply) => {
  const user        = req.user as User;
  const { niche }   = req.body as { niche: string };

  if (!niche?.trim()) return errors.validation(reply, 'niche is required');

  try {
    const report = await runCompetitorGapAnalysis(niche, user.id);
    return success(reply, report);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Competitor gap analysis failed');
    return errors.serviceDown(reply, 'Competitor Gap Analysis');
  }
};
