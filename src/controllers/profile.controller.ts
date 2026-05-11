import { FastifyRequest, FastifyReply } from "fastify";
import * as profileSvc from "../services/profile.service";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { debitCredits } from "../services/credits.service";
import { prisma } from "../config/database";
import { cache, CacheKeys } from "../config/redis";
import { User } from "../types";
import * as creatorAnalyticsSvc from "../services/creator_analytics.service";
// GET /api/v1/profile/analytics
export const getAnalytics = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  try {
    const analytics = await profileSvc.getCreatorAnalytics(user.id, user);
    return success(reply, analytics);
  } catch (err) {
    logger.error({ err, userId: user.id }, "getAnalytics failed");
    return errors.serviceDown(reply, "ARIA Profile Analytics");
  }
};

// GET /api/v1/profile/me
export const getProfile = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    const row = await (prisma.users as any).findUnique({
      where: { id: user.id },
      select: {
        id: true,
        name: true,
        email: true,
        instagram_handle: true,
        youtube_handle: true,
        primary_platform: true,
        archetype: true,
        niches: true,
        follower_range: true,
        engagement_rate: true,
        onboarding_step: true,
        aria_analyzed_at: true,
        subscription_tier: true,
        follower_count: true,
      },
    });

    // Get memory count
    let memoryCount = 0;
    try {
      memoryCount = await prisma.aria_memory.count({
        where: { user_id: user.id },
      });
    } catch (_) {}

    return success(reply, {
      ...row,
      memoryCount,
      isOnboarded: row?.onboarding_step === "complete",
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "getProfile failed");
    return errors.internal(reply);
  }
};

// POST /api/v1/profile/refresh
export const refreshAnalytics = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  try {
    await cache.del(`profile:analytics:${user.id}`);
    const analytics = await profileSvc.getCreatorAnalytics(user.id, user);
    return success(reply, analytics);
  } catch (err) {
    logger.error({ err, userId: user.id }, "refreshAnalytics failed");
    return errors.serviceDown(reply, "ARIA Profile Refresh");
  }
};

export interface UpdatePlatformBody {
  platform: "instagram" | "youtube";
  handle: string;
}

// PATCH /api/v1/profile/platform  — existing endpoint, unchanged behaviour
export const updatePlatform = async (
  req: FastifyRequest<{ Body: UpdatePlatformBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { platform, handle } = req.body;

  try {
    if (platform === "instagram") {
      await (prisma.users as any).update({
        where: { id: user.id },
        data: {
          primary_platform: "instagram",
          instagram_handle: handle,
          onboarding_step: "pending",
          aria_analyzed_at: null,
        },
      });
    } else if (platform === "youtube") {
      await (prisma.users as any).update({
        where: { id: user.id },
        data: {
          primary_platform: "youtube",
          youtube_handle: handle,
          onboarding_step: "pending",
          aria_analyzed_at: null,
        },
      });
    }

    await bustAllUserCaches(user.id);
    logger.info({ userId: user.id, platform, handle }, "Platform updated");
    return success(reply, { updated: true, platform, handle });
  } catch (err) {
    logger.error({ err, userId: user.id }, "updatePlatform failed");
    return errors.internal(reply);
  }
};

// ── PATCH /api/v1/profile/switch-platform ─────────────────────────────────────
// User-facing platform switch. Requirements:
//   - Both accounts must be connected in account_connections
//   - If switching TO YouTube: youtube_scraped_summary must exist
//   - Does NOT reset archetype/niches — restores from the target platform's
//     stored summary so the switch is instant and data-rich
export interface SwitchPlatformBody {
  platform: "instagram" | "youtube";
}

export const switchPrimary = async (
  req: FastifyRequest<{ Body: SwitchPlatformBody }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { platform } = req.body;

  if (platform !== "instagram" && platform !== "youtube") {
    return errors.badRequest(reply, "platform must be 'instagram' or 'youtube'");
  }

  try {
    // ── 1. Verify both connections exist ──────────────────────────────────
    const connections = await (prisma as any).account_connections.findMany({
      where: { user_id: user.id },
      select: { platform: true },
    });
    const connectedPlatforms = connections.map((c: any) => c.platform as string);

    if (!connectedPlatforms.includes("instagram")) {
      return reply.status(400).send({
        success: false,
        error: "instagram_not_connected",
        message: "Connect your Instagram account first.",
      });
    }
    if (!connectedPlatforms.includes("youtube")) {
      return reply.status(400).send({
        success: false,
        error: "youtube_not_connected",
        message: "Connect your YouTube channel first.",
      });
    }

    // ── 2. If switching to YouTube, verify analytics have been fetched ─────
    if (platform === "youtube") {
      const dbUser = await (prisma as any).users.findUnique({
        where: { id: user.id },
        select: { youtube_scraped_summary: true },
      });
      if (!dbUser?.youtube_scraped_summary) {
        return reply.status(400).send({
          success: false,
          error: "youtube_analytics_not_ready",
          message:
            "Fetch your YouTube analytics first (Settings → Integrations → Fetch Analytics) before switching.",
        });
      }
    }

    // ── 3. Load target platform's stored summary to restore profile fields ─
    //    This makes the switch instant — no re-analysis needed.
    const fullUser = await (prisma as any).users.findUnique({
      where: { id: user.id },
      select: {
        scraped_summary: true,
        youtube_scraped_summary: true,
        niches: true,
      },
    });

    let platformPatch: Record<string, any> = { primary_platform: platform };

    if (platform === "youtube") {
      const ytSummary = fullUser?.youtube_scraped_summary as any;
      if (ytSummary) {
        // Restore YouTube-specific profile fields from stored summary
        platformPatch = {
          ...platformPatch,
          follower_count:   ytSummary.subscriberCount   ?? undefined,
          follower_range:   ytSummary.followerRange      ?? undefined,
          engagement_rate:  ytSummary.engagementRate
            ? parseFloat(String(ytSummary.engagementRate))
            : undefined,
        };
        // Restore niches from YouTube analysis if they exist
        if (ytSummary.detectedNiches?.length) {
          platformPatch.niches = ytSummary.detectedNiches;
        }
      }
    } else {
      // Switching back to Instagram — restore from scraped_summary
      const igSummary = fullUser?.scraped_summary as any;
      if (igSummary) {
        platformPatch = {
          ...platformPatch,
          follower_count:  igSummary.followerCount  ?? undefined,
          follower_range:  igSummary.followerRange  ?? undefined,
          engagement_rate: igSummary.engagementRate
            ? parseFloat(String(igSummary.engagementRate))
            : undefined,
        };
      }
    }

    // ── 4. Persist platform switch ─────────────────────────────────────────
    await (prisma as any).users.update({
      where: { id: user.id },
      data: platformPatch,
    });

    // ── 5. Bust ALL derived caches — order matters ─────────────────────────
    await bustAllUserCaches(user.id);

    logger.info({ userId: user.id, platform }, "Primary platform switched");
    return success(reply, { switched: true, platform });
  } catch (err) {
    logger.error({ err, userId: user.id }, "switchPrimary failed");
    return errors.internal(reply);
  }
};

// ── Internal helper — bust every cache that depends on platform ────────────────
async function bustAllUserCaches(userId: string): Promise<void> {
  await Promise.allSettled([
    cache.del(`profile:analytics:${userId}`),
    cache.del(`brain:mem:${userId}`),
    cache.del(`agent:memory:${userId}`),
    cache.del(CacheKeys.dashboard(userId)),
    cache.del(CacheKeys.user(userId)),
    cache.del(`roadmap:${userId}`),
    cache.del(`growth:${userId}`),
    cache.del(`weekly_report:${userId}`),
  ]);
}

// GET /api/v1/profile/creator-analytics
export const getCreatorAnalytics = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  try {
    // Try to return stored data first (fast path)
    const stored = await creatorAnalyticsSvc.getStoredCreatorAnalytics(user.id);
    if (stored) return success(reply, stored);

    // No stored data — check what accounts are connected
    const dbUser = await (prisma.users as any).findUnique({
      where: { id: user.id },
      select: {
        instagram_handle: true,
        youtube_handle: true,
        youtube_scraped_summary: true,
        niches: true,
        primary_platform: true,
      },
    });

    // Instagram path: full Apify analytics
    if (dbUser?.instagram_handle) {
      const niche = Array.isArray(dbUser.niches) ? dbUser.niches[0] : "general";
      const data = await creatorAnalyticsSvc.buildAndSaveCreatorAnalytics(
        user.id,
        dbUser.instagram_handle,
        niche || "general",
        false,
      );
      return success(reply, data);
    }

    // YouTube path: return the youtube_scraped_summary as lightweight analytics
    if (dbUser?.youtube_scraped_summary) {
      const yt = dbUser.youtube_scraped_summary as any;
      return success(reply, {
        platform: "youtube",
        handle: yt.handle,
        followerRange: yt.followerRange,
        followers: yt.subscriberCount,
        avgLikes: yt.avgLikesPerVideo,
        avgComments: yt.avgCommentsPerVideo,
        avgViews: yt.avgViewsPerVideo,
        engagementRate: parseFloat(yt.engagementRate) || 0,
        postsPerWeek: yt.postsPerWeek,
        topPosts: (yt.topVideos || []).map((v: any) => ({
          shortCode: v.videoId,
          type: "video",
          likes: v.likes,
          comments: v.comments,
          views: v.views,
          caption: v.title,
          url: `https://youtube.com/watch?v=${v.videoId}`,
        })),
        topHashtags: yt.topTags || [],
        scrapedAt: yt.fetchedAt,
        isFromCache: true,
      });
    }

    // No accounts at all
    return success(reply, null);
  } catch (err) {
    logger.error({ err, userId: user.id }, "getCreatorAnalytics failed");
    return errors.serviceDown(reply, "ARIA Creator Analytics");
  }
};

// POST /api/v1/profile/creator-analytics/refresh
export const refreshCreatorAnalytics = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  try {
    await cache.del(`creator_analytics:${user.id}`);

    const dbUser = await (prisma.users as any).findUnique({
      where: { id: user.id },
      select: {
        instagram_handle: true,
        youtube_handle: true,
        niches: true,
        primary_platform: true,
      },
    });

    // Instagram path
    if (dbUser?.instagram_handle) {
      const niche = Array.isArray(dbUser.niches) ? dbUser.niches[0] : "general";
      const data = await creatorAnalyticsSvc.buildAndSaveCreatorAnalytics(
        user.id,
        dbUser.instagram_handle,
        niche || "general",
        true,
      );
      return success(reply, data);
    }

    // YouTube path: re-run full fetch using stored OAuth token
    if (dbUser?.youtube_handle) {
      const { fetchAndSaveYouTubeAnalytics } =
        await import("../services/youtube_analytics.service");
      await fetchAndSaveYouTubeAnalytics(user.id);
      return success(reply, { refreshed: true, platform: "youtube" });
    }

    return reply
      .status(400)
      .send({ success: false, error: "No account connected" });
  } catch (err) {
    logger.error({ err, userId: user.id }, "refreshCreatorAnalytics failed");
    return errors.serviceDown(reply, "ARIA Creator Analytics Refresh");
  }
};

// POST /api/v1/profile/voice-portrait/rebuild (Manual trigger for testing)
export const rebuildVoicePortrait = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  try {
    const { buildVoicePortrait } = await import("../services/voice.service");

    logger.info(
      { userId: user.id },
      "Manually triggering voice portrait rebuild",
    );

    const portrait = await buildVoicePortrait(user.id);

    if (!portrait) {
      return errors.badRequest(
        reply,
        "Could not build voice portrait — insufficient data. Try generating more memories first by chatting with ARIA.",
      );
    }

    // Clear cache to force fresh fetch
    await cache.del(`aria_identity:${user.id}`);

    const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

    // Debit AFTER successful voice portrait rebuild
    await debitCredits(user.id, "voice_portrait", modelToUse, 4000, 2000).catch(
      (err) => logger.warn({ err }, "Debit failed — non-fatal"),
    );

    return success(reply, {
      message: "Voice portrait rebuilt successfully",
      summary: portrait.contentTerritory,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "rebuildVoicePortrait failed");
    return errors.serviceDown(reply, "Voice Portrait Rebuild");
  }
};
