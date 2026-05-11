import OpenAI from 'openai';
import axios from 'axios';
import { ApifyClient } from 'apify-client';
import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';
import type { CompetitorGapReport } from '../types/videoIntelligence.types';

// ── AI client ──────────────────────────────────────────────────────────────────
let _openai: OpenAI | null = null;
const getAI = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 60_000 });
  return _openai;
};

const MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const YT_KEY  = process.env.YOUTUBE_API_KEY;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

// ── Normalised content item (platform-agnostic) ────────────────────────────────
interface ContentItem {
  platform: 'youtube' | 'instagram';
  id: string;
  title: string;
  views: number;
  likes: number;
  comments: number;
  tags: string[];
  description: string;
  duration?: string;
  engagementRate: number;
}

// ── Platform connection check ──────────────────────────────────────────────────
interface PlatformConnections {
  instagram: { connected: boolean; handle: string | null };
  youtube:   { connected: boolean; handle: string | null };
}

async function getUserConnections(userId: string): Promise<PlatformConnections> {
  const rows = await prisma.account_connections.findMany({
    where: { user_id: userId, platform: { in: ['instagram', 'youtube'] } },
    select: { platform: true, handle: true },
  });

  const result: PlatformConnections = {
    instagram: { connected: false, handle: null },
    youtube:   { connected: false, handle: null },
  };

  for (const row of rows) {
    if (row.platform === 'instagram') result.instagram = { connected: true, handle: row.handle };
    if (row.platform === 'youtube')   result.youtube   = { connected: true, handle: row.handle };
  }

  return result;
}

// ── Source 1: Instagram Reels via Apify ───────────────────────────────────────
async function fetchTopNicheReels(niche: string, count = 10): Promise<ContentItem[]> {
  const cacheKey = `competitor_reels:${niche}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as ContentItem[];

  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    logger.warn('APIFY_API_TOKEN not set — skipping Instagram reel scraping');
    return [];
  }

  try {
    const client = new ApifyClient({ token });

    const run = await client.actor('apify/instagram-hashtag-scraper').call({
      hashtags: [
        niche.replace(/\s+/g, '').toLowerCase(),
        `${niche.replace(/\s+/g, '').toLowerCase()}india`,
      ],
      resultsLimit: count * 2,
      timeoutSecs: 60,
      memoryMbytes: 256,
    });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    const reels: ContentItem[] = (items as any[])
      .filter((p: any) => p.isVideo || p.type === 'Video' || p.videoUrl)
      .sort((a: any, b: any) =>
        (b.videoPlayCount || b.videoViewCount || 0) - (a.videoPlayCount || a.videoViewCount || 0)
      )
      .slice(0, count)
      .map((p: any) => {
        const views    = p.videoPlayCount || p.videoViewCount || 0;
        const likes    = p.likesCount || p.likes || 0;
        const comments = p.commentsCount || p.comments || 0;
        const caption  = p.caption || p.text || '';
        const hashtags = (caption.match(/#[\wऀ-ॿ]+/g) || []).map((h: string) => h.slice(1));

        return {
          platform: 'instagram',
          id: p.shortCode || p.id || '',
          title: caption.replace(/#[\wऀ-ॿ]+/g, '').trim().slice(0, 120) || 'No caption',
          views,
          likes,
          comments,
          tags: hashtags.slice(0, 10),
          description: caption.slice(0, 300),
          duration: 'reel',
          engagementRate: views > 0 ? parseFloat(((likes + comments) / views * 100).toFixed(2)) : 0,
        };
      });

    await cache.set(cacheKey, reels, 3600 * 6);
    logger.info({ niche, count: reels.length }, 'Instagram reels fetched for competitor gap');
    return reels;

  } catch (err: any) {
    logger.warn({ err: err.message, niche }, 'Apify Instagram reel scrape failed for competitor gap');
    return [];
  }
}

// ── Source 2: YouTube Videos via YouTube Data API ─────────────────────────────
async function fetchTopNicheVideos(niche: string, count = 10): Promise<ContentItem[]> {
  const cacheKey = `competitor_videos:${niche}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as ContentItem[];

  if (!YT_KEY) {
    logger.warn('YOUTUBE_API_KEY not configured');
    return [];
  }

  try {
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

    const statsRes = await axios.get(`${YT_BASE}/videos`, {
      params: { key: YT_KEY, id: videoIds, part: 'snippet,statistics,contentDetails' },
      timeout: 10_000,
    });

    const videos: ContentItem[] = (statsRes.data.items ?? []).map((v: any) => {
      const views    = parseInt(v.statistics.viewCount ?? '0');
      const likes    = parseInt(v.statistics.likeCount ?? '0');
      const comments = parseInt(v.statistics.commentCount ?? '0');
      return {
        platform: 'youtube',
        id: v.id,
        title: v.snippet.title,
        views,
        likes,
        comments,
        tags: (v.snippet.tags ?? []).slice(0, 10),
        description: (v.snippet.description ?? '').slice(0, 300),
        duration: v.contentDetails.duration,
        engagementRate: views > 0 ? parseFloat(((likes + comments) / views * 100).toFixed(2)) : 0,
      };
    });

    await cache.set(cacheKey, videos, 3600 * 6);
    return videos;

  } catch (err: any) {
    logger.warn({ err: err.message, niche }, 'YouTube video fetch failed for competitor gap');
    return [];
  }
}

// ── AI gap analysis ────────────────────────────────────────────────────────────
function buildGapPrompt(niche: string, items: ContentItem[], platforms: string[]): string {
  const summaries = items
    .map((v, i) => {
      const label   = v.platform === 'instagram' ? '🎬 Instagram Reel' : '📺 YouTube Video';
      const engStr  = v.engagementRate > 0 ? ` | Engagement: ${v.engagementRate}%` : '';
      return `${i + 1}. [${label}] "${v.title}" | ${v.views.toLocaleString()} views${engStr} | Tags: ${v.tags.slice(0, 6).join(', ')}`;
    })
    .join('\n');

  const platformNote = platforms.length > 1
    ? `Data sourced from both Instagram Reels and YouTube — find gaps across BOTH platforms.`
    : `Data sourced from ${platforms[0]}.`;

  return `You are ARIA — India's content strategy engine. Analyse these ${items.length} top-performing ${niche} content pieces from India.

${platformNote}

TOP CONTENT:
${summaries}

Find the CONTENT GAPS — topics NONE of these creators have covered that a smart Indian creator could own.

RESPOND ONLY with this exact JSON (no markdown, no preamble):
{
  "topTopics": ["<topic multiple pieces covered — saturated>"],
  "missedTopics": ["<topic NONE of the ${items.length} covered — golden opportunity for Indian creators>"],
  "overservedTopics": ["<topic 70%+ of content covered — avoid>"],
  "titlePatterns": ["<hook/title formula used, e.g. 'How I [verb]ed X in [time] with ₹Y'>"],
  "opportunityScore": <0-100, 100=massive untapped gap>,
  "scriptTemplate": "<3-paragraph script outline for the best missed topic. Format: 'TOPIC: [name]\\n\\nHOOK (0-30s): ...\\n\\nBODY: ...\\n\\nCTA: ...'>"
}`;
}

const parseJsonSafe = (raw: string): any => {
  try {
    return JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch {
    return {};
  }
};

// ── Main export ────────────────────────────────────────────────────────────────
export const runCompetitorGapAnalysis = async (
  niche: string,
  userId: string,
): Promise<CompetitorGapReport> => {
  const cacheKey = `gap_report:${niche}:${userId}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as CompetitorGapReport;

  // 1. Detect connected platforms
  const connections = await getUserConnections(userId);
  const useInstagram = connections.instagram.connected;
  const useYouTube   = connections.youtube.connected;

  logger.info({ userId, niche, useInstagram, useYouTube }, 'Competitor gap: platform detection');

  // 2. Fetch content in parallel; YouTube always runs as fallback when neither is connected
  const [reels, videos] = await Promise.all([
    useInstagram ? fetchTopNicheReels(niche, 10) : Promise.resolve([]),
    (useYouTube || (!useInstagram && !useYouTube))
      ? fetchTopNicheVideos(niche, 10)
      : Promise.resolve([]),
  ]);

  // 3. Merge and rank by views
  const allItems: ContentItem[] = [...reels, ...videos]
    .sort((a, b) => b.views - a.views)
    .slice(0, 15);

  if (allItems.length === 0) {
    return buildEmptyGapReport(niche);
  }

  // 4. Track contributing platforms
  const platforms: string[] = [];
  if (reels.length > 0)  platforms.push('Instagram Reels');
  if (videos.length > 0) platforms.push('YouTube');

  // 5. Avg engagement across all items
  const avgEngagementRate = parseFloat(
    (allItems.reduce((s, v) => s + v.engagementRate, 0) / allItems.length).toFixed(2)
  );

  // 6. AI analysis
  const prompt = buildGapPrompt(niche, allItems, platforms);
  const res = await getAI().chat.completions.create({
    model: MODEL,
    max_tokens: 1200,
    temperature: 0.5,
    messages: [{ role: 'user', content: prompt }],
  });

  const parsed = parseJsonSafe(res.choices[0]?.message?.content ?? '');

  // 7. Assemble report
  const report: CompetitorGapReport = {
    niche,
    videosAnalysed:      allItems.length,
    platformsAnalysed:   platforms,
    instagramReelsCount: reels.length,
    youtubeVideosCount:  videos.length,
    topTopics:           parsed.topTopics        ?? [],
    missedTopics:        parsed.missedTopics      ?? [],
    overservedTopics:    parsed.overservedTopics  ?? [],
    avgEngagementRate,
    titlePatterns:       parsed.titlePatterns     ?? [],
    opportunityScore:    parsed.opportunityScore  ?? 50,
    scriptTemplate:      parsed.scriptTemplate    ?? '',
    topVideoIds:         videos.map(v => v.id),
    topReelIds:          reels.map(r => r.id),
  };

  await cache.set(cacheKey, report, 3600 * 6);

  // 8. Persist (fire-and-forget)
  prisma.competitor_analyses.upsert({
    where: { user_id_niche: { user_id: userId, niche } },
    update: {
      gap_report: report as any,
      video_ids: videos.map((v: any) => v.id),
      reel_ids: reels.map((r: any) => r.id),
      expires_at: new Date(Date.now() + 6 * 3600_000),
    },
    create: {
      user_id: userId,
      niche,
      video_ids: videos.map((v: any) => v.id),
      reel_ids: reels.map((r: any) => r.id),
      gap_report: report as any,
      expires_at: new Date(Date.now() + 6 * 3600_000),
    },
  }).catch((e: any) => logger.warn({ e }, 'Competitor gap DB save failed'));

  logger.info({ niche, userId, platforms, totalItems: allItems.length }, 'Competitor gap analysis complete');
  return report;
};

const buildEmptyGapReport = (niche: string): CompetitorGapReport => ({
  niche,
  videosAnalysed:      0,
  platformsAnalysed:   [],
  instagramReelsCount: 0,
  youtubeVideosCount:  0,
  topTopics:           [],
  missedTopics:        [],
  overservedTopics:    [],
  avgEngagementRate:   0,
  titlePatterns:       [],
  opportunityScore:    50,
  scriptTemplate:      '',
  topVideoIds:         [],
  topReelIds:          [],
});
