import { FastifyRequest, FastifyReply } from "fastify";
import * as profileSvc from "../services/profile.service";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { User } from "../types";
import * as creatorAnalyticsSvc from '../services/creator_analytics.service';
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

// PATCH /api/v1/profile/platform
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

    // Clear all caches for this user
    await Promise.allSettled([
      cache.del(`profile:analytics:${user.id}`),
      cache.del(`brain:mem:${user.id}`),
      cache.del(`agent:memory:${user.id}`),
    ]);

    logger.info({ userId: user.id, platform, handle }, "Platform updated");
    return success(reply, { updated: true, platform, handle });
  } catch (err) {
    logger.error({ err, userId: user.id }, "updatePlatform failed");
    return errors.internal(reply);
  }
};

// GET /api/v1/profile/creator-analytics
export const getCreatorAnalytics = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    // Try to return stored data first (fast path)
    const stored = await creatorAnalyticsSvc.getStoredCreatorAnalytics(user.id);
    if (stored) return success(reply, stored);

    // No data yet — check if they have a handle to trigger fresh analysis
    const dbUser = await (prisma.users as any).findUnique({
      where: { id: user.id },
      select: { instagram_handle: true, niches: true },
    });

    if (!dbUser?.instagram_handle) {
      return success(reply, null); // frontend shows "connect Instagram" prompt
    }

    const niche = Array.isArray(dbUser.niches) ? dbUser.niches[0] : 'general';
    const data = await creatorAnalyticsSvc.buildAndSaveCreatorAnalytics(
      user.id, dbUser.instagram_handle, niche || 'general', false
    );
    return success(reply, data);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getCreatorAnalytics failed');
    return errors.serviceDown(reply, 'ARIA Creator Analytics');
  }
};

// POST /api/v1/profile/creator-analytics/refresh
export const refreshCreatorAnalytics = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    await cache.del(`creator_analytics:${user.id}`);

    const dbUser = await (prisma.users as any).findUnique({
      where: { id: user.id },
      select: { instagram_handle: true, niches: true },
    });

    if (!dbUser?.instagram_handle) {
      return reply.status(400).send({ success: false, error: 'No Instagram account connected' });
    }

    const niche = Array.isArray(dbUser.niches) ? dbUser.niches[0] : 'general';
    const data = await creatorAnalyticsSvc.buildAndSaveCreatorAnalytics(
      user.id, dbUser.instagram_handle, niche || 'general', true
    );
    return success(reply, data);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'refreshCreatorAnalytics failed');
    return errors.serviceDown(reply, 'ARIA Creator Analytics Refresh');
  }
};
