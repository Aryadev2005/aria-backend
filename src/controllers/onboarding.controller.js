// src/controllers/onboarding.controller.js
// ARIA Smart Onboarding — handle submit → scrape → analyse → summarise → finalise
'use strict';

const { getDB }            = require('../config/database');
const { cache, CacheKeys } = require('../config/redis');
// const { enqueueScrapeJob } = require('../config/queue');
const { success, errors }  = require('../utils/response');
const { logger }           = require('../utils/logger');
const groqService          = require('../services/ai/groq.service');
const scraperService       = require('../services/scraper.service');
const youtubeSvc           = require('../services/youtubeTrending.service');

// ─── POST /api/v1/onboarding/connect ──────────────────────────────────────
// Step 1: Creator submits handle. ARIA scrapes + analyses immediately.
// Returns full ARIA profile summary in one response.
const connectHandle = async (req, reply) => {
  const { enqueueScrapeJob } = require('../config/queue'); // Import here to avoid circular dependency with scraperService
  const user     = req.user;
  const { handle, platform } = req.body;
  const sql      = getDB();

  try {
    logger.info({ userId: user.id, handle, platform }, 'Onboarding: handle connect started');

    let scrapedData = null;
    let scrapeError = null;

    // ── Scrape account ────────────────────────────────────────────────────
    if (platform === 'instagram') {
      try {
        scrapedData = await scraperService.scrapeAndSaveProfile(user.id, handle, platform);
      } catch (err) {
        scrapeError = err.message;
        logger.warn({ err: err.message, handle }, 'Instagram scrape failed — using handle only');
      }
    }

    if (platform === 'youtube') {
      try {
        scrapedData = await scrapeYouTubePublic(handle);
      } catch (err) {
        scrapeError = err.message;
        logger.warn({ err: err.message, handle }, 'YouTube scrape failed — using handle only');
      }
    }

    // ── Build ARIA analysis prompt with whatever data we have ─────────────
    const ariaAnalysis = await generateARIAProfileSummary({
      handle,
      platform,
      scrapedData,
      userId: user.id,
    });

    // ── Save handle + analysis to DB ──────────────────────────────────────
    const updateData = {
      instagram_handle: platform === 'instagram' ? handle : user.instagram_handle,
      youtube_handle:   platform === 'youtube'   ? handle : user.youtube_handle,
      archetype:        ariaAnalysis.archetype,
      niches:           ariaAnalysis.detectedNiches,
      aria_profile:     JSON.stringify(ariaAnalysis),
      onboarding_step:  'analysed',
    };

    await sql`
      UPDATE users SET
        instagram_handle = ${updateData.instagram_handle},
        youtube_handle   = ${updateData.youtube_handle},
        archetype        = ${updateData.archetype},
        niches           = ${updateData.niches},
        aria_analyzed_at = NOW()
      WHERE id = ${user.id}
    `;

    // Invalidate cache
    await cache.del(CacheKeys.user(user.id));

    return success(reply, {
      ariaAnalysis,
      scrapedData: scrapedData ? {
        followers:       scrapedData.followers || scrapedData.follower_count,
        engagementRate:  scrapedData.engagement_rate,
        postsAnalyzed:   scrapedData.scraped_summary?.totalPostsAnalyzed || 0,
      } : null,
      scrapeError,
      handle,
      platform,
    });

  } catch (err) {
    logger.error({ err, userId: user.id }, 'connectHandle failed');
    return errors.serviceDown(reply, 'ARIA Onboarding');
  }
};

// ─── POST /api/v1/onboarding/finalise ────────────────────────────────────
// Step 2: Creator confirms or edits niche. ARIA locks it in.
const finaliseNiche = async (req, reply) => {
  const user = req.user;
  const { confirmedNiches, confirmedArchetype, platform, followerRange } = req.body;
  const sql  = getDB();

  try {
    // Update user profile with confirmed niche
    await sql`
      UPDATE users SET
        niches           = ${confirmedNiches},
        archetype        = ${confirmedArchetype},
        primary_platform = ${platform},
        follower_range   = ${followerRange},
        onboarding_step  = 'complete'
      WHERE id = ${user.id}
    `;

    await cache.del(CacheKeys.user(user.id));
    await cache.del(CacheKeys.dashboard(user.id));

    logger.info(
      { userId: user.id, niches: confirmedNiches, archetype: confirmedArchetype },
      'Onboarding: niche finalised'
    );

    return success(reply, {
      message: 'Niche locked. ARIA is ready.',
      niches:    confirmedNiches,
      archetype: confirmedArchetype,
    });

  } catch (err) {
    logger.error({ err, userId: user.id }, 'finaliseNiche failed');
    return errors.internal(reply);
  }
};

// ─── GET /api/v1/onboarding/status ───────────────────────────────────────
// Returns current onboarding step + existing ARIA profile if available
const getStatus = async (req, reply) => {
  const user = req.user;
  const sql  = getDB();

  try {
    const [dbUser] = await sql`
      SELECT 
        instagram_handle, youtube_handle,
        archetype, niches, follower_range,
        onboarding_step, aria_analyzed_at,
        scraped_summary, engagement_rate
      FROM users WHERE id = ${user.id}
    `;

    return success(reply, {
      hasHandle:       !!(dbUser?.instagram_handle || dbUser?.youtube_handle),
      hasAnalysis:     !!dbUser?.aria_analyzed_at,
      onboardingStep:  dbUser?.onboarding_step || 'pending',
      instagramHandle: dbUser?.instagram_handle,
      youtubeHandle:   dbUser?.youtube_handle,
      archetype:       dbUser?.archetype,
      niches:          dbUser?.niches,
    });

  } catch (err) {
    logger.error({ err }, 'getStatus failed');
    return errors.internal(reply);
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────

// Scrape YouTube public channel data via YouTube Data API
const scrapeYouTubePublic = async (handle) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY not set');

  const axios = require('axios');

  // Search for channel by handle
  const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
    params: {
      part: 'snippet',
      q: handle,
      type: 'channel',
      maxResults: 1,
      key: apiKey,
    },
    timeout: 10000,
  });

  const channelId = searchRes.data?.items?.[0]?.id?.channelId;
  if (!channelId) throw new Error(`YouTube channel not found for handle: ${handle}`);

  // Get channel stats
  const statsRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
    params: {
      part: 'statistics,snippet,contentDetails',
      id: channelId,
      key: apiKey,
    },
    timeout: 10000,
  });

  const channel = statsRes.data?.items?.[0];
  if (!channel) throw new Error('Could not fetch channel stats');

  const stats = channel.statistics || {};

  // Get recent videos
  const videosRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
    params: {
      part: 'snippet',
      channelId,
      order: 'date',
      maxResults: 10,
      type: 'video',
      key: apiKey,
    },
    timeout: 10000,
  });

  const recentVideos = (videosRes.data?.items || []).map(v => ({
    title:     v.snippet?.title || '',
    published: v.snippet?.publishedAt || '',
  }));

  const subscriberCount = parseInt(stats.subscriberCount) || 0;
  const viewCount       = parseInt(stats.viewCount) || 0;
  const videoCount      = parseInt(stats.videoCount) || 0;

  return {
    followers:      subscriberCount,
    follower_count: subscriberCount,
    engagement_rate: videoCount > 0 ? ((viewCount / videoCount / subscriberCount) * 100).toFixed(2) : '0',
    channel_name:   channel.snippet?.title || handle,
    description:    channel.snippet?.description?.slice(0, 300) || '',
    recent_videos:  recentVideos,
    total_views:    viewCount,
    video_count:    videoCount,
    scraped_summary: {
      totalPostsAnalyzed: recentVideos.length,
      platform: 'youtube',
      topPosts: recentVideos.slice(0, 5).map(v => v.title),
    },
  };
};

// ARIA profile summary — the core intelligence generation
const generateARIAProfileSummary = async ({ handle, platform, scrapedData, userId }) => {
  const followers     = scrapedData?.followers || scrapedData?.follower_count || 0;
  const engagement    = scrapedData?.engagement_rate || '0';
  const topPosts      = scrapedData?.scraped_summary?.topPosts ||
                        scrapedData?.scraped_summary?.topHashtags || [];
  const postCount     = scrapedData?.scraped_summary?.totalPostsAnalyzed || 0;
  const recentVideos  = scrapedData?.recent_videos || [];

  const followerRange = followers > 500000 ? '500K+'
    : followers > 100000 ? '100K–500K'
    : followers > 50000  ? '50K–100K'
    : followers > 10000  ? '10K–50K'
    : followers > 1000   ? '1K–10K'
    : 'Under 1K';

  const prompt = `You are ARIA — India's creator intelligence engine.

Analyse this creator's public profile and generate a complete intelligence summary.

Platform: ${platform}
Handle: @${handle}
Followers: ${followers.toLocaleString('en-IN')} (${followerRange})
Engagement Rate: ${engagement}%
Posts/Videos Analyzed: ${postCount}
${topPosts.length > 0 ? `Top content: ${topPosts.slice(0, 5).join(', ')}` : ''}
${recentVideos.length > 0 ? `Recent videos: ${recentVideos.slice(0, 5).map(v => v.title).join(', ')}` : ''}

Detect the creator's PRIMARY niche (1-2 max), archetype, and generate a full ARIA intelligence brief.

Respond ONLY with valid JSON:
{
  "archetype": "TRENDSETTER|EDUCATOR|ENTERTAINER|STORYTELLER|CONNECTOR|EXPERT|HUSTLER|ATHLETE|CHEF|PERFORMER",
  "archetypeLabel": "The Fashion Trendsetter",
  "archetypeEmoji": "✨",
  "archetypeConfidence": 87,
  "detectedNiches": ["fashion", "beauty"],
  "followerRange": "${followerRange}",
  "healthScore": 72,
  "growthStage": "DISCOVERY|GROWTH|MONETIZATION|SCALE",
  "strengths": [
    "Specific strength based on the data",
    "Another specific strength"
  ],
  "gaps": [
    "Specific gap ARIA detected",
    "Another gap"
  ],
  "topOpportunity": "One sentence — the single biggest opportunity for this creator right now",
  "contentInsights": {
    "bestFormat": "Reels|Shorts|Carousel",
    "postingFrequency": "3x/week",
    "bestTime": "Friday 7:30 PM IST",
    "audienceAge": "18-24",
    "audienceGender": "60% Female",
    "topCity": "Mumbai"
  },
  "monetisationReadiness": 65,
  "estimatedMonthlyEarning": "₹15,000–₹45,000",
  "ariaMessage": "Personal message from ARIA to this creator — 2 sentences, warm, specific to their data",
  "brandCategories": ["Fashion", "Beauty", "Lifestyle"]
}`;

  try {
    return await groqService._callGroq(prompt, { useLlama: true, maxTokens: 1200 });
  } catch (err) {
    logger.error({ err }, 'ARIA profile summary generation failed');
    // Return sensible defaults so onboarding never breaks
    return {
      archetype: 'EDUCATOR',
      archetypeLabel: 'The Creator',
      archetypeEmoji: '🎯',
      archetypeConfidence: 60,
      detectedNiches: ['general'],
      followerRange,
      healthScore: 50,
      growthStage: 'DISCOVERY',
      strengths: ['Active on social media'],
      gaps: ['Niche not fully defined yet'],
      topOpportunity: 'Start posting consistently to build your audience',
      contentInsights: {
        bestFormat: platform === 'youtube' ? 'Shorts' : 'Reels',
        postingFrequency: '3x/week',
        bestTime: '7:30 PM IST',
        audienceAge: '18-35',
        audienceGender: 'Mixed',
        topCity: 'India',
      },
      monetisationReadiness: 30,
      estimatedMonthlyEarning: '₹5,000–₹15,000',
      ariaMessage: `Welcome to ARIA, @${handle}! I'm analysing your content to personalise everything for you.`,
      brandCategories: ['General'],
    };
  }
};

module.exports = { connectHandle, finaliseNiche, getStatus };
