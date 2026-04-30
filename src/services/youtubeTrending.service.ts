import axios from 'axios';
import { logger } from '../utils/logger';

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Niche category IDs for YouTube India
const YT_CATEGORY_MAP: Record<string, string> = {
  '1':  'film',
  '2':  'cars',
  '10': 'music',
  '17': 'sports',
  '19': 'travel',
  '20': 'gaming',
  '22': 'general',     // People & Blogs (creators, vlogs)
  '23': 'comedy',
  '24': 'entertainment',
  '25': 'news',
  '26': 'education',   // How-to & Style
  '27': 'education',
  '28': 'tech',
};

const NICHE_KEYWORDS: Record<string, string[]> = {
  fashion:     ['fashion', 'outfit', 'ootd', 'style', 'clothes', 'makeup', 'beauty', 'nykaa', 'myntra'],
  fitness:     ['fitness', 'gym', 'workout', 'yoga', 'diet', 'weight loss', 'muscle'],
  food:        ['food', 'recipe', 'cooking', 'restaurant', 'biryani', 'street food', 'chef'],
  cricket:     ['cricket', 'ipl', 'virat', 'rohit', 'match', 'wicket'],
  bollywood:   ['bollywood', 'movie', 'actor', 'film', 'song', 'trailer'],
  tech:        ['tech', 'smartphone', 'review', 'unboxing', 'ai', 'gadget', 'laptop'],
  finance:     ['finance', 'stock', 'investment', 'zerodha', 'groww', 'mutual fund', 'crypto'],
  travel:      ['travel', 'vlog', 'trip', 'tour', 'destination', 'hotel'],
  education:   ['study', 'exam', 'upsc', 'jee', 'learn', 'tutorial', 'how to'],
  comedy:      ['funny', 'comedy', 'meme', 'roast', 'prank'],
  hustle:      ['startup', 'business', 'entrepreneur', 'shark tank', 'side hustle', 'money'],
};

/**
 * Detect niches from video title + description
 */
export const detectNiches = (text = ''): string[] => {
  const lower = text.toLowerCase();
  const niches = [];
  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) niches.push(niche);
  }
  return niches.length > 0 ? niches : ['general'];
};

/**
 * Calculate velocity score from view count + like ratio
 * Returns 0-100 score
 */
export const calculateVelocity = (viewCount: string | number, likeCount: string | number, commentCount: string | number): number => {
  const views = typeof viewCount === 'string' ? parseInt(viewCount) : viewCount || 0;
  const likes = typeof likeCount === 'string' ? parseInt(likeCount) : likeCount || 0;
  const comments = typeof commentCount === 'string' ? parseInt(commentCount) : commentCount || 0;

  if (views === 0) return 50;

  const engagementRate = ((likes + comments) / views) * 100;
  const viewScore = Math.min(50, Math.log10(views + 1) * 10);
  const engagementScore = Math.min(50, engagementRate * 10);

  return Math.round(viewScore + engagementScore);
};

export interface YouTubeTrend {
  title: string;
  search_volume: number;
  velocity: number;
  niche_tags: string[];
  platform_tags: { youtube: boolean; instagram: boolean };
  source: string;
  raw_data: {
    videoId: string;
    channelTitle: string;
    viewCount: number;
    likeCount: number;
    commentCount: number;
    categoryId: string;
    publishedAt: string;
    thumbnailUrl?: string;
  };
}

/**
 * Fetch trending videos from YouTube India
 * Returns array ready to insert into live_trends
 */
export const fetchYouTubeTrending = async (): Promise<YouTubeTrend[] | null> => {
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    logger.warn('YOUTUBE_API_KEY not set — skipping YouTube trending');
    return null;
  }

  try {
    logger.info('Fetching YouTube trending videos for India...');

    // Fetch top 50 trending videos in India
    const response = await axios.get(`${YT_API_BASE}/videos`, {
      params: {
        part: 'snippet,statistics,contentDetails',
        chart: 'mostPopular',
        regionCode: 'IN',
        maxResults: 50,
        key: apiKey,
      },
      timeout: 15000,
    });

    const videos = response.data?.items || [];

    if (videos.length === 0) {
      logger.warn('YouTube API returned 0 trending videos');
      return null;
    }

    // Transform to ARIA trend format
    const trends: YouTubeTrend[] = videos.map((video: any) => {
      const snippet    = video.snippet || {};
      const stats      = video.statistics || {};
      const title      = snippet.title || '';
      const channel    = snippet.channelTitle || '';
      const viewCount  = parseInt(stats.viewCount) || 0;
      const likeCount  = parseInt(stats.likeCount) || 0;
      const commentCount = parseInt(stats.commentCount) || 0;
      const categoryId = snippet.categoryId || '22';

      const nicheFromCategory = YT_CATEGORY_MAP[categoryId] || 'general';
      const nicheFromKeywords = detectNiches(`${title} ${snippet.description || ''}`);
      const allNiches = [...new Set([nicheFromCategory, ...nicheFromKeywords])];

      return {
        title:        title,
        search_volume: viewCount,
        velocity:     calculateVelocity(viewCount, likeCount, commentCount),
        niche_tags:   allNiches,
        platform_tags: { youtube: true, instagram: false },
        source:       'youtube',
        raw_data: {
          videoId:      video.id,
          channelTitle: channel,
          viewCount,
          likeCount,
          commentCount,
          categoryId,
          publishedAt:  snippet.publishedAt,
          thumbnailUrl: snippet.thumbnails?.medium?.url,
        },
      };
    });

    // Sort by velocity (engagement quality, not just raw views)
    trends.sort((a, b) => b.velocity - a.velocity);

    logger.info({ count: trends.length }, 'YouTube trending fetched successfully');
    return trends;

  } catch (err: any) {
    if (err.response?.status === 403) {
      logger.error('YouTube API quota exceeded or invalid key');
    } else {
      logger.warn({ err: err.message }, 'YouTube trending fetch failed');
    }
    return null;
  }
};

/**
 * Search YouTube for niche-specific trending content
 * Used by radar.service.js for creator-specific intelligence
 */
export const searchYouTubeByNiche = async (niche: string, maxResults = 10) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await axios.get(`${YT_API_BASE}/search`, {
      params: {
        part: 'snippet',
        q: `${niche} india 2025`,
        type: 'video',
        order: 'viewCount',
        regionCode: 'IN',
        relevanceLanguage: 'hi',
        publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        maxResults,
        key: apiKey,
      },
      timeout: 10000,
    });

    const items = response.data?.items || [];
    return items.map((item: any) => ({
      title:     item.snippet?.title || '',
      channel:   item.snippet?.channelTitle || '',
      videoId:   item.id?.videoId || '',
      thumbnail: item.snippet?.thumbnails?.medium?.url || '',
      published: item.snippet?.publishedAt || '',
    }));

  } catch (err: any) {
    logger.warn({ err: err.message, niche }, 'YouTube niche search failed');
    return null;
  }
};
