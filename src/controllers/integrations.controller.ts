import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database";
import { cache, CacheKeys } from "../config/redis";
import { logger } from "../utils/logger";
import { success } from "../utils/response";
import * as scraperService from "../services/scraper.service";
import * as groqService from "../services/ai/groq.service";
import axios from "axios";
import crypto from "crypto";

// ── Provider imports ──────────────────────────────────────────────────────
import {
  generateYouTubeAuthUrl,
  exchangeYouTubeCode,
  getYouTubeChannelInfo,
  getValidYouTubeToken,
  revokeYouTubeToken,
  isTokenExpired,
} from "../providers/youtube.provider";

import {
  generateInstagramAuthUrl,
  completeInstagramOAuth,
  getValidInstagramToken,
  fetchRecentMedia,
  buildTokenPayload,
  instagramTokenIsExpired,
  instagramTokenNeedsRefresh,
  type InstagramUserProfile,
} from "../providers/instagram.provider";

// ── Encryption ────────────────────────────────────────────────────────────
// Key is validated at runtime — if missing, token operations will throw clearly
function getEncryptionKey(): Buffer {
  const key = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (key.length !== 64) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)",
    );
  }
  return Buffer.from(key, "hex");
}

function encryptToken(token: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

// Exported so other services can decrypt tokens when posting
export function decryptToken(encryptedToken: string): string {
  const [ivHex, encryptedHex] = encryptedToken.split(":");
  if (!ivHex || !encryptedHex)
    throw new Error("Invalid encrypted token format");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    getEncryptionKey(),
    iv,
  );
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

// ── GET /api/v1/integrations/instagram/auth-url ───────────────────────────
export const getInstagramAuthUrl = async (
  req: FastifyRequest<{
    Querystring: { flow?: "register" | "onboarding" | "dashboard" };
  }>,
  reply: FastifyReply,
) => {
  const user = (req as any).user;
  const { flow = "dashboard" } = req.query;
  try {
    const url = generateInstagramAuthUrl(user.id, flow);
    return success(reply, { url });
  } catch (err: any) {
    logger.error({ err }, "Failed to generate Instagram auth URL");
    return reply.status(503).send({
      success: false,
      error: "Instagram OAuth not configured",
      message: err.message,
    });
  }
};

// ── GET /api/v1/integrations/youtube/auth-url ─────────────────────────────
export const getYoutubeAuthUrl = async (
  req: FastifyRequest<{
    Querystring: { flow?: "register" | "onboarding" | "dashboard" };
  }>,
  reply: FastifyReply,
) => {
  const user = (req as any).user;
  const { flow = "dashboard" } = req.query;

  // YOUTUBE_CLIENT_ID is the OAuth client ID — different from YOUTUBE_API_KEY
  if (!process.env.YOUTUBE_CLIENT_ID) {
    logger.error("YOUTUBE_CLIENT_ID not set — YouTube OAuth will fail");
    return reply
      .status(503)
      .send({ success: false, error: "YouTube OAuth not configured" });
  }

  const url = generateYouTubeAuthUrl(user.id, flow);
  return success(reply, { url });
};

// ── GET /api/v1/integrations/instagram/callback ───────────────────────────
export const instagramCallback = async (
  req: FastifyRequest<{
    Querystring: {
      code: string;
      state: string;
      error?: string;
      error_reason?: string;
    };
  }>,
  reply: FastifyReply,
) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error) {
    logger.warn(
      { error, error_reason: req.query.error_reason },
      "Instagram OAuth denied",
    );
    return reply.redirect(`${frontendUrl}/register?error=instagram_denied`);
  }

  let userId: string;
  let flow: string = "dashboard";
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64").toString());
    userId = decoded.userId;
    flow = decoded.flow || "dashboard";
    if (!userId) throw new Error("No userId in state");
  } catch {
    return reply.redirect(`${frontendUrl}/register?error=invalid_state`);
  }

  try {
    // Single call — handles code exchange + long-lived token + profile fetch
    const {
      accessToken,
      pageAccessToken,
      pageId,
      igUserId,
      expiresAt,
      profile,
    } = await completeInstagramOAuth(code);

    // Build the full token payload JSON
    const tokenPayload = buildTokenPayload({
      pageToken: pageAccessToken,
      userToken: accessToken,
      pageId,
      igUserId,
    });

    // Save encrypted token to DB
    await (prisma as any).account_connections.upsert({
      where: { user_id_platform: { user_id: userId, platform: "instagram" } },
      create: {
        user_id: userId,
        platform: "instagram",
        platform_user_id: profile.user_id,
        handle: profile.username,
        encrypted_token: encryptToken(tokenPayload),
        token_expires_at: expiresAt,
        scopes: ["instagram_business_basic"],
        connected_at: new Date(),
      },
      update: {
        platform_user_id: profile.user_id,
        handle: profile.username,
        encrypted_token: encryptToken(tokenPayload),
        token_expires_at: expiresAt,
        connected_at: new Date(),
      },
    });

    // Update user table
    await (prisma as any).users.update({
      where: { id: userId },
      data: {
        instagram_handle: profile.username,
        // Store follower count if column exists
        ...(profile.followers_count > 0
          ? { follower_count: profile.followers_count }
          : {}),
      },
    });

    await cache.del(CacheKeys.user(userId));

    // Fire-and-forget niche detection — do NOT await
    triggerNicheDetection(userId, profile.username, "instagram").catch((err) =>
      logger.warn({ err }, "Niche detection failed — not critical"),
    );

    // Determine redirect based on flow
    let redirectBase = "/dashboard/profile";
    if (flow === "onboarding") {
      redirectBase = "/onboarding";
    } else if (flow === "register") {
      redirectBase = "/register";
    }

    return reply.redirect(
      `${frontendUrl}${redirectBase}?success=instagram&handle=${profile.username}`,
    );
  } catch (err: any) {
    logger.error({ err, userId }, "Instagram callback failed");

    // Check for professional account error
    const msg = err.message || "";
    const redirectBase = flow === "onboarding" ? "/onboarding" : "/register";

    if (
      msg.includes("professional") ||
      msg.includes("business") ||
      msg.includes("creator")
    ) {
      return reply.redirect(
        `${frontendUrl}${redirectBase}?error=instagram_not_professional`,
      );
    }

    return reply.redirect(
      `${frontendUrl}${redirectBase}?error=instagram_failed`,
    );
  }
};

// ── GET /api/v1/integrations/youtube/callback ─────────────────────────────
export const youtubeCallback = async (
  req: FastifyRequest<{
    Querystring: { code: string; state: string; error?: string };
  }>,
  reply: FastifyReply,
) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error) {
    return reply.redirect(`${frontendUrl}/onboarding?error=youtube_denied`);
  }

  let userId: string;
  let flow: string = "dashboard";
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64").toString());
    userId = decoded.userId;
    flow = decoded.flow || "dashboard";
    if (!userId) throw new Error("No userId in state");
  } catch {
    return reply.redirect(`${frontendUrl}/register?error=invalid_state`);
  }

  try {
    // Exchange code for tokens via the provider
    const { accessToken, refreshToken, expiresAt } =
      await exchangeYouTubeCode(code);

    // Get channel details via the provider
    const channelInfo = await getYouTubeChannelInfo(accessToken);
    const handle = channelInfo.handle;
    const channelId = channelInfo.channelId;

    // Store both tokens encrypted as JSON
    const tokenPayload = JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    await (prisma as any).account_connections.upsert({
      where: { user_id_platform: { user_id: userId, platform: "youtube" } },
      create: {
        user_id: userId,
        platform: "youtube",
        platform_user_id: channelId,
        handle,
        encrypted_token: encryptToken(tokenPayload),
        token_expires_at: expiresAt,
        scopes: ["youtube.readonly", "youtube.upload", "youtube.force-ssl"],
        connected_at: new Date(),
      },
      update: {
        handle,
        encrypted_token: encryptToken(tokenPayload),
        token_expires_at: expiresAt,
        connected_at: new Date(),
      },
    });

    await (prisma as any).users.update({
      where: { id: userId },
      data: { youtube_handle: handle },
    });

    await cache.del(CacheKeys.user(userId));

    // Fire-and-forget niche detection
    triggerNicheDetection(userId, handle, "youtube").catch((err) =>
      logger.warn({ err }, "Background niche detection failed"),
    );

    // Determine redirect based on flow
    let redirectBase = "/onboarding";
    if (flow === "dashboard") {
      redirectBase = "/dashboard/profile";
    } else if (flow === "register") {
      redirectBase = "/register";
    }

    return reply.redirect(
      `${frontendUrl}${redirectBase}?success=youtube&handle=${handle}`,
    );
  } catch (err) {
    logger.error({ err }, "YouTube callback failed");
    const redirectBase = flow === "onboarding" ? "/onboarding" : "/register";
    return reply.redirect(`${frontendUrl}${redirectBase}?error=youtube_failed`);
  }
};

// ── GET /api/v1/integrations/status ──────────────────────────────────────
export const getConnectionStatus = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = (req as any).user;

  const connections = await (prisma as any).account_connections.findMany({
    where: { user_id: user.id },
    select: {
      platform: true,
      handle: true,
      connected_at: true,
      token_expires_at: true,
      platform_user_id: true,
    },
  });

  const statusMap = connections.reduce((acc: any, conn: any) => {
    const isExpired = conn.token_expires_at
      ? conn.token_expires_at < new Date()
      : false;
    acc[conn.platform] = {
      connected: true,
      handle: conn.handle,
      connectedAt: conn.connected_at,
      tokenExpired: isExpired,
      tokenExpiresAt: conn.token_expires_at,
    };
    return acc;
  }, {});

  return success(reply, { connections: statusMap });
};

// ── DELETE /api/v1/integrations/:platform ────────────────────────────────
export const disconnectPlatform = async (
  req: FastifyRequest<{ Params: { platform: string } }>,
  reply: FastifyReply,
) => {
  const user = (req as any).user;
  const { platform } = req.params;

  // Revoke tokens before deleting (best-effort)
  if (platform === "youtube") {
    try {
      const connection = await (prisma as any).account_connections.findFirst({
        where: { user_id: user.id, platform: "youtube" },
        select: { encrypted_token: true },
      });
      if (connection?.encrypted_token) {
        const decrypted = decryptToken(connection.encrypted_token);
        const payload = JSON.parse(decrypted) as {
          access_token: string;
          refresh_token: string;
        };
        await revokeYouTubeToken(payload.access_token);
      }
    } catch (revokeErr) {
      // Don't fail the disconnect if revoke fails — token will expire on its own
      logger.warn(
        { err: revokeErr, platform },
        "YouTube token revocation failed — proceeding with disconnect",
      );
    }
  }
  // Instagram: no reliable revoke endpoint — skip

  await (prisma as any).account_connections.deleteMany({
    where: { user_id: user.id, platform },
  });

  await cache.del(CacheKeys.user(user.id));
  return success(reply, { disconnected: true, platform });
};

// ── Niche detection (fire-and-forget) ────────────────────────────────────
// Runs after OAuth callback — scrapes the account and calls ARIA to detect
// niche + archetype. Saves result directly to DB. No queue needed.
async function triggerNicheDetection(
  userId: string,
  handle: string,
  platform: string,
) {
  logger.info({ userId, handle, platform }, "Niche detection started");

  let scrapedData: any = null;

  // Scrape whatever we can
  try {
    if (platform === "instagram") {
      scrapedData = await scraperService.scrapeAndSaveProfile(
        userId,
        handle,
        platform,
      );
    } else if (platform === "youtube") {
      scrapedData = await scrapeYouTubePublic(handle);
    }
  } catch (err: any) {
    logger.warn(
      { err: err.message, handle, platform },
      "Scrape failed during niche detection — using handle only",
    );
  }

  // Enhancement: fetch Instagram recent media captions for better niche detection
  let instagramCaptions: string[] = [];
  if (platform === "instagram") {
    try {
      const connection = await (prisma as any).account_connections.findFirst({
        where: { user_id: userId, platform: "instagram" },
        select: {
          encrypted_token: true,
          token_expires_at: true,
          platform_user_id: true,
        },
      });

      if (connection?.encrypted_token) {
        const decrypted = decryptToken(connection.encrypted_token);
        const validToken = await getValidInstagramToken(
          decrypted,
          connection.token_expires_at
            ? new Date(connection.token_expires_at)
            : null,
          async (newToken, newExpiresAt) => {
            await (prisma as any).account_connections.updateMany({
              where: { user_id: userId, platform: "instagram" },
              data: {
                encrypted_token: encryptToken(newToken),
                token_expires_at: newExpiresAt,
              },
            });
          },
        );

        // Pass the platform_user_id (IG professional account ID) to media endpoint
        const igUserId = connection.platform_user_id || "";
        const recentMedia = igUserId
          ? await fetchRecentMedia(igUserId, validToken.token, 12)
          : [];

        instagramCaptions = recentMedia
          .map((m: any) => m.caption)
          .filter((c: string) => c && c.length > 10);
      }
    } catch (mediaErr: any) {
      logger.warn(
        { err: mediaErr.message },
        "Media fetch failed — continuing without captions",
      );
    }
  }

  // Build ARIA prompt with whatever data we have
  const followers = scrapedData?.followers || scrapedData?.follower_count || 0;
  const engagement = scrapedData?.engagement_rate || "0";
  const topPosts =
    scrapedData?.scraped_summary?.topPosts ||
    scrapedData?.scraped_summary?.topHashtags ||
    [];
  const recentVideos = scrapedData?.recent_videos || [];
  const postCount = scrapedData?.scraped_summary?.totalPostsAnalyzed || 0;

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
${
  instagramCaptions.length > 0
    ? `Recent Instagram post captions:\n${instagramCaptions
        .slice(0, 8)
        .map((c, i) => `  ${i + 1}. "${c.slice(0, 200)}"`)
        .join("\n")}`
    : ""
}

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
  "strengths": ["Specific strength based on the data"],
  "gaps": ["Specific gap ARIA detected"],
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

  let ariaAnalysis: any;

  try {
    ariaAnalysis = await groqService._callGroq(prompt, {
      useLlama: true,
      maxTokens: 1200,
    });
  } catch (err) {
    logger.error(
      { err },
      "ARIA niche detection Groq call failed — using defaults",
    );
    ariaAnalysis = {
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

  // Save to DB
  await (prisma as any).users.update({
    where: { id: userId },
    data: {
      archetype: ariaAnalysis.archetype,
      niches: ariaAnalysis.detectedNiches,
      aria_profile: ariaAnalysis,
      onboarding_step: "analysed",
      aria_analyzed_at: new Date(),
    },
  });

  await cache.del(CacheKeys.user(userId));
  logger.info(
    { userId, niches: ariaAnalysis.detectedNiches },
    "Niche detection complete",
  );
}

// ── YouTube public scrape (reused from onboarding) ────────────────────────
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
