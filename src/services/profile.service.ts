import OpenAI from 'openai';
import axios from 'axios';
import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';
import { User } from '../types';
import * as scraperService from './scraper.service';

let _openai: OpenAI | null = null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const groq = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!_openai) _openai = new OpenAI({ apiKey });
  return _openai;
};

export interface YouTubeVideoAnalytics {
  title: string;
  videoId: string;
  thumbnail: string;
  views: number;
  likes: number;
  comments: number;
  publishedAt: string;
}

export interface CreatorAnalytics {
  platform: 'youtube' | 'instagram';
  handle: string;
  channelName?: string;
  channelId?: string;
  followers: number;
  totalViews?: number;
  videoCount?: number;
  avgViewsPerVideo?: number;
  engagementRate: string | number;
  uploadFrequency?: string;
  estimatedCPM?: string;
  estimatedMonthlyRevenue?: string;
  topVideos?: any[];
  topVideoTitle?: string;
  topVideoViews?: number;
  topHashtags?: string[];
  topPosts?: string[];
  postsAnalyzed?: number;
  postingFrequency?: string;
  avgLikes?: number;
  avgComments?: number;
  captionStyle?: string;
  followerRange: string;
  dataSource: string;
  scrapedAt?: Date | string | null;
  ariaIntelligence?: any;
  fromCache?: boolean;
}

// ─── PLATFORM ROUTER ─────────────────────────────────────────────────────────
/**
 * Single entry point — routes to correct platform handler
 */
export const getCreatorAnalytics = async (userId: string, user: User): Promise<CreatorAnalytics> => {
  const platform = user.primary_platform || (user as any).primaryPlatform || 'instagram';
  const cacheKey = `profile:analytics:${userId}`;

  // Try cache first (15min TTL)
  try {
    const cached = await cache.get(cacheKey) as CreatorAnalytics | null;
    if (cached) return { ...cached, fromCache: true };
  } catch (_) {}

  let analytics: CreatorAnalytics;

  if (platform === 'youtube') {
    analytics = await getYouTubeAnalytics(user);
  } else {
    analytics = await getInstagramAnalytics(user);
  }

  // Generate ARIA intelligence on top of real data
  const ariaIntelligence = await generateARIAIntelligence(analytics, user);
  const result: CreatorAnalytics = { ...analytics, ariaIntelligence, fromCache: false };

  // Cache for 15 minutes
  try { await cache.set(cacheKey, result, 900); } catch (_) {}

  return result;
};

// ─── YOUTUBE ANALYTICS ───────────────────────────────────────────────────────
export const getYouTubeAnalytics = async (user: User): Promise<CreatorAnalytics> => {
  const apiKey  = process.env.YOUTUBE_API_KEY;
  const handle  = user.youtube_handle;

  if (!apiKey)  throw new Error('YOUTUBE_API_KEY not configured');
  if (!handle)  throw new Error('No YouTube handle connected');

  try {
    // Step 1: Find channel by handle
    const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: handle, type: 'channel', maxResults: 1, key: apiKey },
      timeout: 10000,
    });

    const channelId = searchRes.data?.items?.[0]?.id?.channelId;
    if (!channelId) throw new Error(`Channel not found for handle: ${handle}`);

    // Step 2: Get channel statistics
    const [statsRes, videosRes] = await Promise.all([
      axios.get('https://www.googleapis.com/youtube/v3/channels', {
        params: { part: 'statistics,snippet,brandingSettings', id: channelId, key: apiKey },
        timeout: 10000,
      }),
      axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          part: 'snippet', channelId, order: 'viewCount',
          maxResults: 10, type: 'video', key: apiKey,
        },
        timeout: 10000,
      }),
    ]);

    const channel   = statsRes.data?.items?.[0];
    const stats     = channel?.statistics || {};
    const topVideos = videosRes.data?.items || [];

    const subscriberCount = parseInt(stats.subscriberCount) || 0;
    const viewCount       = parseInt(stats.viewCount)       || 0;
    const videoCount      = parseInt(stats.videoCount)      || 0;
    const avgViews        = videoCount > 0 ? Math.round(viewCount / videoCount) : 0;

    // Get video IDs to fetch individual stats
    const videoIds = topVideos.map((v: any) => v.id?.videoId).filter(Boolean).join(',');
    let videoStats: any[] = [];

    if (videoIds) {
      const vidStatsRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        params: { part: 'statistics,contentDetails', id: videoIds, key: apiKey },
        timeout: 10000,
      });
      videoStats = vidStatsRes.data?.items || [];
    }

    // Enrich top videos with stats
    const enrichedVideos = topVideos.slice(0, 5).map((v: any) => {
      const vs = videoStats.find(s => s.id === v.id?.videoId);
      return {
        title:        v.snippet?.title || '',
        videoId:      v.id?.videoId    || '',
        thumbnail:    v.snippet?.thumbnails?.medium?.url || '',
        views:        parseInt(vs?.statistics?.viewCount   || 0),
        likes:        parseInt(vs?.statistics?.likeCount   || 0),
        comments:     parseInt(vs?.statistics?.commentCount || 0),
        publishedAt:  v.snippet?.publishedAt || '',
      };
    });

    // Calculate engagement per video
    const engagementRates = enrichedVideos.map((v: any) =>
      v.views > 0 ? ((v.likes + v.comments) / v.views * 100) : 0
    );
    const avgEngagement = engagementRates.length > 0
      ? (engagementRates.reduce((a: number, b: number) => a + b, 0) / engagementRates.length).toFixed(2)
      : '0';

    // Estimate CPM by niche
    const nicheCPM: Record<string, number> = {
      finance: 220, tech: 190, education: 160, fitness: 140,
      food: 120, travel: 130, comedy: 100, fashion: 110, general: 90,
    };
    const firstNiche = user.niches && Array.isArray(user.niches) ? user.niches[0] : (user.niches as any);
    const cpm = nicheCPM[firstNiche] || 90;

    // Upload frequency (days between uploads)
    const uploadFrequency = videoCount > 1 ? `${Math.round(7 / (videoCount / 52))}x/week` : '1x/week';

    logger.info({ handle, subscriberCount, avgViews }, 'YouTube analytics fetched');

    return {
      platform:        'youtube',
      handle,
      channelName:     channel?.snippet?.title || handle,
      channelId,
      // Core stats
      followers:       subscriberCount,
      totalViews:      viewCount,
      videoCount,
      avgViewsPerVideo: avgViews,
      engagementRate:  avgEngagement,
      uploadFrequency,
      // Estimates
      estimatedCPM:       `₹${cpm}–₹${cpm + 40}`,
      estimatedMonthlyRevenue: avgViews > 0
        ? `₹${Math.round(avgViews * videoCount / 52 * 4 * (cpm / 1000)).toLocaleString('en-IN')}–₹${Math.round(avgViews * videoCount / 52 * 4 * ((cpm + 40) / 1000)).toLocaleString('en-IN')}`
        : '₹0',
      // Top content
      topVideos: enrichedVideos,
      topVideoTitle: enrichedVideos[0]?.title || '',
      topVideoViews: enrichedVideos[0]?.views || 0,
      // Profile
      followerRange: user.follower_range || _getFollowerRange(subscriberCount),
      dataSource: 'youtube_data_api_v3',
      scrapedAt: new Date().toISOString(),
    };

  } catch (err) {
    logger.error({ err, handle }, 'YouTube analytics fetch failed');
    // Return stored data from users table as fallback
    return getStoredAnalytics(user, 'youtube');
  }
};

// ─── INSTAGRAM ANALYTICS ─────────────────────────────────────────────────────
export const getInstagramAnalytics = async (user: User): Promise<CreatorAnalytics> => {
  const handle = user.instagram_handle;
  if (!handle) throw new Error('No Instagram handle connected');

  // Return stored scrape data from users table
  // (Graph API OAuth will upgrade this when approved)
  const stored = await getStoredAnalytics(user, 'instagram');

  // Try re-scraping for fresh data if last scrape > 6hrs ago
  const lastScraped = (user as any).instagram_scraped_at
    ? new Date((user as any).instagram_scraped_at)
    : null;
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  if (!lastScraped || lastScraped < sixHoursAgo) {
    // Trigger background re-scrape (non-blocking)
    triggerInstagramRescrape(user.id, handle).catch(() => {});
  }

  return stored;
};

// ─── STORED ANALYTICS FALLBACK ───────────────────────────────────────────────
/**
 * Returns what we already have in the users table from onboarding
 */
export const getStoredAnalytics = async (user: User, platform: 'youtube' | 'instagram'): Promise<CreatorAnalytics> => {
  try {
    const row = await prisma.users.findUnique({
      where: { id: user.id },
      select: {
        instagram_handle: true,
        youtube_handle: true,
        engagement_rate: true,
        scraped_summary: true,
        archetype: true,
        niches: true,
        follower_range: true,
        aria_analyzed_at: true
      }
    });

    const summary = (row?.scraped_summary as any) || {};

    if (platform === 'youtube') {
      return {
        platform: 'youtube',
        handle:   row?.youtube_handle || '',
        followers: (row as any)?.follower_count || 0,
        engagementRate: row?.engagement_rate?.toString() || '0',
        followerRange: row?.follower_range || '1K–10K',
        topVideos: summary.topPosts?.map((t: string) => ({ title: t, views: 0 })) || [],
        topVideoTitle: summary.topPosts?.[0] || '',
        videoCount: summary.totalPostsAnalyzed || 0,
        dataSource: 'stored_onboarding',
        scrapedAt: row?.aria_analyzed_at,
      };
    }

    return {
      platform: 'instagram',
      handle:   row?.instagram_handle || '',
      followers: (row as any)?.follower_count || 0,
      engagementRate: row?.engagement_rate?.toString() || '0',
      followerRange: row?.follower_range || '1K–10K',
      topHashtags: summary.topHashtags || [],
      topPosts: summary.topPosts || [],
      postsAnalyzed: summary.totalPostsAnalyzed || 0,
      postingFrequency: summary.postingFrequency || 'unknown',
      avgLikes: summary.avgLikes || 0,
      avgComments: summary.avgComments || 0,
      captionStyle: summary.captionStyle || 'mixed',
      dataSource: 'stored_onboarding',
      scrapedAt: row?.aria_analyzed_at,
    };
  } catch (err) {
    logger.warn({ err }, 'Stored analytics fetch failed');
    return { platform, handle: '', followers: 0, engagementRate: '0', dataSource: 'empty', followerRange: 'Under 1K' };
  }
};

// ─── INSTAGRAM BACKGROUND RE-SCRAPE ──────────────────────────────────────────
export const triggerInstagramRescrape = async (userId: string, handle: string) => {
  try {
    await scraperService.scrapeAndSaveProfile(userId, handle, 'instagram');
    logger.info({ userId, handle }, 'Instagram re-scrape completed');
  } catch (err) {
    logger.warn({ err, handle }, 'Instagram re-scrape failed — using stored data');
  }
};

// ─── ARIA INTELLIGENCE LAYER ─────────────────────────────────────────────────
/**
 * Generates insights on top of real platform data
 */
export const generateARIAIntelligence = async (analytics: CreatorAnalytics, user: User) => {
  const platform  = analytics.platform;
  const followers = analytics.followers || 0;
  const engagement = analytics.engagementRate || '0';

  const platformContext = platform === 'youtube'
    ? `YouTube channel with ${followers.toLocaleString('en-IN')} subscribers, ${analytics.avgViewsPerVideo?.toLocaleString('en-IN') || 0} avg views, ${analytics.uploadFrequency} upload frequency`
    : `Instagram account with ${followers.toLocaleString('en-IN')} followers, ${engagement}% engagement rate, ${analytics.postsAnalyzed || 0} posts analyzed`;

  const firstNiche = user.niches && Array.isArray(user.niches) ? user.niches[0] : (user.niches as any);

  const prompt = `You are ARIA — India's creator intelligence engine.

Generate intelligence insights for this creator:
${platformContext}
Archetype: ${user.archetype || 'EDUCATOR'}
Niche: ${firstNiche || 'general'}
Platform: ${platform}

Give sharp, specific, actionable insights. Reference their actual numbers.

Respond ONLY with valid JSON:
{
  "healthScore": 72,
  "healthLabel": "Good|Growing|Early Stage|Excellent",
  "growthStage": "DISCOVERY|GROWTH|MONETIZATION|SCALE",
  "growthStageLabel": "Human readable label",
  "strengths": [
    "Specific strength referencing their actual numbers",
    "Another specific strength"
  ],
  "gaps": [
    "Specific gap with what to do about it",
    "Another gap"
  ],
  "topOpportunity": "The single most impactful thing they can do right now — be specific",
  "monetisationReadiness": 65,
  "estimatedMonthlyEarning": "₹15,000–₹45,000",
  "nextMilestone": "What their next realistic goal should be",
  "nextMilestoneAction": "Exact action to reach that milestone",
  "ariaVerdict": "2 sentence honest assessment of where this creator stands and what matters most right now"
}`;

  try {
    const res = await groq().chat.completions.create({
      model: OPENAI_MODEL,
      max_tokens: 700,
      temperature: 0.65,
      messages: [{ role: 'user', content: prompt }],
    });
    const text  = res.choices[0].message.content;
    if (!text) throw new Error('Empty response from OpenAI');
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    logger.warn({ err }, 'ARIA intelligence generation failed — using defaults');
    return {
      healthScore: 50,
      healthLabel: 'Growing',
      growthStage: 'DISCOVERY',
      growthStageLabel: 'Building Audience',
      strengths: ['Active on social media'],
      gaps: ['Consistency needs improvement'],
      topOpportunity: 'Post consistently 3x per week to build momentum',
      monetisationReadiness: 30,
      estimatedMonthlyEarning: '₹5,000–₹15,000',
      nextMilestone: `Reach ${_getNextMilestone(analytics.followers || 0)} followers`,
      nextMilestoneAction: 'Post daily for 30 days',
      ariaVerdict: 'You are in the early stages. Focus on consistency first.',
    };
  }
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const _getFollowerRange = (count: number) => {
  if (count >= 500000) return '500K+';
  if (count >= 100000) return '100K–500K';
  if (count >= 50000)  return '50K–100K';
  if (count >= 10000)  return '10K–50K';
  if (count >= 1000)   return '1K–10K';
  return 'Under 1K';
};

const _getNextMilestone = (current: number) => {
  if (current < 1000)   return '1K';
  if (current < 5000)   return '5K';
  if (current < 10000)  return '10K';
  if (current < 50000)  return '50K';
  if (current < 100000) return '100K';
  return '500K';
};
