// src/controllers/roadmap.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// Roadmap Controller
//
// Handles requests for personalised growth roadmaps.
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";
import { generatePersonalisedRoadmap } from "../services/roadmap.service";

export const getPersonalisedRoadmap = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    const cacheKey = `roadmap:${user.id}`;

    // Check if force refresh is requested
    const force = (req.query as any)?.force === "true";

    if (!force) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return success(reply, { ...cached, fromCache: true });
      }
    }

    // Fetch full user data with everything we need
    const fullUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: {
        archetype: true,
        archetype_label: true,
        primary_platform: true,
        follower_range: true,
        engagement_rate: true,
        growth_stage: true,
        creator_intent: true,
        scraped_summary: true,
        aria_last_analysis: true,
        niches: true,
      },
    });

    if (!fullUser) {
      return errors.notFound(reply, "User not found");
    }

    const roadmap = await generatePersonalisedRoadmap(user.id, {
      ...user,
      ...fullUser,
    });

    return success(reply, { ...roadmap, fromCache: false });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, "Get roadmap failed");
    return errors.internal(reply, "Failed to generate roadmap");
  }
};

export const refreshRoadmap = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    // Invalidate cache
    const cacheKey = `roadmap:${user.id}`;
    await cache.del(cacheKey);

    // Fetch and regenerate
    const fullUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: {
        archetype: true,
        archetype_label: true,
        primary_platform: true,
        follower_range: true,
        engagement_rate: true,
        growth_stage: true,
        creator_intent: true,
        scraped_summary: true,
        aria_last_analysis: true,
        niches: true,
      },
    });

    if (!fullUser) {
      return errors.notFound(reply, "User not found");
    }

    const roadmap = await generatePersonalisedRoadmap(user.id, {
      ...user,
      ...fullUser,
    });

    return success(reply, { ...roadmap, refreshed: true });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, "Refresh roadmap failed");
    return errors.internal(reply, "Failed to refresh roadmap");
  }
};
