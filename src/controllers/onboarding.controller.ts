import { FastifyRequest, FastifyReply } from "fastify";
import axios from "axios";
import * as scraperService from "../services/scraper.service";
import { _callGroq } from "../services/ai/groq.service";
import { prisma } from "../config/database";
import { cache, CacheKeys } from "../config/redis";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { debitCredits } from "../services/credits.service";
import { User } from "../types";

export interface ConnectHandleBody {
  handle: string;
  platform: "instagram" | "youtube";
}

/**
 * Step 1: Creator submits handle. ARIA scrapes + analyses immediately.
 */
export const connectHandle = async (
  req: FastifyRequest<{ Body: ConnectHandleBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { handle, platform } = req.body;

  try {
    logger.info(
      { userId: user.id, handle, platform },
      "Onboarding: handle connect started",
    );

    // If user already has an analysis from OAuth, skip and return it
    const existingUser = await (prisma.users as any).findUnique({
      where: { id: user.id },
      select: {
        onboarding_step: true,
        aria_last_analysis: true,
        instagram_handle: true,
        youtube_handle: true,
      },
    });

    if (
      existingUser?.onboarding_step === "analysed" &&
      existingUser.aria_last_analysis
    ) {
      logger.info(
        { userId: user.id },
        "Onboarding: Using existing OAuth analysis",
      );
      return success(reply, {
        ariaAnalysis: existingUser.aria_last_analysis,
        handle:
          platform === "instagram"
            ? existingUser.instagram_handle
            : existingUser.youtube_handle,
        platform,
      });
    }

    let scrapedData: any = null;
    let scrapeError: string | null = null;

    // ── Scrape account ────────────────────────────────────────────────────
    if (platform === "instagram") {
      try {
        scrapedData = await scraperService.scrapeAndSaveProfile(
          user.id,
          handle,
          platform,
        );
      } catch (err: any) {
        scrapeError = err.message;
        logger.warn(
          { err: err.message, handle },
          "Instagram scrape failed — using handle only",
        );
      }
    }

    if (platform === "youtube") {
      try {
        scrapedData = await scrapeYouTubePublic(handle);
      } catch (err: any) {
        scrapeError = err.message;
        logger.warn(
          { err: err.message, handle },
          "YouTube scrape failed — using handle only",
        );
      }
    }

    // ── Check if this is first-time archetype detection (FREE) ────────────
    // If user already has an archetype, this is a RE-detection and costs credits
    const isFirstTimeDetection = !user.archetype && !existingUser?.archetype;

    // ── ARIA analysis ─────────────────────────────────────────────────────
    const ariaAnalysis = await generateARIAProfileSummary({
      handle,
      platform,
      scrapedData,
    });

    // ── Save to DB ────────────────────────────────────────────────────────
    await (prisma.users as any).update({
      where: { id: user.id },
      data: {
        instagram_handle:
          platform === "instagram" ? handle : user.instagram_handle || null,
        youtube_handle:
          platform === "youtube" ? handle : user.youtube_handle || null,
        archetype: ariaAnalysis.archetype,
        niches: ariaAnalysis.detectedNiches,
        aria_last_analysis: ariaAnalysis,
        onboarding_step: "analysed",
        aria_analyzed_at: new Date(),
      },
    });

    await cache.del(CacheKeys.user(user.id));

    // ── Handle credits (FREE for first-time, charged for re-detection) ───
    let creditsUsed = 0;
    if (!isFirstTimeDetection) {
      // This is a re-detection, charge credits
      const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";
      await debitCredits(
        user.id,
        "archetype_detection",
        modelToUse,
        1500, // approx input tokens
        800, // approx output tokens
       
      ).catch((err) => logger.warn({ err }, "Debit failed — non-fatal"));
      creditsUsed = req.creditCheck?.featureCharge ?? 0;
    } else {
      logger.info({ userId: user.id }, "First-time archetype detection — FREE");
    }

    return success(reply, {
      ariaAnalysis,
      scrapedData: scrapedData
        ? {
            followers: scrapedData.followers || scrapedData.follower_count,
            engagementRate: scrapedData.engagement_rate,
            postsAnalyzed: scrapedData.scraped_summary?.totalPostsAnalyzed || 0,
          }
        : null,
      scrapeError,
      handle,
      platform,
      isFirstTimeDetection,
      creditsUsed,
      message: isFirstTimeDetection
        ? "First-time archetype analysis complete — FREE"
        : "Archetype re-detection complete",
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "connectHandle failed");
    return errors.serviceDown(reply, "ARIA Onboarding");
  }
};

export interface FinaliseNicheBody {
  confirmedNiches: string[];
  confirmedArchetype: string;
  platform: string;
  followerRange: string;
}

/**
 * Step 2: Creator confirms or edits niche. ARIA locks it in.
 */
export const finaliseNiche = async (
  req: FastifyRequest<{ Body: FinaliseNicheBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { confirmedNiches, confirmedArchetype, platform, followerRange } =
    req.body;

  try {
    await (prisma.users as any).update({
      where: { id: user.id },
      data: {
        niches: confirmedNiches,
        archetype: confirmedArchetype,
        primary_platform: platform,
        follower_range: followerRange,
        onboarding_step: "complete",
      },
    });

    await cache.del(CacheKeys.user(user.id));
    await cache.del(CacheKeys.dashboard(user.id));

    logger.info(
      {
        userId: user.id,
        niches: confirmedNiches,
        archetype: confirmedArchetype,
      },
      "Onboarding: niche finalised",
    );

    return success(reply, {
      message: "Niche locked. ARIA is ready.",
      niches: confirmedNiches,
      archetype: confirmedArchetype,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "finaliseNiche failed");
    return errors.internal(reply);
  }
};

/**
 * Returns current onboarding step + existing ARIA profile if available
 */
export const getStatus = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    const dbUser = await (prisma.users as any).findUnique({
      where: { id: user.id },
      select: {
        instagram_handle: true,
        youtube_handle: true,
        archetype: true,
        niches: true,
        follower_range: true,
        onboarding_step: true,
        aria_analyzed_at: true,
        scraped_summary: true,
        engagement_rate: true,
      },
    });

    return success(reply, {
      hasHandle: !!(dbUser?.instagram_handle || dbUser?.youtube_handle),
      hasAnalysis: !!dbUser?.aria_analyzed_at,
      onboardingStep: dbUser?.onboarding_step || "pending",
      instagramHandle: dbUser?.instagram_handle,
      youtubeHandle: dbUser?.youtube_handle,
      archetype: dbUser?.archetype,
      niches: dbUser?.niches,
    });
  } catch (err) {
    logger.error({ err }, "getStatus failed");
    return errors.internal(reply);
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────

async function scrapeYouTubePublic(handle: string) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY not set");

  const searchRes = await axios.get(
    "https://www.googleapis.com/youtube/v3/search",
    {
      params: {
        part: "snippet",
        q: handle,
        type: "channel",
        maxResults: 1,
        key: apiKey,
      },
      timeout: 10000,
    },
  );

  const channelId = searchRes.data?.items?.[0]?.id?.channelId;
  if (!channelId)
    throw new Error(`YouTube channel not found for handle: ${handle}`);

  const statsRes = await axios.get(
    "https://www.googleapis.com/youtube/v3/channels",
    {
      params: {
        part: "statistics,snippet,contentDetails",
        id: channelId,
        key: apiKey,
      },
      timeout: 10000,
    },
  );

  const channel = statsRes.data?.items?.[0];
  if (!channel) throw new Error("Could not fetch channel stats");

  const stats = channel.statistics || {};

  const videosRes = await axios.get(
    "https://www.googleapis.com/youtube/v3/search",
    {
      params: {
        part: "snippet",
        channelId,
        order: "date",
        maxResults: 10,
        type: "video",
        key: apiKey,
      },
      timeout: 10000,
    },
  );

  const recentVideos = (videosRes.data?.items || []).map((v: any) => ({
    title: v.snippet?.title || "",
    published: v.snippet?.publishedAt || "",
  }));

  const subscriberCount = parseInt(stats.subscriberCount) || 0;
  const viewCount = parseInt(stats.viewCount) || 0;
  const videoCount = parseInt(stats.videoCount) || 0;

  return {
    followers: subscriberCount,
    follower_count: subscriberCount,
    engagement_rate:
      videoCount > 0 && subscriberCount > 0
        ? ((viewCount / videoCount / subscriberCount) * 100).toFixed(2)
        : "0",
    channel_name: channel.snippet?.title || handle,
    description: channel.snippet?.description?.slice(0, 300) || "",
    recent_videos: recentVideos,
    total_views: viewCount,
    video_count: videoCount,
    scraped_summary: {
      totalPostsAnalyzed: recentVideos.length,
      platform: "youtube",
      topPosts: recentVideos.slice(0, 5).map((v: any) => v.title),
    },
  };
}

async function generateARIAProfileSummary({
  handle,
  platform,
  scrapedData,
}: {
  handle: string;
  platform: string;
  scrapedData: any;
}) {
  const followers = scrapedData?.followers || scrapedData?.follower_count || 0;
  const engagement = scrapedData?.engagement_rate || "0";
  const topPosts =
    scrapedData?.scraped_summary?.topPosts ||
    scrapedData?.scraped_summary?.topHashtags ||
    [];
  const postCount = scrapedData?.scraped_summary?.totalPostsAnalyzed || 0;
  const recentVideos = scrapedData?.recent_videos || [];

  const followerRange =
    followers > 500000
      ? "500K+"
      : followers > 100000
        ? "100K–500K"
        : followers > 50000
          ? "50K–100K"
          : followers > 10000
            ? "10K–50K"
            : followers > 1000
              ? "1K–10K"
              : "Under 1K";

  const prompt = `You are ARIA — India's creator intelligence engine.

Analyse this creator's public profile and generate a complete intelligence summary.

Platform: ${platform}
Handle: @${handle}
Followers: ${followers.toLocaleString("en-IN")} (${followerRange})
Engagement Rate: ${engagement}%
Posts/Videos Analyzed: ${postCount}
${topPosts.length > 0 ? `Top content: ${topPosts.slice(0, 5).join(", ")}` : ""}
${
  recentVideos.length > 0
    ? `Recent videos: ${recentVideos
        .slice(0, 5)
        .map((v: any) => v.title)
        .join(", ")}`
    : ""
}

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
  "strengths": ["Specific strength based on the data", "Another specific strength"],
  "gaps": ["Specific gap ARIA detected", "Another gap"],
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
    return await _callGroq(prompt, {
      useLlama: true,
      maxTokens: 1200,
    });
  } catch (err) {
    logger.error({ err }, "ARIA profile summary generation failed");
    return {
      archetype: "EDUCATOR",
      archetypeLabel: "The Creator",
      archetypeEmoji: "🎯",
      archetypeConfidence: 60,
      detectedNiches: ["general"],
      followerRange,
      healthScore: 50,
      growthStage: "DISCOVERY",
      strengths: ["Active on social media"],
      gaps: ["Niche not fully defined yet"],
      topOpportunity: "Start posting consistently to build your audience",
      contentInsights: {
        bestFormat: platform === "youtube" ? "Shorts" : "Reels",
        postingFrequency: "3x/week",
        bestTime: "7:30 PM IST",
        audienceAge: "18-35",
        audienceGender: "Mixed",
        topCity: "India",
      },
      monetisationReadiness: 30,
      estimatedMonthlyEarning: "₹5,000–₹15,000",
      ariaMessage: `Welcome to ARIA, @${handle}! I'm analysing your content to personalise everything for you.`,
      brandCategories: ["General"],
    };
  }
}
