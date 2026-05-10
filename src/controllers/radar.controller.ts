import { FastifyRequest, FastifyReply } from "fastify";
import * as radarService from "../services/radar.service";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { getPlatformContext } from "../utils/platformRouter";

export interface RadarQuery {
  niche?: string;
  platform?: string;
}

/**
 * Get real-time intelligence snapshot for a niche/platform
 */
export const getIntelligence = async (
  req: FastifyRequest<{ Querystring: RadarQuery }>,
  reply: FastifyReply,
) => {
  const user = req.user as any;
  try {
    const ctx = getPlatformContext(user);
    const niche = req.query.niche || ctx.niche;
    const platform = req.query.platform || ctx.platform;
    const archetype = ctx.archetype || "CREATOR";
    const followerRange = ctx.followerRange;

    let intelligence: any;
    try {
      intelligence = await radarService.getOrGenerateRadarSnapshot({
        niche,
        platform,
        archetype,
        followerRange,
      });
    } catch (e) {
      logger.warn({ e }, "Groq intelligence failed");
      intelligence = {
        ariaTopPick: {
          title: "Trend Intelligence loading...",
          reason: "Please try again in a moment.",
        },
        opportunities: [],
      };
    }

    return success(reply, {
      intelligence,
      meta: {
        niche,
        platform,
        archetype,
        generatedAt: new Date().toISOString(),
        fromCache: (intelligence as any).fromCache || false,
      },
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "getIntelligence failed");
    return errors.serviceDown(reply, "ARIA Intelligence");
  }
};

/**
 * Get competitor analysis and gaps
 */
export const getCompetitors = async (
  req: FastifyRequest<{ Querystring: RadarQuery }>,
  reply: FastifyReply,
) => {
  const user = req.user as any;
  try {
    const ctx = getPlatformContext(user);
    const niche = req.query.niche || ctx.niche;
    const platform = req.query.platform || ctx.platform;
    const archetype = ctx.archetype || "CREATOR";

    let data: any;
    try {
      data = await radarService.generateCompetitorIntelligence({
        niche,
        platform,
        archetype,
      });
    } catch (e) {
      logger.warn({ e }, "Groq competitor intel failed");
      data = { weeklyWinners: [], gaps: [] };
    }
    return success(reply, data);
  } catch (err) {
    logger.error({ err, userId: user.id }, "getCompetitors failed");
    return errors.serviceDown(reply, "ARIA Competitor Intel");
  }
};

/**
 * Get content inspiration and ideas grounded in trends
 */
export const getInspiration = async (
  req: FastifyRequest<{ Querystring: RadarQuery }>,
  reply: FastifyReply,
) => {
  const user = req.user as any;
  try {
    const ctx = getPlatformContext(user);
    const niche = req.query.niche || ctx.niche;
    const platform = req.query.platform || ctx.platform;
    const archetype = ctx.archetype || "CREATOR";
    const followerRange = ctx.followerRange;

    let data: any;
    try {
      data = await radarService.generateInspiration({
        niche,
        platform,
        archetype,
        followerRange,
      });
    } catch (e) {
      logger.warn({ e }, "Groq inspiration failed");
      data = { ideas: [] };
    }
    return success(reply, data);
  } catch (err) {
    logger.error({ err, userId: user.id }, "getInspiration failed");
    return errors.serviceDown(reply, "ARIA Inspiration");
  }
};
