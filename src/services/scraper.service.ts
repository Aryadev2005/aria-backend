import { prisma } from "../config/database";
import { logger } from "../utils/logger";
import { scrapeInstagramWithApify } from './apify.service';

export interface ScrapedPost {
  type: "reel" | "photo" | "video" | string;
  likes?: number;
  comments?: number;
  caption?: string;
}

export interface ScrapedData {
  posts: ScrapedPost[];
  followers: number;
  postsPerWeek?: number;
  topHashtags?: string[];
  error?: string;
  isPrivate?: boolean;
}

export interface ScrapedSummary {
  totalPostsAnalyzed: number;
  postTypeMix: string;
  avgLikes: number;
  avgComments: number;
  postsPerWeek: number;
  avgCaptionLength: number;
  topHashtags: string[];
  bestPostType: string;
  worstPostType: string;
  followerCount: number;
}

/**
 * Compute engagement rate from posts
 * Formula: (avg_likes + avg_comments) / followers * 100
 */
export const computeEngagementRate = (
  posts: ScrapedPost[],
  followers: number,
): number => {
  if (!posts || !posts.length || !followers) return 0;

  const avgLikes =
    posts.reduce((sum, p) => sum + (p.likes || 0), 0) / posts.length;
  const avgComments =
    posts.reduce((sum, p) => sum + (p.comments || 0), 0) / posts.length;

  return parseFloat((((avgLikes + avgComments) / followers) * 100).toFixed(2));
};

/**
 * Build the scrapedSummary object that ARIA expects
 * Contains aggregate statistics for archetype detection
 */
export const buildScrapedSummary = (rawData: ScrapedData): ScrapedSummary => {
  const posts = rawData.posts || [];

  if (!posts.length) {
    return {
      totalPostsAnalyzed: 0,
      postTypeMix: "No posts found",
      avgLikes: 0,
      avgComments: 0,
      postsPerWeek: 0,
      avgCaptionLength: 0,
      topHashtags: [],
      bestPostType: "unknown",
      worstPostType: "unknown",
      followerCount: rawData.followers || 0,
    };
  }

  const reels = posts.filter((p) => p.type === "reel" || p.type === "video");
  const photos = posts.filter((p) => p.type === "photo");

  const totalLikes = posts.reduce((sum, p) => sum + (p.likes || 0), 0);
  const totalComments = posts.reduce((sum, p) => sum + (p.comments || 0), 0);

  const avgLikes = Math.round(totalLikes / posts.length);
  const avgComments = Math.round(totalComments / posts.length);

  const reelPercentage = Math.round((reels.length / posts.length) * 100);
  const photoPercentage = Math.round((photos.length / posts.length) * 100);

  const avgCaptionLength = Math.round(
    posts.reduce((sum, p) => sum + (p.caption?.length || 0), 0) / posts.length,
  );

  const bestPostType = reels.length >= photos.length ? "reel" : "photo";
  const worstPostType = reels.length >= photos.length ? "photo" : "reel";

  return {
    totalPostsAnalyzed: posts.length,
    postTypeMix: `${reelPercentage}% reels, ${photoPercentage}% photos`,
    avgLikes,
    avgComments,
    postsPerWeek: rawData.postsPerWeek || 0,
    avgCaptionLength,
    topHashtags: rawData.topHashtags?.slice(0, 10) || [],
    bestPostType,
    worstPostType,
    followerCount: rawData.followers || 0,
  };
};

/**
 * Scrape Instagram profile and save to database.
 * Uses Apify actors for public profile scraping — no OAuth needed.
 *
 * Returns: { followers, engagement_rate, scraped_summary, _richData }
 * Throws: Error if scraping fails (worker will log and continue)
 */
export const scrapeAndSaveProfile = async (
  userId: string,
  handle: string,
  platform: string,
) => {
  if (!userId || !handle) throw new Error('userId and handle are required');
  if (platform !== 'instagram' && platform !== 'youtube') {
    throw new Error(`Platform ${platform} not supported`);
  }
  if (platform !== 'instagram') {
    throw new Error(`${platform} scraping not implemented in this path`);
  }

  logger.info({ userId, handle }, 'scraper.service: starting Apify scrape');

  // ── Call Apify scraper ────────────────────────────────────────────────────
  const scraped = await scrapeInstagramWithApify(handle, 50);

  // ── Build scraped_summary (same shape the rest of the codebase expects) ──
  const scrapedSummary = {
    totalPostsAnalyzed: scraped.totalPostsAnalyzed,
    postTypeMix: `${scraped.reelCount} reels, ${scraped.photoCount} photos`,
    avgLikes: scraped.avgLikes,
    avgComments: scraped.avgComments,
    avgViews: scraped.avgViews,
    postsPerWeek: scraped.postsPerWeek,
    topHashtags: scraped.topHashtags,
    topMentions: scraped.topMentions,
    topLocations: scraped.topLocations,
    taggedBrands: scraped.taggedBrands,
    bestPostType: scraped.reelCount >= scraped.photoCount ? 'reel' : 'photo',
    worstPostType: scraped.reelCount >= scraped.photoCount ? 'photo' : 'reel',
    followerCount: scraped.followers,
    biography: scraped.biography,
    businessCategory: scraped.businessCategory,
    isVerified: scraped.isVerified,
    allCaptions: scraped.allCaptions,
  };

  // ── Compute engagement rate ───────────────────────────────────────────────
  const engagementRate = parseFloat(scraped.engagementRate) || 0;

  // ── Save to DB ────────────────────────────────────────────────────────────
  await (prisma as any).users.update({
    where: { id: userId },
    data: {
      instagram_handle: scraped.handle,
      follower_count:   scraped.followers,
      engagement_rate:  engagementRate,
      scraped_at:       new Date(),
      scraped_summary:  scrapedSummary,
      bio:              scraped.biography || null,
    },
  });

  logger.info({ userId, handle, posts: scraped.totalPostsAnalyzed }, 'scraper.service: saved to DB');

  return {
    followers: scraped.followers,
    engagement_rate: engagementRate.toString(),
    scraped_summary: scrapedSummary,
    // Pass these through so triggerNicheDetection can use them directly
    _richData: scraped,
  };
};
