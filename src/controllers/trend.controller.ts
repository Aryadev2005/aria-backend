import { FastifyRequest, FastifyReply } from "fastify";
import * as groqService from "../services/ai/groq.service";
import { cache, CacheKeys, TTL } from "../config/redis";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";

export interface GetTrendsQuery {
  niche?: string;
  platform?: string;
  badge?: string;
  page?: number;
  limit?: number;
}

/**
 * Get general trends filtered by niche and platform
 */
export const getTrends = async (
  req: FastifyRequest<{ Querystring: GetTrendsQuery }>,
  reply: FastifyReply,
) => {
  const {
    niche = "fashion",
    platform = "instagram",
    badge = "ALL",
    page = 1,
    limit = 10,
  } = req.query;

  const cacheKey = CacheKeys.trends(niche, platform) + `:${badge}:${page}`;

  try {
    const trends = await cache.getOrSet(
      cacheKey,
      async () => {
        const liveTrends = await prisma.live_trends.findMany({
          where: {
            expires_at: { gt: new Date() },
            niche_tags: { has: niche },
            platform_tags: { has: platform },
          },
          orderBy: { velocity: "desc" },
          take: limit,
          skip: (page - 1) * limit,
        });

        if (liveTrends.length >= 3) return liveTrends;

        // Fallback: generate with Groq
        try {
          return await groqService.generateTrendInsights({
            niche,
            platform,
            followerRange: "10K-100K",
            archetype: null,
          });
        } catch (e) {
          logger.warn({ e }, "Groq trend generation failed, returning empty");
          return [];
        }
      },
      TTL.TREND,
    );

    let data = trends as any[];
    if (badge !== "ALL") data = data.filter((t) => t.badge === badge);
    return success(reply, data.slice(0, limit));
  } catch (err) {
    logger.error({ err }, "Get trends failed");
    return errors.serviceDown(reply, "Trend engine");
  }
};

/**
 * Get personalized trends based on user's archetype and niche
 */
export const getPersonalizedTrends = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const niche = user.niches?.[0] || "fashion";
  const platform = user.primary_platform || "instagram";

  try {
    const cacheKey = `tr:personal:${user.id}`;

    const trends = await cache.getOrSet(
      cacheKey,
      async () => {
        const liveTrends = await prisma.live_trends.findMany({
          where: { expires_at: { gt: new Date() } },
          orderBy: { velocity: "desc" },
          take: 20,
          select: {
            title: true,
            search_volume: true,
            velocity: true,
            niche_tags: true,
            platform_tags: true,
          },
        });

        // Feed live data into Groq with user's archetype
        try {
          return await groqService.generateTrendInsights({
            niche,
            platform,
            followerRange: user.follower_range || "10K–50K",
            archetype: user.archetype,
            liveTrendsContext: liveTrends.map((t: any) => t.title).join(", "),
          });
        } catch (e) {
          logger.warn({ e }, "Groq personalized trends failed");
          return [];
        }
      },
      300,
    ); // 5 min cache per user

    return success(reply, trends);
  } catch (err) {
    logger.error({ err }, "Personalized trends failed");
    return errors.serviceDown(reply, "Trend engine");
  }
};

/**
 * Get high-opportunity trends
 */
export const getOpportunityWindows = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const user = req.user as User;
    let result: any;
    try {
      result = await groqService.generateTrendInsights({
        niche: user.niches?.[0] || "fashion",
        platform: user.primary_platform || "instagram",
        followerRange: user.follower_range || "10K–50K",
        archetype: user.archetype,
      });
    } catch (e) {
      logger.warn({ e }, "Groq opportunity windows failed");
      return success(reply, []);
    }

    // Filter to only trends with high opportunity score
    const windows = (result as any).trends
      .filter((t: any) => t.opportunityScore >= 85)
      .sort((a: any, b: any) => b.opportunityScore - a.opportunityScore);

    return success(reply, windows);
  } catch (err) {
    logger.error({ err }, "Opportunity windows failed");
    return errors.serviceDown(reply, "Trend engine");
  }
};

/**
 * Get top 5 viral trends
 */
export const getViralRadar = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const user = req.user as User;
    let result: any;
    try {
      result = await groqService.generateTrendInsights({
        niche: user.niches?.[0] || "fashion",
        platform: user.primary_platform || "instagram",
        followerRange: user.follower_range || "10K–50K",
        archetype: user.archetype,
      });
    } catch (e) {
      logger.warn({ e }, "Groq viral radar failed");
      return success(reply, []);
    }

    const viralTrends = (result as any).trends
      .filter((t: any) => t.badge === "HOT" || t.velocity >= 90)
      .slice(0, 5);

    return success(reply, viralTrends);
  } catch (err) {
    logger.error({ err }, "Viral radar failed");
    return errors.serviceDown(reply, "Trend engine");
  }
};

/**
 * Get single trend by ID
 */
export const getTrendById = async (
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  try {
    const cacheKey = CacheKeys.trendById(req.params.id);
    const cached = await cache.get(cacheKey);
    if (cached) return success(reply, cached);
    return errors.notFound(reply, "Trend");
  } catch (err) {
    return errors.internal(reply);
  }
};

/**
 * Save a trend for later
 */
export const saveTrend = async (
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  try {
    const user = req.user as User;
    const existing = await prisma.saved_trends.findFirst({
      where: { user_id: user.id, trend_id: req.params.id },
      select: { id: true },
    });

    if (!existing) {
      await prisma.saved_trends.create({
        data: {
          user_id: user.id,
          trend_id: req.params.id,
          saved_at: new Date(),
        },
      });
    }
    return success(reply, { saved: true });
  } catch (err) {
    logger.error({ err }, "Save trend failed");
    return errors.internal(reply);
  }
};

/**
 * Unsave a trend
 */
export const unsaveTrend = async (
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  try {
    const user = req.user as User;
    await prisma.saved_trends.deleteMany({
      where: { user_id: user.id, trend_id: req.params.id },
    });
    return success(reply, { unsaved: true });
  } catch (err) {
    logger.error({ err }, "Unsave trend failed");
    return errors.internal(reply);
  }
};

/**
 * Get all saved trends for user
 */
export const getSavedTrends = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const user = req.user as User;
    const trends = await prisma.saved_trends.findMany({
      where: { user_id: user.id },
      orderBy: { saved_at: "desc" },
      take: 50,
    });
    return success(reply, trends);
  } catch (err) {
    logger.error({ err }, "Get saved trends failed");
    return errors.internal(reply);
  }
};

export interface FeedbackBody {
  recommendationType: string;
  recommendationData: any;
  wasHelpful: boolean;
  resultNotes?: string;
}

/**
 * Submit feedback on ARIA's recommendations
 */
export const submitFeedback = async (
  req: FastifyRequest<{ Body: FeedbackBody }>,
  reply: FastifyReply,
) => {
  const { recommendationType, recommendationData, wasHelpful, resultNotes } =
    req.body;
  const user = req.user as User;
  try {
    const feedback = await prisma.aria_feedback.create({
      data: {
        user_id: user.id,
        recommendation_type: recommendationType,
        recommendation_data: recommendationData,
        was_helpful: wasHelpful,
        result_notes: resultNotes || null,
        created_at: new Date(),
      },
      select: { id: true, created_at: true },
    });

    return success(reply, {
      id: feedback.id,
      message: "Feedback recorded. ARIA learns from this!",
      createdAt: feedback.created_at,
    });
  } catch (err) {
    logger.error({ err }, "Submit feedback failed");
    return errors.internal(reply);
  }
};
