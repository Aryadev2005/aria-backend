/**
 * apify.service.ts
 *
 * Replaces:
 *   - instascraper.service.ts  (instatouch scraper)
 *   - scripts/scrape_instagram.py  (legacy Python subprocess)
 *
 * Uses the Apify API (via apify-client) to scrape public Instagram profiles
 * and posts. No OAuth, no Graph API tokens, no Python subprocess.
 */

import { ApifyClient } from 'apify-client';
import { logger } from '../utils/logger';

// ── Apify client singleton ────────────────────────────────────────────────
const getApifyClient = (): ApifyClient => {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw new Error('APIFY_API_TOKEN is not set in environment variables');
  }
  return new ApifyClient({ token });
};

// ── Types ─────────────────────────────────────────────────────────────────
export interface ApifyScrapedPost {
  id: string;
  shortCode: string;
  type: string;           // 'Image' | 'Video' | 'Sidecar'
  isVideo: boolean;
  likesCount: number;
  commentsCount: number;
  videoViewCount?: number;
  caption: string;
  hashtags: string[];
  mentions: string[];
  timestamp: string;
  locationName?: string;
  taggedUsers?: string[];
}

export interface ApifyScrapedResult {
  handle: string;
  followers: number;
  following: number;
  totalPosts: number;
  isPrivate: boolean;
  isVerified: boolean;
  biography: string;
  businessCategory?: string;
  externalUrl?: string;
  profilePicUrl?: string;
  posts: ApifyScrapedPost[];
  // Computed analytics
  avgLikes: number;
  avgComments: number;
  avgViews: number;
  engagementRate: string;
  topHashtags: string[];
  topMentions: string[];
  topLocations: string[];
  taggedBrands: string[];
  postsPerWeek: number;
  reelCount: number;
  photoCount: number;
  allCaptions: string[];
  totalPostsAnalyzed: number;
}

/**
 * Scrape an Instagram profile using Apify's Instagram Profile Scraper actor.
 * Returns profile metadata + recent posts with full analytics.
 */
export async function scrapeInstagramWithApify(
  handle: string,
  postCount = 50,
): Promise<ApifyScrapedResult> {
  const client = getApifyClient();

  logger.info({ handle, postCount }, 'apify.service: starting Instagram scrape');

  // ── 1. Run the Instagram Profile Scraper ──────────────────────────────────
  let profileData: any = null;
  try {
    const profileRun = await client.actor('apify/instagram-profile-scraper').call({
      usernames: [handle],
      resultsLimit: 1,
    });

    const { items: profileItems } = await client.dataset(profileRun.defaultDatasetId).listItems();
    profileData = profileItems?.[0];
  } catch (err: any) {
    logger.error({ err: err.message, handle }, 'apify.service: profile scraper failed');
    throw new Error(`Could not fetch Instagram profile for @${handle}. Account may be private or not found.`);
  }

  if (!profileData) {
    throw new Error(`Profile not found for @${handle}`);
  }

  if (profileData.isPrivate || profileData.private) {
    throw new Error(`Profile @${handle} is private. Please make your account public to connect.`);
  }

  // ── 2. Extract profile metadata ──────────────────────────────────────────
  const followers = profileData.followersCount || profileData.edge_followed_by?.count || 0;
  const following = profileData.followingCount || profileData.edge_follow?.count || 0;
  const totalPosts = profileData.postsCount || profileData.edge_owner_to_timeline_media?.count || 0;
  const biography = profileData.biography || profileData.bio || '';
  const businessCategory = profileData.businessCategoryName || profileData.categoryName || '';
  const externalUrl = profileData.externalUrl || profileData.website || '';
  const profilePicUrl = profileData.profilePicUrl || profileData.profilePicUrlHD || '';
  const isVerified = profileData.verified || profileData.isVerified || false;

  // ── 3. Run the Instagram Post Scraper ─────────────────────────────────────
  let rawPosts: any[] = [];
  try {
    const postRun = await client.actor('apify/instagram-post-scraper').call({
      username: handle,
      resultsLimit: postCount,
    });

    const { items: postItems } = await client.dataset(postRun.defaultDatasetId).listItems();
    rawPosts = postItems || [];
  } catch (err: any) {
    logger.warn({ err: err.message, handle }, 'apify.service: post scraper failed — using profile data only');
    // Try to use latestPosts from profile data if available
    rawPosts = profileData.latestPosts || [];
  }

  // ── 4. Normalize posts ────────────────────────────────────────────────────
  const posts: ApifyScrapedPost[] = rawPosts.map((p: any) => {
    const caption = p.caption || p.text || p.description || '';

    // Extract hashtags from caption
    const hashtags = (caption.match(/#[\w\u0900-\u097F]+/g) || []).map((h: string) => h.slice(1));

    // Extract mentions from caption
    const mentions = (caption.match(/@[\w.]+/g) || []).map((m: string) => m.slice(1));

    return {
      id: p.id || p.shortCode || '',
      shortCode: p.shortCode || p.code || '',
      type: p.type || (p.isVideo || p.videoUrl ? 'Video' : 'Image'),
      isVideo: !!(p.isVideo || p.videoUrl || p.type === 'Video'),
      likesCount: p.likesCount || p.likes || 0,
      commentsCount: p.commentsCount || p.comments || 0,
      videoViewCount: p.videoViewCount || p.videoPlayCount || p.views || 0,
      caption,
      hashtags,
      mentions,
      timestamp: p.timestamp || p.takenAtTimestamp || p.date || '',
      locationName: p.locationName || p.location?.name || undefined,
      taggedUsers: (p.taggedUsers || []).map((u: any) =>
        typeof u === 'string' ? u : u?.username || u?.user?.username || '',
      ).filter(Boolean),
    };
  });

  // ── 5. Compute analytics ──────────────────────────────────────────────────
  const videoPosts = posts.filter(p => p.isVideo);
  const photoPosts = posts.filter(p => !p.isVideo);

  const totalLikes = posts.reduce((sum, p) => sum + p.likesCount, 0);
  const totalComments = posts.reduce((sum, p) => sum + p.commentsCount, 0);
  const totalViews = videoPosts.reduce((sum, p) => sum + (p.videoViewCount || 0), 0);

  const avgLikes = posts.length ? totalLikes / posts.length : 0;
  const avgComments = posts.length ? totalComments / posts.length : 0;
  const avgViews = videoPosts.length ? totalViews / videoPosts.length : 0;

  // Engagement rate = (avg likes + avg comments) / followers * 100
  const engagementRate = followers > 0
    ? (((avgLikes + avgComments) / followers) * 100).toFixed(2)
    : '0';

  // Posts per week — span between oldest and newest post
  let postsPerWeek = 0;
  if (posts.length >= 2) {
    const timestamps = posts
      .map(p => new Date(p.timestamp).getTime())
      .filter(t => !isNaN(t))
      .sort((a, b) => b - a);
    if (timestamps.length >= 2) {
      const daySpan = (timestamps[0] - timestamps[timestamps.length - 1]) / (1000 * 86400);
      postsPerWeek = daySpan > 0 ? (timestamps.length / daySpan) * 7 : 0;
    }
  }

  // Top hashtags — ranked by frequency
  const hashtagFreq: Record<string, number> = {};
  posts.forEach(p => {
    p.hashtags.forEach(tag => {
      hashtagFreq[tag] = (hashtagFreq[tag] || 0) + 1;
    });
  });
  const topHashtags = Object.entries(hashtagFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag]) => tag);

  // Top @mentions
  const mentionFreq: Record<string, number> = {};
  posts.forEach(p => {
    p.mentions.forEach(m => {
      mentionFreq[m] = (mentionFreq[m] || 0) + 1;
    });
  });
  const topMentions = Object.entries(mentionFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([m]) => m);

  // Top locations
  const locationFreq: Record<string, number> = {};
  posts.forEach(p => {
    if (p.locationName) {
      locationFreq[p.locationName] = (locationFreq[p.locationName] || 0) + 1;
    }
  });
  const topLocations = Object.entries(locationFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([loc]) => loc);

  // Tagged brands (unique usernames tagged across posts)
  const taggedSet = new Set<string>();
  posts.forEach(p => {
    (p.taggedUsers || []).forEach(u => taggedSet.add(u));
  });
  const taggedBrands = Array.from(taggedSet).slice(0, 10);

  // All captions (for ARIA prompt)
  const allCaptions = posts
    .map(p => p.caption)
    .filter(c => c && c.trim().length > 10);

  logger.info(
    { handle, followers, postsScraped: posts.length, engagementRate },
    'apify.service: scrape complete',
  );

  return {
    handle,
    followers,
    following,
    totalPosts,
    isPrivate: false,
    isVerified,
    biography,
    businessCategory: businessCategory || undefined,
    externalUrl: externalUrl || undefined,
    profilePicUrl: profilePicUrl || undefined,
    posts,
    avgLikes: Math.round(avgLikes),
    avgComments: Math.round(avgComments),
    avgViews: Math.round(avgViews),
    engagementRate,
    topHashtags,
    topMentions,
    topLocations,
    taggedBrands,
    postsPerWeek: Math.round(postsPerWeek * 10) / 10,
    reelCount: videoPosts.length,
    photoCount: photoPosts.length,
    allCaptions,
    totalPostsAnalyzed: posts.length,
  };
}
