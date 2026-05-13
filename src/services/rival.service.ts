// src/services/rival.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Rival Spy Service — 4-stage competitor intelligence pipeline
//
// Stage 1: resolveHandles()     — username → profile ID per platform
// Stage 2: harvestTopContent()  — top 5 posts per profile via Apify/YouTube API
// Stage 3: scorePosts()         — Video DNA scoring on each harvested post
// Stage 4: extractPatterns()    — GPT-4o-mini cross-competitor pattern analysis
//                                 + live_trends cross-reference for freshness badges
// ══════════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import { ApifyClient } from 'apify-client';
import OpenAI from 'openai';
import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';
import { computeVideoDNAReport } from './videoDnaScoring.service';
import { getVoicePortrait } from './voice.service';

const YT_KEY = process.env.YOUTUBE_API_KEY;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

let _openai: OpenAI | null = null;
const getAI = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY required');
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 30_000 });
  return _openai;
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RivalHandle {
  raw: string;           // original input e.g. "@filmyvaibhav" or "youtube.com/c/..."
  platform: 'instagram' | 'youtube';
  username: string;      // cleaned username without @ or URL
  resolved: boolean;
  profileId?: string;    // channel ID for YouTube, username for Instagram
  displayName?: string;
  followers?: number;
  error?: string;
}

export interface RivalPost {
  postId: string;
  platform: 'instagram' | 'youtube';
  competitorHandle: string;
  title: string;
  caption: string;
  hookText: string;       // first 120 chars of caption/title
  views: number;
  likes: number;
  comments: number;
  engagementRate: number;
  tags: string[];
  format: string;         // 'reel' | 'video' | 'short'
  thumbnailUrl?: string;
  postUrl?: string;
  publishedAt: string;
  dnaScore?: number;      // from computeVideoDNAReport
  dnaGrade?: string;
  hookScore?: number;
  contentQualityScore?: number;
}

export interface NichePattern {
  type: 'topic' | 'hook_formula' | 'format' | 'gap';
  label: string;
  description: string;
  frequency: number;      // how many competitors used this
  totalCompetitors: number;
  examplePostIds: string[];
  trendBadge?: 'RISING' | 'HOT' | 'COOLING' | 'STABLE' | null;
  trendSource?: string;
}

export interface StealCard {
  post: RivalPost;
  stealAngle: string;     // one sentence: what structural element to steal
  suggestedIdea: string;  // pre-filled Studio idea string
  suggestedAngle: string; // pre-filled Studio angle string
  voiceRulesApplied: string[]; // e.g. ['Hinglish ✓', 'Short sentences ✓']
}

export interface RivalIntelReport {
  handles: RivalHandle[];
  totalPostsAnalysed: number;
  nichePatterns: NichePattern[];
  stealCards: StealCard[];   // top 5 posts with steal metadata
  gapOpportunities: string[]; // topics nobody covered
  overservedTopics: string[];
  avgDnaScore: number;
  topDnaPost: RivalPost | null;
  generatedAt: string;
}

// ── Stage 1: Resolve handles ──────────────────────────────────────────────────

function detectPlatform(raw: string): 'instagram' | 'youtube' {
  const lower = raw.toLowerCase();
  if (
    lower.includes('youtube.com') ||
    lower.includes('youtu.be') ||
    lower.includes('/c/') ||
    lower.includes('/channel/') ||
    lower.includes('/user/')
  ) {
    return 'youtube';
  }
  return 'instagram';
}

function cleanUsername(raw: string, platform: 'instagram' | 'youtube'): string {
  let u = raw.trim().replace(/^@/, '');
  if (platform === 'youtube') {
    u = u
      .replace(/https?:\/\/(www\.)?youtube\.com\/(c\/|channel\/|user\/|@)?/, '')
      .replace(/https?:\/\/youtu\.be\//, '')
      .replace(/\/$/, '');
  }
  return u;
}

async function resolveYouTubeHandle(username: string): Promise<Partial<RivalHandle>> {
  if (!YT_KEY) return { resolved: false, error: 'YouTube API key not configured' };
  try {
    const res = await axios.get(`${YT_BASE}/search`, {
      params: { key: YT_KEY, q: username, type: 'channel', part: 'snippet', maxResults: 1 },
      timeout: 8000,
    });
    const channel = res.data.items?.[0];
    if (!channel) return { resolved: false, error: `Channel not found: ${username}` };
    return {
      resolved: true,
      profileId: channel.id?.channelId || channel.snippet?.channelId,
      displayName: channel.snippet?.channelTitle,
    };
  } catch (err: any) {
    return { resolved: false, error: err.message };
  }
}

export async function resolveHandles(
  rawHandles: string[],
  forcePlatform?: 'instagram' | 'youtube',
): Promise<RivalHandle[]> {
  return Promise.all(
    rawHandles
      .filter(h => h.trim().length > 0)
      .slice(0, 8)
      .map(async (raw): Promise<RivalHandle> => {
        const platform = forcePlatform ?? detectPlatform(raw);
        const username = cleanUsername(raw, platform);
        const base: RivalHandle = { raw, platform, username, resolved: false };

        if (platform === 'youtube') {
          const resolved = await resolveYouTubeHandle(username);
          return { ...base, ...resolved };
        }
        // Instagram: username IS the handle for Apify — no resolution needed
        return { ...base, resolved: true, profileId: username, displayName: username };
      }),
  );
}

// ── Stage 2: Harvest top content ──────────────────────────────────────────────

async function harvestInstagramPosts(handle: RivalHandle, count = 5): Promise<RivalPost[]> {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return [];

  const cacheKey = `rival_ig:${handle.username}:${count}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as RivalPost[];

  try {
    const client = new ApifyClient({ token });
    const run = await client.actor('apify/instagram-profile-scraper').call({
      usernames: [handle.username],
      resultsLimit: count * 3,
    }, { timeout: 90, memory: 256 });

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    const profile = items?.[0] as any;
    if (!profile || profile.isPrivate) return [];

    const posts: RivalPost[] = (profile.latestPosts || [])
      .filter((p: any) => p.isVideo || p.type === 'Video')
      .sort(
        (a: any, b: any) =>
          (b.videoViewCount || b.videoPlayCount || 0) - (a.videoViewCount || a.videoPlayCount || 0),
      )
      .slice(0, count)
      .map((p: any): RivalPost => {
        const views = p.videoViewCount || p.videoPlayCount || 0;
        const likes = p.likesCount || 0;
        const comments = p.commentsCount || 0;
        const caption = p.caption || '';
        const hookText = caption.replace(/#[\wऀ-ॿ]+/g, '').trim().slice(0, 120);
        const tags = (caption.match(/#[\wऀ-ॿ]+/g) || []).map((h: string) => h.slice(1));
        return {
          postId: p.shortCode || p.id || '',
          platform: 'instagram',
          competitorHandle: handle.username,
          title: hookText || 'No caption',
          caption,
          hookText,
          views,
          likes,
          comments,
          engagementRate:
            views > 0 ? parseFloat(((likes + comments) / views * 100).toFixed(2)) : 0,
          tags: tags.slice(0, 10),
          format: 'reel',
          thumbnailUrl: p.displayUrl || '',
          postUrl: `https://instagram.com/p/${p.shortCode}`,
          publishedAt: p.timestamp || new Date().toISOString(),
        };
      });

    await cache.set(cacheKey, posts, 3600 * 6);
    return posts;
  } catch (err: any) {
    logger.warn({ err: err.message, handle: handle.username }, 'rival: Instagram harvest failed');
    return [];
  }
}

async function harvestYouTubePosts(handle: RivalHandle, count = 5): Promise<RivalPost[]> {
  if (!YT_KEY || !handle.profileId) return [];

  const cacheKey = `rival_yt:${handle.profileId}:${count}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as RivalPost[];

  try {
    const searchRes = await axios.get(`${YT_BASE}/search`, {
      params: {
        key: YT_KEY,
        channelId: handle.profileId,
        type: 'video',
        part: 'snippet',
        maxResults: count * 2,
        order: 'viewCount',
      },
      timeout: 10_000,
    });
    const videoIds = (searchRes.data.items || [])
      .map((i: any) => i.id?.videoId)
      .filter(Boolean)
      .join(',');
    if (!videoIds) return [];

    const statsRes = await axios.get(`${YT_BASE}/videos`, {
      params: { key: YT_KEY, id: videoIds, part: 'snippet,statistics,contentDetails' },
      timeout: 10_000,
    });

    const posts: RivalPost[] = (statsRes.data.items || []).slice(0, count).map(
      (v: any): RivalPost => {
        const views = parseInt(v.statistics.viewCount || '0');
        const likes = parseInt(v.statistics.likeCount || '0');
        const comments = parseInt(v.statistics.commentCount || '0');
        const durationMatch = v.contentDetails?.duration?.match(/PT(\d+)S$/);
        const isShort = durationMatch && parseInt(durationMatch[1]) <= 60;
        return {
          postId: v.id,
          platform: 'youtube',
          competitorHandle: handle.username,
          title: v.snippet.title,
          caption: v.snippet.description?.slice(0, 300) || '',
          hookText: v.snippet.title,
          views,
          likes,
          comments,
          engagementRate:
            views > 0 ? parseFloat(((likes + comments) / views * 100).toFixed(2)) : 0,
          tags: (v.snippet.tags || []).slice(0, 10),
          format: isShort ? 'short' : 'video',
          thumbnailUrl: v.snippet.thumbnails?.high?.url || '',
          postUrl: `https://youtube.com/watch?v=${v.id}`,
          publishedAt: v.snippet.publishedAt,
        };
      },
    );

    await cache.set(cacheKey, posts, 3600 * 6);
    return posts;
  } catch (err: any) {
    logger.warn({ err: err.message, handle: handle.username }, 'rival: YouTube harvest failed');
    return [];
  }
}

export async function harvestTopContent(handles: RivalHandle[]): Promise<RivalPost[]> {
  const resolved = handles.filter(h => h.resolved);
  const results = await Promise.allSettled(
    resolved.map(h =>
      h.platform === 'instagram'
        ? harvestInstagramPosts(h, 5)
        : harvestYouTubePosts(h, 5),
    ),
  );
  return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
}

// ── Stage 3: Score posts with Video DNA ───────────────────────────────────────

export async function scorePosts(posts: RivalPost[], niche: string): Promise<RivalPost[]> {
  const scored = await Promise.allSettled(
    posts.map(async (post): Promise<RivalPost> => {
      try {
        const durationSecs =
          post.format === 'reel' || post.format === 'short' ? 30 : 300;
        const report = await computeVideoDNAReport(
          {
            ariaInsight: '',
            benchmarkAnalysis: '',
            betterTitle: null,
            improvedHook: null,
            actionItems: [],
            nextVideoSuggestion: '',
            nextVideoReason: '',
            shortsOpportunities: [],
            benchmarkStats: [],
          },
          post.views,
          post.likes,
          post.comments,
          durationSecs,
          niche,
          post.publishedAt,
          '22',
          post.title,
        );
        return {
          ...post,
          dnaScore: report.overallScore,
          dnaGrade: report.grade,
          hookScore: report.hookScore,
          contentQualityScore: report.contentQualityScore,
        };
      } catch {
        return post;
      }
    }),
  );
  return scored.map((r, i) => (r.status === 'fulfilled' ? r.value : posts[i]));
}

// ── Stage 4: Extract patterns ─────────────────────────────────────────────────

async function getLiveTrendBadge(
  topic: string,
): Promise<{ badge: string | null; source: string | null }> {
  try {
    const trend = await (prisma as any).live_trends.findFirst({
      where: {
        expires_at: { gt: new Date() },
        title: { contains: topic.split(' ')[0], mode: 'insensitive' },
      },
      orderBy: { velocity: 'desc' },
      select: { badge: true, source: true },
    });
    return { badge: trend?.badge || null, source: trend?.source || null };
  } catch {
    return { badge: null, source: null };
  }
}

async function buildStealCards(
  posts: RivalPost[],
  voicePortrait: any | null,
): Promise<StealCard[]> {
  const top5 = [...posts]
    .sort((a, b) => (b.dnaScore || 0) - (a.dnaScore || 0))
    .slice(0, 5);

  return top5.map((post): StealCard => {
    const voiceRulesApplied: string[] = [];
    if (voicePortrait) {
      if (voicePortrait.preferredLanguage?.toLowerCase().includes('hindi'))
        voiceRulesApplied.push('Hinglish ✓');
      if (voicePortrait.sentenceStyle?.toLowerCase().includes('short'))
        voiceRulesApplied.push('Short sentences ✓');
      if (voicePortrait.preferredHookStyle)
        voiceRulesApplied.push(`${voicePortrait.preferredHookStyle} hook ✓`);
      if (voicePortrait.energyLevel)
        voiceRulesApplied.push(`${voicePortrait.energyLevel} energy ✓`);
    }

    const stealAngle =
      post.hookScore && post.hookScore > 70
        ? `Hook structure (${post.hookScore}/100 hook score) — reuse the opening formula`
        : post.dnaScore && post.dnaScore > 65
        ? `Overall format worked — adapt the structure to your niche`
        : `Topic angle — this subject has proven demand in your niche`;

    const suggestedIdea = `${post.hookText.slice(0, 80)} [adapted for my audience]`;
    const suggestedAngle =
      post.format === 'reel'
        ? `30-second reel inspired by competitor structure`
        : `YouTube video on proven topic`;

    return { post, stealAngle, suggestedIdea, suggestedAngle, voiceRulesApplied };
  });
}

export async function extractPatterns(
  posts: RivalPost[],
  niche: string,
): Promise<{ patterns: NichePattern[]; gaps: string[]; overserved: string[] }> {
  if (posts.length === 0) return { patterns: [], gaps: [], overserved: [] };

  const totalCompetitors = [...new Set(posts.map(p => p.competitorHandle))].length;
  const summaries = posts
    .slice(0, 20)
    .map(
      (p, i) =>
        `${i + 1}. [${p.platform}] @${p.competitorHandle} | "${p.title.slice(0, 80)}" | ${p.views.toLocaleString()} views | ER: ${p.engagementRate}% | Tags: ${p.tags.slice(0, 5).join(', ')}`,
    )
    .join('\n');

  const prompt = `You are ARIA — India's content strategy engine. Analyse these top posts from ${totalCompetitors} competitor creators in the "${niche}" niche.

TOP POSTS:
${summaries}

Extract cross-competitor patterns. Be specific to Indian creator market.

RESPOND ONLY with valid JSON, no markdown:
{
  "topics": [
    { "label": "<topic>", "frequency": <how many competitors posted on this>, "hookFormula": "<the hook pattern used e.g. 'How I X in Y days'>", "examplePostIndices": [<1-based indices>] }
  ],
  "hookFormulas": [
    { "formula": "<the hook structure>", "frequency": <count>, "examplePostIndices": [<indices>] }
  ],
  "missedTopics": ["<topic NONE of the ${totalCompetitors} competitors covered — golden gap>"],
  "overservedTopics": ["<topic covered by 70%+ of competitors — saturated>"]
}`;

  try {
    const res = await getAI().chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      max_tokens: 1000,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (res.choices[0]?.message?.content || '')
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    const parsed = JSON.parse(raw);

    const patterns: NichePattern[] = [];

    for (const topic of (parsed.topics || []).slice(0, 6)) {
      const { badge, source } = await getLiveTrendBadge(topic.label);
      patterns.push({
        type: 'topic',
        label: topic.label,
        description: topic.hookFormula || '',
        frequency: topic.frequency || 1,
        totalCompetitors,
        examplePostIds: (topic.examplePostIndices || [])
          .map((i: number) => posts[i - 1]?.postId)
          .filter(Boolean),
        trendBadge: badge as any,
        trendSource: source || undefined,
      });
    }

    for (const hook of (parsed.hookFormulas || []).slice(0, 4)) {
      patterns.push({
        type: 'hook_formula',
        label: hook.formula,
        description: `Used by ${hook.frequency} creators`,
        frequency: hook.frequency || 1,
        totalCompetitors,
        examplePostIds: (hook.examplePostIndices || [])
          .map((i: number) => posts[i - 1]?.postId)
          .filter(Boolean),
        trendBadge: null,
      });
    }

    return {
      patterns,
      gaps: parsed.missedTopics || [],
      overserved: parsed.overservedTopics || [],
    };
  } catch (err: any) {
    logger.warn({ err: err.message }, 'rival: pattern extraction failed');
    return { patterns: [], gaps: [], overserved: [] };
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runRivalSpy(
  rawHandles: string[],
  platform: 'instagram' | 'youtube' | 'auto',
  niche: string,
  userId: string,
  onProgress: (event: { stage: string; message: string; done?: boolean }) => void,
): Promise<RivalIntelReport> {
  onProgress({ stage: 'resolve', message: 'Resolving competitor handles...' });
  const handles = await resolveHandles(
    rawHandles,
    platform === 'auto' ? undefined : platform,
  );
  const resolved = handles.filter(h => h.resolved);

  if (resolved.length === 0) {
    throw new Error(
      'Could not resolve any of the provided handles. Check usernames and try again.',
    );
  }

  onProgress({
    stage: 'harvest',
    message: `Scraping top content from ${resolved.length} creators...`,
  });
  const rawPosts = await harvestTopContent(resolved);

  if (rawPosts.length === 0) {
    throw new Error(
      'Could not scrape content from any of the provided profiles. They may be private.',
    );
  }

  onProgress({ stage: 'dna', message: `Running Video DNA on ${rawPosts.length} posts...` });
  const scoredPosts = await scorePosts(rawPosts, niche);

  onProgress({ stage: 'patterns', message: 'Detecting patterns across all creators...' });
  const { patterns, gaps, overserved } = await extractPatterns(scoredPosts, niche);

  onProgress({ stage: 'voice', message: 'Loading your voice portrait...' });
  const voicePortrait = await getVoicePortrait(userId).catch(() => null);

  onProgress({ stage: 'steal', message: 'Building Steal Cards...' });
  const stealCards = await buildStealCards(scoredPosts, voicePortrait);

  const avgDnaScore =
    scoredPosts.length > 0
      ? Math.round(
          scoredPosts.reduce((s, p) => s + (p.dnaScore || 0), 0) / scoredPosts.length,
        )
      : 0;

  const topDnaPost =
    scoredPosts.length > 0
      ? scoredPosts.reduce((best, p) => ((p.dnaScore || 0) > (best.dnaScore || 0) ? p : best))
      : null;

  const report: RivalIntelReport = {
    handles,
    totalPostsAnalysed: scoredPosts.length,
    nichePatterns: patterns,
    stealCards,
    gapOpportunities: gaps,
    overservedTopics: overserved,
    avgDnaScore,
    topDnaPost,
    generatedAt: new Date().toISOString(),
  };

  onProgress({ stage: 'done', message: 'Analysis complete.', done: true });
  return report;
}
