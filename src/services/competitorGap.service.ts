import OpenAI from 'openai';
import axios from 'axios';
import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';
import type { CompetitorGapReport } from '../types/videoIntelligence.types';

let _openai: OpenAI | null = null;
const getAI = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 60_000 });
  return _openai;
};

const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const YT_KEY = process.env.YOUTUBE_API_KEY;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

interface VideoSummary {
  videoId: string;
  title: string;
  views: number;
  likes: number;
  tags: string[];
  description: string;
  duration: string;
}

/**
 * Fetch top 10 videos in a niche from YouTube search.
 */
const fetchTopNicheVideos = async (niche: string, count = 10): Promise<VideoSummary[]> => {
  const cacheKey = `competitor_videos:${niche}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as VideoSummary[];

  if (!YT_KEY) {
    logger.warn('YOUTUBE_API_KEY not configured');
    return [];
  }

  // Step 1: Search for videos
  const searchRes = await axios.get(`${YT_BASE}/search`, {
    params: {
      key: YT_KEY,
      q: `${niche} India`,
      type: 'video',
      part: 'snippet',
      maxResults: count,
      regionCode: 'IN',
      relevanceLanguage: 'hi,en',
      videoDuration: 'medium',
      order: 'viewCount',
    },
    timeout: 10_000,
  });

  const videoIds = searchRes.data.items
    ?.map((item: any) => item.id?.videoId)
    .filter(Boolean)
    .join(',');

  if (!videoIds) return [];

  // Step 2: Fetch full stats
  const statsRes = await axios.get(`${YT_BASE}/videos`, {
    params: {
      key: YT_KEY,
      id: videoIds,
      part: 'snippet,statistics,contentDetails',
    },
    timeout: 10_000,
  });

  const videos: VideoSummary[] = (statsRes.data.items ?? []).map((v: any) => ({
    videoId: v.id,
    title: v.snippet.title,
    views: parseInt(v.statistics.viewCount ?? '0'),
    likes: parseInt(v.statistics.likeCount ?? '0'),
    tags: (v.snippet.tags ?? []).slice(0, 10),
    description: (v.snippet.description ?? '').slice(0, 300),
    duration: v.contentDetails.duration,
  }));

  await cache.set(cacheKey, videos, 3600 * 6); // 6-hour cache
  return videos;
};

/**
 * Run full competitor gap analysis for a niche.
 * Analyses 10 top videos and finds the content gap.
 */
export const runCompetitorGapAnalysis = async (
  niche: string,
  userId: string,
): Promise<CompetitorGapReport> => {
  const cacheKey = `gap_report:${niche}:${userId}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as CompetitorGapReport;

  const videos = await fetchTopNicheVideos(niche, 10);
  if (videos.length === 0) {
    return buildEmptyGapReport(niche);
  }

  const videoSummaries = videos
    .map((v, i) => `Video ${i + 1}: "${v.title}" | ${v.views.toLocaleString()} views | Tags: ${v.tags.join(', ')} | Description: ${v.description.slice(0, 150)}`)
    .join('\n');

  const avgEngagement = videos.length > 0
    ? videos.reduce((s, v) => s + (v.views > 0 ? (v.likes / v.views) * 100 : 0), 0) / videos.length
    : 0;

  const prompt = `You are ARIA — India's content strategy engine. Analyse these ${videos.length} top YouTube videos in the "${niche}" niche from India.

TOP VIDEOS:
${videoSummaries}

Find the CONTENT GAPS — topics all these videos missed that a smart creator could own.

RESPOND ONLY with this exact JSON:
{
  "topTopics": ["<topic all videos covered — saturated>"],
  "missedTopics": ["<topic NONE of the 10 covered — golden opportunity>"],
  "overservedTopics": ["<topic 7+ videos covered — avoid>"],
  "titlePatterns": ["<title formula these videos use, e.g. 'How I [verb]ed X in [time]'>"],
  "opportunityScore": <0-100, 100=massive gap>,
  "scriptTemplate": "<A 3-paragraph script outline for the best missed topic. Start with: 'TOPIC: [topic name]\\n\\nHOOK (0-30s): ...\\n\\nBODY: ...\\n\\nCTA: ...'>"
}`;

  const res = await getAI().chat.completions.create({
    model: MODEL,
    max_tokens: 1200,
    temperature: 0.5,
    messages: [{ role: 'user', content: prompt }],
  });

  const parsed = parseJsonSafe(res.choices[0]?.message?.content ?? '');

  const report: CompetitorGapReport = {
    niche,
    videosAnalysed: videos.length,
    topTopics: parsed.topTopics ?? [],
    missedTopics: parsed.missedTopics ?? [],
    overservedTopics: parsed.overservedTopics ?? [],
    avgEngagementRate: parseFloat(avgEngagement.toFixed(2)),
    titlePatterns: parsed.titlePatterns ?? [],
    opportunityScore: parsed.opportunityScore ?? 50,
    scriptTemplate: parsed.scriptTemplate ?? '',
    topVideoIds: videos.map(v => v.videoId),
  };

  await cache.set(cacheKey, report, 3600 * 6);

  // Persist to DB (fire-and-forget)
  (prisma as any).competitor_analyses.upsert({
    where: { id: `${userId}_${niche}`.replace(/[^a-z0-9]/gi, '') },
    update: { gap_report: report as any, expires_at: new Date(Date.now() + 6 * 3600_000) },
    create: {
      user_id: userId,
      niche,
      video_ids: videos.map(v => v.videoId),
      gap_report: report as any,
      expires_at: new Date(Date.now() + 6 * 3600_000),
    },
  }).catch((e: any) => logger.warn({ e }, 'Competitor gap DB save failed'));

  return report;
};

const buildEmptyGapReport = (niche: string): CompetitorGapReport => ({
  niche,
  videosAnalysed: 0,
  topTopics: [],
  missedTopics: [],
  overservedTopics: [],
  avgEngagementRate: 0,
  titlePatterns: [],
  opportunityScore: 50,
  scriptTemplate: '',
  topVideoIds: [],
});

const parseJsonSafe = (raw: string): any => {
  try {
    return JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch {
    return {};
  }
};
