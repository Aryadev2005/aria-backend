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
// YouTube OAuth stays completely untouched
import {
  generateYouTubeAuthUrl,
  exchangeYouTubeCode,
  getYouTubeChannelInfo,
  getValidYouTubeToken,
  revokeYouTubeToken,
  isTokenExpired,
  type YouTubeOAuthClientFlow,
} from "../providers/youtube.provider";

import {
  pickFrontendBaseFromOAuthState,
  resolveFrontendBaseForOAuth,
} from "../utils/oauth-frontend";

// ── Flow helpers (YouTube only — Instagram no longer uses OAuth) ──────────
function youtubeFlowFromStatePayload(flowRaw: unknown): YouTubeOAuthClientFlow {
  if (
    flowRaw === "register" ||
    flowRaw === "settings" ||
    flowRaw === "onboarding"
  )
    return flowRaw;
  return "settings";
}

function youtubeSuccessRedirectUrl(
  frontendUrl: string,
  flow: YouTubeOAuthClientFlow,
  handle: string,
): string {
  const h = encodeURIComponent(handle);
  if (flow === "onboarding")
    return `${frontendUrl}/onboarding?success=youtube&handle=${h}`;
  if (flow === "register")
    return `${frontendUrl}/register?oauth_success=youtube&handle=${h}`;
  return `${frontendUrl}/dashboard/settings?oauth_success=youtube&handle=${h}`;
}

function youtubeErrorRedirectUrl(
  frontendUrl: string,
  flow: YouTubeOAuthClientFlow,
  key: string,
): string {
  const k = encodeURIComponent(key);
  if (flow === "onboarding") return `${frontendUrl}/onboarding?error=${k}`;
  if (flow === "register") return `${frontendUrl}/register?oauth_error=${k}`;
  return `${frontendUrl}/dashboard/settings?oauth_error=${k}`;
}

// ── Encryption (YouTube tokens only — Instagram no longer stores tokens) ──
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
  if (!encryptedToken) return "";
  const [ivHex, encryptedHex] = encryptedToken.split(":");
  if (!ivHex || !encryptedHex) return "";
  try {
    const iv = Buffer.from(ivHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      getEncryptionKey(),
      iv,
    );
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    logger.warn({ err }, "Token decryption failed");
    return "";
  }
}

// ── POST /api/v1/integrations/instagram/connect-by-handle ─────────────────
// New simplified flow: user provides username → Apify scrapes → niche detected
export const connectInstagramByHandle = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = (req as any).user;
  const { handle } = req.body as { handle?: string };

  if (!handle || typeof handle !== "string") {
    return reply.status(400).send({
      success: false,
      error: "missing_handle",
      message: "Instagram username is required",
    });
  }

  // Sanitize: strip @ and whitespace
  const cleanHandle = handle.replace(/^@/, "").trim().toLowerCase();

  if (!cleanHandle || !/^[a-zA-Z0-9._]{1,30}$/.test(cleanHandle)) {
    return reply.status(400).send({
      success: false,
      error: "invalid_handle",
      message:
        "Please enter a valid Instagram username (letters, numbers, dots, underscores)",
    });
  }

  try {
    // Save handle to user record immediately
    await (prisma as any).account_connections.upsert({
      where: { user_id_platform: { user_id: user.id, platform: "instagram" } },
      create: {
        user_id: user.id,
        platform: "instagram",
        platform_user_id: cleanHandle,
        handle: cleanHandle,
        encrypted_token: "",
        connected_at: new Date(),
        scopes: ["public_scrape"],
      },
      update: {
        handle: cleanHandle,
        platform_user_id: cleanHandle,
        connected_at: new Date(),
      },
    });

    await (prisma as any).users.update({
      where: { id: user.id },
      data: { instagram_handle: cleanHandle },
    });

    await cache.del(CacheKeys.user(user.id));

    // Fire-and-forget: scrape + niche detection in background
    triggerNicheDetection(user.id, cleanHandle, "instagram").catch((err) =>
      logger.warn({ err }, "Background niche detection failed for Instagram"),
    );

    return success(reply, {
      connected: true,
      platform: "instagram",
      handle: cleanHandle,
      message: "Instagram connected. ARIA is analysing your profile…",
    });
  } catch (err: any) {
    logger.error(
      { err, handle: cleanHandle },
      "Instagram connect-by-handle failed",
    );
    return reply.status(500).send({
      success: false,
      error: "connection_failed",
      message: err.message || "Could not connect Instagram. Please try again.",
    });
  }
};

// ── GET /api/v1/integrations/youtube/auth-url ─────────────────────────────
export const getYoutubeAuthUrl = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = (req as any).user;

  if (!process.env.YOUTUBE_CLIENT_ID) {
    logger.error("YOUTUBE_CLIENT_ID not set — YouTube OAuth will fail");
    return reply
      .status(503)
      .send({ success: false, error: "YouTube OAuth not configured" });
  }

  const raw = String((req.query as { flow?: string })?.flow ?? "")
    .trim()
    .toLowerCase();
  const clientFlow: YouTubeOAuthClientFlow =
    raw === "register"
      ? "register"
      : raw === "onboarding"
        ? "onboarding"
        : "settings";
  const frontendBase = resolveFrontendBaseForOAuth(req);
  const url = generateYouTubeAuthUrl(user.id, clientFlow, frontendBase);
  return success(reply, { url });
};

// ── GET /api/v1/integrations/youtube/callback ─────────────────────────────
export const youtubeCallback = async (
  req: FastifyRequest<{
    Querystring: { code: string; state: string; error?: string };
  }>,
  reply: FastifyReply,
) => {
  const { code, state, error } = req.query;
  const envFrontendUrl = (
    process.env.FRONTEND_URL || "http://localhost:5173"
  ).replace(/\/+$/, "");

  const youtubeFlowFromStateString = (): {
    flow: YouTubeOAuthClientFlow;
    frontendUrl: string;
  } => {
    if (!state) return { flow: "settings", frontendUrl: envFrontendUrl };
    try {
      const decoded = JSON.parse(
        Buffer.from(state, "base64").toString(),
      ) as Record<string, unknown>;
      const flow = youtubeFlowFromStatePayload(decoded.flow);
      const frontendUrl = pickFrontendBaseFromOAuthState(
        decoded.fe,
        envFrontendUrl,
      );
      return { flow, frontendUrl };
    } catch {
      return { flow: "settings", frontendUrl: envFrontendUrl };
    }
  };

  if (error) {
    const { flow, frontendUrl } = youtubeFlowFromStateString();
    return reply.redirect(
      youtubeErrorRedirectUrl(frontendUrl, flow, "youtube_denied"),
    );
  }

  let userId: string;
  let clientFlow: YouTubeOAuthClientFlow = "settings";
  let frontendUrl = envFrontendUrl;
  try {
    const decoded = JSON.parse(
      Buffer.from(state, "base64").toString(),
    ) as Record<string, unknown>;
    userId = decoded.userId as string;
    if (!userId) throw new Error("No userId in state");
    clientFlow = youtubeFlowFromStatePayload(decoded.flow);
    frontendUrl = pickFrontendBaseFromOAuthState(decoded.fe, envFrontendUrl);
  } catch {
    return reply.redirect(
      youtubeErrorRedirectUrl(envFrontendUrl, "settings", "youtube_failed"),
    );
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

    return reply.redirect(
      youtubeSuccessRedirectUrl(frontendUrl, clientFlow, handle),
    );
  } catch (err: any) {
    logger.error(
      { err, message: err?.message, stack: err?.stack },
      "YouTube callback failed",
    );
    const errKey = err?.message?.includes("TOKEN_ENCRYPTION_KEY")
      ? "youtube_config_error"
      : err?.message?.includes("redirect_uri_mismatch") ||
          err?.message?.includes("redirect")
        ? "youtube_redirect_mismatch"
        : "youtube_failed";
    return reply.redirect(
      youtubeErrorRedirectUrl(frontendUrl, clientFlow, errKey),
    );
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

  // Only YouTube needs token revocation — Instagram is scrape-based, no token
  if (platform === "youtube") {
    try {
      const connection = await (prisma as any).account_connections.findFirst({
        where: { user_id: user.id, platform: "youtube" },
        select: { encrypted_token: true },
      });
      if (connection?.encrypted_token) {
        try {
          const decrypted = decryptToken(connection.encrypted_token);
          const payload = JSON.parse(decrypted) as {
            access_token: string;
            refresh_token: string;
          };
          await revokeYouTubeToken(payload.access_token);
        } catch (decryptErr) {
          logger.warn(
            { err: decryptErr },
            "Could not decrypt YouTube token — skipping revocation",
          );
        }
      }
    } catch (revokeErr) {
      logger.warn(
        { err: revokeErr, platform },
        "YouTube token revocation failed — proceeding anyway",
      );
    }
  }

  // Delete the connection row
  await (prisma as any).account_connections.deleteMany({
    where: { user_id: user.id, platform },
  });

  // For Instagram: also clear profile data from users table
  if (platform === "instagram") {
    await (prisma as any).users.update({
      where: { id: user.id },
      data: {
        instagram_handle: null,
        scraped_summary: null,
        scraped_at: null,
        engagement_rate: null,
        niches: [],
        archetype: null,
        archetype_label: null,
        aria_last_analysis: null,
        onboarding_step: null,
      },
    });
  }

  await cache.del(CacheKeys.user(user.id));
  logger.info({ userId: user.id, platform }, "Platform disconnected");
  return success(reply, { disconnected: true, platform });
};

// ── Niche detection (fire-and-forget) ────────────────────────────────────
// Runs after connection — scrapes the account and calls ARIA to detect
// niche + archetype. Saves result directly to DB. No queue needed.
async function triggerNicheDetection(
  userId: string,
  handle: string,
  platform: string,
) {
  logger.info({ userId, handle, platform }, "Niche detection started");

  let scrapedData: any = null;

  try {
    if (platform === "instagram") {
      // scrapeAndSaveProfile now returns _richData with all signals
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
      "Scrape failed — using handle only",
    );
  }

  // ── Pull rich data fields (Instagram only) ────────────────────────────────
  // All data comes from Apify — no separate Graph API call needed
  const richData = scrapedData?._richData || null;

  const followers =
    richData?.followers ||
    scrapedData?.followers ||
    scrapedData?.follower_count ||
    0;
  const engagement =
    richData?.engagementRate || scrapedData?.engagement_rate || "0";
  const postCount =
    richData?.totalPostsAnalyzed ||
    scrapedData?.scraped_summary?.totalPostsAnalyzed ||
    0;
  const topHashtags =
    richData?.topHashtags || scrapedData?.scraped_summary?.topHashtags || [];
  const biography = richData?.biography || "";
  const businessCat = richData?.businessCategory || "";
  const avgViews = richData?.avgViews || 0;
  const topMentions = richData?.topMentions || [];
  const taggedBrands = richData?.taggedBrands || [];
  const topLocations = richData?.topLocations || [];
  const recentCaptions: string[] = richData?.allCaptions?.slice(0, 12) || [];
  const recentVideos = scrapedData?.recent_videos || [];

  // ── Compute top reels for the prompt ─────────────────────────────────────
  const posts = richData?.posts || [];
  const reels = posts
    .filter((p: any) => p.isVideo)
    .sort((a: any, b: any) => (b.videoViewCount || 0) - (a.videoViewCount || 0))
    .slice(0, 10);

  const topReelsData = reels.slice(0, 5).map((p: any) => ({
    shortcode: p.shortCode,
    plays: p.videoViewCount || 0,
    likes: p.likesCount || 0,
    likeRate:
      followers > 0
        ? `${((p.likesCount / followers) * 100).toFixed(2)}%`
        : "0%",
    topic: p.caption?.slice(0, 60).replace(/\n/g, " ") || "No caption",
  }));

  const allPlays = posts
    .filter((p: any) => p.isVideo)
    .map((p: any) => p.videoViewCount || 0)
    .sort((a: number, b: number) => a - b);
  const medianPlays =
    allPlays.length > 0 ? allPlays[Math.floor(allPlays.length / 2)] : 0;

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

  // ── Build ARIA prompt — with rich Apify signals ─────────────────────────
  const prompt = `You are ARIA — India's creator intelligence engine.

Analyse this creator's profile and generate a complete intelligence summary.

Platform: ${platform}
Handle: @${handle}
Followers: ${followers.toLocaleString("en-IN")} (${followerRange})
Engagement Rate: ${engagement}%
Posts Analyzed: ${postCount}
${biography ? `Bio: "${biography}"` : ""}
${businessCat ? `Instagram Category: ${businessCat}` : ""}
${avgViews > 0 ? `Avg Video/Reel Views: ${avgViews.toLocaleString("en-IN")}` : ""}
${topHashtags.length > 0 ? `Top Hashtags: ${topHashtags.slice(0, 15).join(", ")}` : ""}
${topMentions.length > 0 ? `Frequently Mentioned Accounts: ${topMentions.slice(0, 10).join(", ")}` : ""}
${taggedBrands.length > 0 ? `Verified Accounts Tagged in Posts: ${taggedBrands.join(", ")}` : ""}
${topLocations.length > 0 ? `Posting Locations: ${topLocations.join(", ")}` : ""}
${
  recentVideos.length > 0
    ? `Recent Videos: ${recentVideos
        .slice(0, 5)
        .map((v: any) => v.title)
        .join(", ")}`
    : ""
}
${topReelsData.length > 0 ? `\nTop Performing Reels:\n${topReelsData.map((r: any, i: number) => `  ${i + 1}. [${r.shortcode}] ${r.plays} plays, ${r.likes} likes (${r.likeRate} like rate) - Topic: ${r.topic}`).join("\n")}` : ""}
${
  recentCaptions.length > 0
    ? `\nRecent Post Captions:\n${recentCaptions
        .slice(0, 10)
        .map((c: string, i: number) => `  ${i + 1}. "${c.slice(0, 300)}"`)
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
  "brandCategories": ["Fashion", "Beauty", "Lifestyle"],
  "topReels": [
    { "shortcode": "shortcode", "plays": 1000, "likes": 50, "likeRate": "5.0%", "topic": "Topic summary" }
  ],
  "medianPlays": ${medianPlays},
  "bestReelMultiplier": "1.5x median",
  "contentPatterns": {
    "whatWorked": "Specific hook or style that performed well",
    "whatDidnt": "Style that underperformed",
    "bestFormat": "Reels|Shorts|Carousel"
  }
}
`;

  // ── Call Groq ─────────────────────────────────────────────────────────────
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
        bestFormat: "Reels",
        postingFrequency: "3x/week",
        bestTime: "7:00 PM IST",
      },
      monetisationReadiness: 30,
      estimatedMonthlyEarning: "₹5,000–₹15,000",
      ariaMessage: "ARIA is still learning about you. Keep posting!",
      brandCategories: ["General"],
    };
  }

  // ── Save to DB ────────────────────────────────────────────────────────────
  await (prisma as any).users.update({
    where: { id: userId },
    data: {
      bio: biography || null,
      niches: ariaAnalysis.detectedNiches || ["general"],
      archetype: ariaAnalysis.archetype || "EDUCATOR",
      archetype_label: ariaAnalysis.archetypeLabel,
      archetype_confidence: ariaAnalysis.archetypeConfidence || 60,
      growth_stage: ariaAnalysis.growthStage || "DISCOVERY",
      follower_range: followerRange,
      aria_last_analysis: ariaAnalysis,
      aria_analyzed_at: new Date(),
      onboarding_step: "analysed",
    },
  });

  await cache.del(CacheKeys.user(userId));
  logger.info(
    { userId, handle, niches: ariaAnalysis.detectedNiches },
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
