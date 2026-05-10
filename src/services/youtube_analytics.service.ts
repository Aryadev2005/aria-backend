// src/services/youtube_analytics.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// YouTube Analytics Engine
// Uses the user's stored OAuth token to fetch real channel + video data,
// builds a scraped_summary in the same shape as Instagram's, and persists
// everything so ARIA can personalise prompts the same way it does for IG.
// ══════════════════════════════════════════════════════════════════════════════

import { google } from "googleapis";
import { prisma } from "../config/database";
import { cache, CacheKeys } from "../config/redis";
import { logger } from "../utils/logger";
import { _callGroq } from "./ai/groq.service";
import { decryptToken, encryptToken } from "../utils/tokenCrypto";
import { getValidYouTubeToken } from "../providers/youtube.provider";

export interface YouTubeScrapedSummary {
  platform: "youtube";
  channelId: string;
  handle: string;
  channelName: string;
  subscriberCount: number;
  totalViews: number;
  videoCount: number;
  avgViewsPerVideo: number;
  avgLikesPerVideo: number;
  avgCommentsPerVideo: number;
  engagementRate: string;
  postsPerWeek: number;
  followerRange: string;
  topVideos: Array<{
    videoId: string;
    title: string;
    views: number;
    likes: number;
    comments: number;
    publishedAt: string;
    duration: string;
  }>;
  recentVideoTitles: string[];
  topTags: string[];
  description: string;
  totalPostsAnalyzed: number;
  bestPostType: string;
  isVerified: boolean;
  fetchedAt: string;
}

function makeOAuthClient(accessToken: string) {
  const client = new google.auth.OAuth2({
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
  });
  client.setCredentials({ access_token: accessToken });
  return google.youtube({ version: "v3", auth: client });
}

function toFollowerRange(subs: number): string {
  if (subs >= 500_000) return "500K+";
  if (subs >= 100_000) return "100K–500K";
  if (subs >= 50_000) return "50K–100K";
  if (subs >= 10_000) return "10K–50K";
  if (subs >= 1_000) return "1K–10K";
  return "Under 1K";
}

function parseDuration(iso: string): string {
  const m = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return "—";
  const h = parseInt(m[1] || "0");
  const min = parseInt(m[2] || "0");
  const s = parseInt(m[3] || "0");
  return h > 0
    ? `${h}:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${min}:${String(s).padStart(2, "0")}`;
}

function estimatePostsPerWeek(videos: Array<{ publishedAt: string }>): number {
  if (videos.length < 2) return 0;
  const dates = videos
    .map((v) => new Date(v.publishedAt).getTime())
    .sort((a, b) => b - a);
  const spanMs = dates[0] - dates[dates.length - 1];
  const spanWeeks = spanMs / (7 * 24 * 60 * 60 * 1000);
  return spanWeeks > 0 ? parseFloat((videos.length / spanWeeks).toFixed(2)) : 0;
}

/**
 * Fetch full channel analytics using the user's stored OAuth token.
 * Returns a summary object ready to be saved to users.youtube_scraped_summary.
 */
export async function fetchYouTubeAnalyticsWithToken(
  userId: string,
): Promise<YouTubeScrapedSummary> {
  // ── 1. Load connection row ────────────────────────────────────────────────
  const conn = await (prisma as any).account_connections.findFirst({
    where: { user_id: userId, platform: "youtube" },
    select: {
      encrypted_token: true,
      token_expires_at: true,
      handle: true,
      platform_user_id: true,
    },
  });

  if (!conn?.encrypted_token) {
    throw new Error("No YouTube connection found — user must connect first");
  }

  // ── 2. Decrypt + refresh token if needed ──────────────────────────────────
  const decrypted = decryptToken(conn.encrypted_token);
  if (!decrypted) throw new Error("Failed to decrypt YouTube token");

  const accessToken = await getValidYouTubeToken(
    decrypted,
    conn.token_expires_at,
    async (newTokenPayload, newExpiresAt) => {
      await (prisma as any).account_connections.updateMany({
        where: { user_id: userId, platform: "youtube" },
        data: {
          encrypted_token: encryptToken(newTokenPayload),
          token_expires_at: newExpiresAt,
        },
      });
    },
  );

  const yt = makeOAuthClient(accessToken);

  // ── 3. Fetch channel info ─────────────────────────────────────────────────
  const channelRes = await yt.channels.list({
    part: ["snippet", "statistics", "brandingSettings"],
    mine: true,
  });

  const channel = channelRes.data.items?.[0];
  if (!channel) throw new Error("No YouTube channel found for this account");

  const stats = channel.statistics || {};
  const subscriberCount = parseInt(stats.subscriberCount || "0");
  const totalViewCount = parseInt(stats.viewCount || "0");
  const videoCount = parseInt(stats.videoCount || "0");
  const channelId = channel.id || conn.platform_user_id || "";
  const handle = channel.snippet?.customUrl || conn.handle || "";
  const channelName = channel.snippet?.title || "";
  const description = channel.snippet?.description?.slice(0, 400) || "";
  const isVerified =
    (channel.brandingSettings as any)?.channel?.isLinkedWithGoogle ?? false;

  // ── 4. Fetch recent videos (up to 50) ─────────────────────────────────────
  const searchRes = await yt.search.list({
    part: ["snippet"],
    channelId,
    order: "date",
    maxResults: 50,
    type: ["video"],
  });

  const videoIds = (searchRes.data.items || [])
    .map((i) => i.id?.videoId)
    .filter(Boolean) as string[];

  if (!videoIds.length) {
    // Channel exists but no videos — return minimal summary
    const minimal: YouTubeScrapedSummary = {
      platform: "youtube",
      channelId,
      handle,
      channelName,
      subscriberCount,
      totalViews: totalViewCount,
      videoCount,
      avgViewsPerVideo: 0,
      avgLikesPerVideo: 0,
      avgCommentsPerVideo: 0,
      engagementRate: "0",
      postsPerWeek: 0,
      followerRange: toFollowerRange(subscriberCount),
      topVideos: [],
      recentVideoTitles: [],
      topTags: [],
      description,
      totalPostsAnalyzed: 0,
      bestPostType: "video",
      isVerified,
      fetchedAt: new Date().toISOString(),
    };
    return minimal;
  }

  // ── 5. Fetch per-video stats ───────────────────────────────────────────────
  const videosRes = await yt.videos.list({
    part: ["snippet", "statistics", "contentDetails"],
    id: videoIds,
  });

  const videos = videosRes.data.items || [];

  const videosData = videos.map((v) => {
    const s = v.statistics || {};
    const views = parseInt(s.viewCount || "0");
    const likes = parseInt(s.likeCount || "0");
    const comments = parseInt(s.commentCount || "0");
    return {
      videoId: v.id || "",
      title: v.snippet?.title || "",
      views,
      likes,
      comments,
      publishedAt: v.snippet?.publishedAt || "",
      duration: parseDuration(v.contentDetails?.duration || ""),
      tags: v.snippet?.tags || [],
    };
  });

  // ── 6. Compute aggregate stats ────────────────────────────────────────────
  const total = videosData.length;
  const avgViews = total
    ? Math.round(videosData.reduce((s, v) => s + v.views, 0) / total)
    : 0;
  const avgLikes = total
    ? Math.round(videosData.reduce((s, v) => s + v.likes, 0) / total)
    : 0;
  const avgComments = total
    ? Math.round(videosData.reduce((s, v) => s + v.comments, 0) / total)
    : 0;

  // Engagement rate: (avg_likes + avg_comments) / subscribers * 100
  const engagementRate =
    subscriberCount > 0
      ? (((avgLikes + avgComments) / subscriberCount) * 100).toFixed(2)
      : "0";

  const postsPerWeek = estimatePostsPerWeek(videosData);

  // Top 10 by views
  const topVideos = [...videosData]
    .sort((a, b) => b.views - a.views)
    .slice(0, 10)
    .map(
      ({ videoId, title, views, likes, comments, publishedAt, duration }) => ({
        videoId,
        title,
        views,
        likes,
        comments,
        publishedAt,
        duration,
      }),
    );

  // Collect all tags, rank by frequency
  const tagFreq: Record<string, number> = {};
  for (const v of videosData) {
    for (const tag of v.tags) {
      tagFreq[tag] = (tagFreq[tag] || 0) + 1;
    }
  }
  const topTags = Object.entries(tagFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag]) => tag);

  const recentVideoTitles = videosData
    .sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    )
    .slice(0, 10)
    .map((v) => v.title);

  return {
    platform: "youtube",
    channelId,
    handle,
    channelName,
    subscriberCount,
    totalViews: totalViewCount,
    videoCount,
    avgViewsPerVideo: avgViews,
    avgLikesPerVideo: avgLikes,
    avgCommentsPerVideo: avgComments,
    engagementRate,
    postsPerWeek,
    followerRange: toFollowerRange(subscriberCount),
    topVideos,
    recentVideoTitles,
    topTags,
    description,
    totalPostsAnalyzed: total,
    bestPostType: "video",
    isVerified,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch analytics, run ARIA niche detection, and persist everything.
 * Call this fire-and-forget after OAuth callback, or on-demand from Settings.
 */
export async function fetchAndSaveYouTubeAnalytics(
  userId: string,
): Promise<void> {
  logger.info({ userId }, "youtube_analytics: starting fetch");

  let summary: YouTubeScrapedSummary;
  try {
    summary = await fetchYouTubeAnalyticsWithToken(userId);
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId },
      "youtube_analytics: fetch failed",
    );
    throw err;
  }

  // ── Run ARIA niche detection with YouTube data ────────────────────────────
  const followerRange = summary.followerRange;

  const prompt = `You are ARIA — India's creator intelligence engine.

Analyse this YouTube channel and generate a complete intelligence summary.

Platform: youtube
Handle: @${summary.handle}
Channel: ${summary.channelName}
Subscribers: ${summary.subscriberCount.toLocaleString("en-IN")} (${followerRange})
Total Views: ${summary.totalViews.toLocaleString("en-IN")}
Videos Analyzed: ${summary.totalPostsAnalyzed}
Avg Views/Video: ${summary.avgViewsPerVideo.toLocaleString("en-IN")}
Avg Likes/Video: ${summary.avgLikesPerVideo.toLocaleString("en-IN")}
Engagement Rate: ${summary.engagementRate}%
Posts Per Week: ${summary.postsPerWeek}
Description: "${summary.description}"
${summary.topTags.length > 0 ? `Top Tags: ${summary.topTags.slice(0, 15).join(", ")}` : ""}
${summary.recentVideoTitles.length > 0 ? `Recent Videos: ${summary.recentVideoTitles.slice(0, 8).join(", ")}` : ""}
${
  summary.topVideos.length > 0
    ? `Top Performing Videos:\n${summary.topVideos
        .slice(0, 5)
        .map(
          (v, i) =>
            `  ${i + 1}. "${v.title}" — ${v.views.toLocaleString("en-IN")} views, ${v.likes.toLocaleString("en-IN")} likes`,
        )
        .join("\n")}`
    : ""
}

Detect the creator's PRIMARY niche (1-2 max), archetype, and generate a full ARIA intelligence brief.

Respond ONLY with valid JSON:
{
  "archetype": "TRENDSETTER|EDUCATOR|ENTERTAINER|STORYTELLER|CONNECTOR|EXPERT|HUSTLER|ATHLETE|CHEF|PERFORMER",
  "archetypeLabel": "The YouTube Educator",
  "archetypeEmoji": "🎓",
  "archetypeConfidence": 87,
  "detectedNiches": ["education", "tech"],
  "followerRange": "${followerRange}",
  "healthScore": 72,
  "growthStage": "DISCOVERY|GROWTH|MONETIZATION|SCALE",
  "strengths": ["Specific strength based on the data"],
  "gaps": ["Specific gap ARIA detected"],
  "topOpportunity": "One sentence — the single biggest opportunity for this creator right now",
  "contentInsights": {
    "bestFormat": "Shorts|Long-form|Tutorial",
    "postingFrequency": "${summary.postsPerWeek}x/week",
    "bestTime": "Friday 7:30 PM IST",
    "audienceAge": "18-35",
    "audienceGender": "Mixed",
    "topCity": "India"
  },
  "monetisationReadiness": 65,
  "estimatedMonthlyEarning": "₹15,000–₹45,000",
  "ariaMessage": "Personal message from ARIA to this creator — 2 sentences, warm, specific to their YouTube data",
  "brandCategories": ["Tech", "Education"]
}`;

  let ariaAnalysis: any;
  try {
    ariaAnalysis = await _callGroq(prompt, { useLlama: true, maxTokens: 1200 });
  } catch (err) {
    logger.warn(
      { err },
      "youtube_analytics: ARIA niche detection failed — using defaults",
    );
    ariaAnalysis = {
      archetype: "EDUCATOR",
      archetypeLabel: "The YouTube Creator",
      archetypeEmoji: "🎯",
      archetypeConfidence: 60,
      detectedNiches: ["general"],
      followerRange,
      healthScore: 50,
      growthStage: "DISCOVERY",
      strengths: ["Active on YouTube"],
      gaps: ["Niche not fully defined yet"],
      topOpportunity: "Post consistently to build your YouTube audience",
      contentInsights: {
        bestFormat: "Shorts",
        postingFrequency: `${summary.postsPerWeek}x/week`,
        bestTime: "7:30 PM IST",
        audienceAge: "18-35",
        audienceGender: "Mixed",
        topCity: "India",
      },
      monetisationReadiness: 30,
      estimatedMonthlyEarning: "₹5,000–₹15,000",
      ariaMessage: `Welcome, @${summary.handle}! ARIA is personalising your YouTube strategy now.`,
      brandCategories: ["General"],
    };
  }

  // ── Persist to users table ────────────────────────────────────────────────
  // Only overwrite profile fields if they aren't already set from Instagram
  const existing = await (prisma as any).users.findUnique({
    where: { id: userId },
    select: { archetype: true, niches: true, primary_platform: true },
  });

  const isYouTubePrimary =
    existing?.primary_platform === "youtube" || !existing?.archetype;

  await (prisma as any).users.update({
    where: { id: userId },
    data: {
      youtube_handle: summary.handle,
      youtube_scraped_summary: summary,
      youtube_scraped_at: new Date(),
      follower_count: isYouTubePrimary ? summary.subscriberCount : undefined,
      engagement_rate: isYouTubePrimary
        ? parseFloat(summary.engagementRate) || undefined
        : undefined,
      follower_range: isYouTubePrimary ? followerRange : undefined,
      niches:
        isYouTubePrimary || !existing?.niches?.length
          ? ariaAnalysis.detectedNiches
          : undefined,
      archetype: isYouTubePrimary ? ariaAnalysis.archetype : undefined,
      archetype_label: isYouTubePrimary
        ? ariaAnalysis.archetypeLabel
        : undefined,
      archetype_confidence: isYouTubePrimary
        ? ariaAnalysis.archetypeConfidence
        : undefined,
      growth_stage: isYouTubePrimary ? ariaAnalysis.growthStage : undefined,
      aria_last_analysis: isYouTubePrimary ? ariaAnalysis : undefined,
      aria_analyzed_at: isYouTubePrimary ? new Date() : undefined,
      onboarding_step: isYouTubePrimary ? "analysed" : undefined,
    },
  });

  await cache.del(CacheKeys.user(userId));
  logger.info(
    { userId, handle: summary.handle, videos: summary.totalPostsAnalyzed },
    "youtube_analytics: saved to DB",
  );
}
