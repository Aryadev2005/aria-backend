import { FastifyRequest, FastifyReply } from "fastify";
import * as groqService from "../services/ai/groq.service";
import { cache, CacheKeys, TTL } from "../config/redis";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";
import { debitCredits } from "../services/credits.service";
import { getVoicePortrait, buildVoicePortrait } from "../services/voice.service";
import { rankTrendsByVoiceFit, VoiceFitScore, scoreVoiceFit } from "../services/voiceFit.service";

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
  const user = req.user as User | undefined;

  try {
    const trends = await cache.getOrSet(
      cacheKey,
      async () => {
        const liveTrends = await prisma.live_trends.findMany({
          where: {
            expires_at: { gt: new Date() },
            niche_tags: { has: niche },
            ...(platform && platform !== "all"
              ? { platform_tags: { has: platform } }
              : {}),
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

    const trendsArray = Array.isArray(trends)
      ? trends
      : (trends as any)?.trends || [];
    let data = trendsArray as any[];
    if (badge !== "ALL") data = data.filter((t) => t.badge === badge);
    data = data.slice(0, limit);

    // ── Voice fit scoring (applies AFTER cache, per-user) ───────────────────
    let voiceProfiled = false;
    if (user) {
      const portrait = await getVoicePortrait(user.id).catch((err) => {
        logger.warn({ err }, "Failed to fetch voice portrait for getTrends");
        return null;
      });

      if (portrait) {
        voiceProfiled = true;
        const rankedTrends = rankTrendsByVoiceFit(data, portrait);
        return success(reply, { trends: rankedTrends, voiceProfiled });
      }
    }

    // No voice portrait — add neutral voiceFit to each trend
    const trendsWithNeutralFit = data.map((t) => ({
      ...t,
      voiceFit: {
        score: 50,
        grade: "B" as const,
        topicMatch: 0,
        toneMatch: 0,
        formatMatch: 10,
        languageMatch: 10,
        avoidPenalty: 0,
        reasons: ["Build your voice profile for personalized ranking"],
      } as VoiceFitScore,
    }));

    return success(reply, { trends: trendsWithNeutralFit, voiceProfiled });
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
    return errors.internal(reply);
  }
};

// ── VIRAL IDEAS — top 10 niche-matched global trends (48-72h prediction) ─────
export const getViralIdeas = async (
  req: FastifyRequest<{
    Querystring: { force?: string; browseNiche?: string };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const force = req.query.force === "true";
  const browseNiche = req.query.browseNiche?.trim().toLowerCase();
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  const dbUser = await (prisma.users as any).findUnique({
    where: { id: user.id },
    select: {
      id: true,
      niches: true,
      archetype: true,
      archetype_label: true,
      primary_platform: true,
      follower_range: true,
      instagram_handle: true,
      bio: true,
      scraped_summary: true,
      aria_last_analysis: true,
    },
  });

  if (!dbUser) {
    return errors.notFound(reply, "User not found");
  }

  const niches: string[] = (dbUser.niches as string[]) ?? [];

  // browseNiche = temporary exploration (not saved to DB)
  // If provided, use it as the active niche but keep permanent niche in context
  const activeNiche = browseNiche || niches[0] || "general";
  const platform = dbUser.primary_platform ?? "instagram";
  const scrapedSummary = (dbUser.scraped_summary as any) ?? {};
  const ariaAnalysis = (dbUser.aria_last_analysis as any) ?? {};

  const userContext = {
    userId: dbUser.id,
    niches: browseNiche ? [browseNiche, ...niches] : niches,
    archetype: dbUser.archetype ?? null,
    archetypeLabel: dbUser.archetype_label ?? null,
    instagramHandle: dbUser.instagram_handle ?? null,
    bio: dbUser.bio ?? null,
    topHashtags: scrapedSummary?.topHashtags ?? [],
    brandCategories: ariaAnalysis?.brandCategories ?? [],
    contentPatterns: ariaAnalysis?.contentPatterns ?? null,
  };

  // Browse cache is separate — doesn't pollute permanent niche cache
  const cacheKey = browseNiche
    ? `viral_ideas:${user.id}:browse:${browseNiche}`
    : `viral_ideas:${user.id}:${activeNiche}`;

  try {
    if (!force) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        logger.info(
          { activeNiche, browseNiche, userId: user.id },
          "Viral ideas cache hit",
        );
        const latestTrendCached = await (prisma as any).live_trends.findFirst({
          where: { niche_tags: { has: activeNiche } },
          orderBy: { fetched_at: "desc" },
          select: { fetched_at: true },
        });

        // ── Apply voice fit scoring to cached ideas (per-user) ────────────
        let cachedIdeas = cached;
        let voiceProfiled = false;
        const portrait = await getVoicePortrait(user.id).catch((err) => {
          logger.warn({ err }, "Failed to fetch voice portrait for cached viral ideas");
          return null;
        });

        if (portrait) {
          voiceProfiled = true;
          const rankedIdeas = rankTrendsByVoiceFit(cached, portrait);
          cachedIdeas = rankedIdeas;
        } else {
          // Add neutral voiceFit if no portrait
          cachedIdeas = cached.map((idea: any) => ({
            ...idea,
            voiceFit: {
              score: 50,
              grade: "B" as const,
              topicMatch: 0,
              toneMatch: 0,
              formatMatch: 10,
              languageMatch: 10,
              avoidPenalty: 0,
              reasons: ["Build your voice profile for personalized ranking"],
            } as VoiceFitScore,
          }));
        }

        return success(reply, {
          ideas: cachedIdeas,
          cached: true,
          niche: activeNiche,
          isBrowsing: !!browseNiche,
          updatedAt: latestTrendCached?.fetched_at ?? new Date(),
          voiceProfiled,
        });
      }
    }

    const { generateViralIdeas } =
      await import("../services/viralIdeas.service");

    // Add a hard 25s timeout so the request never hangs forever
    const ideas = await Promise.race([
      generateViralIdeas({
        platform,
        followerRange: dbUser.follower_range ?? "10K–50K",
        userContext,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), 25000),
      ),
    ]).catch((err) => {
      if (err.message === "TIMEOUT") {
        logger.warn(
          { userId: user.id },
          "getViralIdeas timed out — returning empty",
        );
        return [];
      }
      throw err;
    });

    // Browse cache: shorter TTL (30 min) — exploration is temporary
    // Permanent niche cache: 2 hours
    await cache.set(cacheKey, ideas, browseNiche ? 1800 : 7200);

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "viral_ideas",
      modelToUse,
      1500, // approx input tokens
      800, // approx output tokens
    
    ).catch((err) =>
      logger.warn({ err }, "Debit failed — non-fatal, ideas already returned"),
    );

    const latestTrend = await (prisma as any).live_trends.findFirst({
      where: { niche_tags: { has: activeNiche } },
      orderBy: { fetched_at: "desc" },
      select: { fetched_at: true },
    });

    // ── Apply voice fit scoring to fresh ideas (per-user) ───────────────
    let finalIdeas = ideas;
    let voiceProfiled = false;
    const portrait = await getVoicePortrait(user.id).catch((err) => {
      logger.warn({ err }, "Failed to fetch voice portrait for fresh viral ideas");
      return null;
    });

    if (portrait) {
      voiceProfiled = true;
      const rankedIdeas = rankTrendsByVoiceFit(ideas, portrait);
      finalIdeas = rankedIdeas;
    } else {
      // Add neutral voiceFit if no portrait
      finalIdeas = ideas.map((idea: any) => ({
        ...idea,
        voiceFit: {
          score: 50,
          grade: "B" as const,
          topicMatch: 0,
          toneMatch: 0,
          formatMatch: 10,
          languageMatch: 10,
          avoidPenalty: 0,
          reasons: ["Build your voice profile for personalized ranking"],
        } as VoiceFitScore,
      }));
    }

    return success(reply, {
      ideas: finalIdeas,
      cached: false,
      niche: activeNiche,
      isBrowsing: !!browseNiche,
      updatedAt: latestTrend?.fetched_at ?? new Date(),
      refreshedAt: new Date().toISOString(),
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
      voiceProfiled,
    });
  } catch (err) {
    logger.error({ err }, "Viral ideas failed");
    return errors.serviceDown(reply, "Trend ideas engine");
  }
};

// ── GET /api/v1/trends/voice-fit-preview ────────────────────────────────────
/**
 * Get the user's voice portrait summary and personalized recommendations
 * Auth: authenticateFirebase (no credit check — this is free)
 *
 * Returns:
 * - Voice portrait summary: toneSignature, primaryTopics, preferredFormats, contentTerritory, confidence
 * - Top 3 "perfect fit" niches (based on portrait)
 * - Top 3 "avoid" topics (based on portrait)
 */
export const getVoiceFitPreview = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    // Try to fetch existing portrait first
    let portrait = await getVoicePortrait(user.id).catch((err) => {
      logger.warn({ err }, "Failed to fetch voice portrait for preview");
      return null;
    });

    // If no portrait exists, try to build one (will be empty if no data)
    if (!portrait) {
      portrait = await buildVoicePortrait(user.id).catch((err) => {
        logger.warn(
          { err, userId: user.id },
          "Failed to build voice portrait for preview",
        );
        return null;
      });
    }

    if (!portrait) {
      // No portrait data available
      return success(reply, {
        hasPortrait: false,
        message: "No voice profile yet. Generate by completing Profile analysis.",
      });
    }

    // Build perfect fit and avoid recommendations
    const perfectFitNiches = portrait.primaryTopics?.slice(0, 3) || [];
    const avoidTopics = portrait.avoidTopics?.slice(0, 3) || [];

    return success(reply, {
      hasPortrait: true,
      portrait: {
        toneSignature: portrait.toneSignature,
        primaryTopics: portrait.primaryTopics,
        preferredFormats: portrait.preferredFormats,
        contentTerritory: portrait.contentTerritory,
        confidence: portrait.confidence,
        energyLevel: portrait.energyLevel,
        vocabularyLevel: portrait.vocabularyLevel,
        preferredLanguage: portrait.preferredLanguage,
      },
      recommendations: {
        perfectFit: perfectFitNiches,
        avoid: avoidTopics,
      },
      message:
        "Your voice profile is active. ARIA ranks trends for your unique voice.",
    });
  } catch (err) {
    logger.error({ err }, "Voice fit preview failed");
    return errors.internal(reply);
  }
};

// ── POST /api/v1/trends/interaction ──────────────────────────────────────────
export const recordTrendInteraction = async (
  req: FastifyRequest<{
    Body: {
      trendId?: string;
      trendTitle: string;
      source?: string;
      niche?: string;
      action: "viewed" | "saved" | "created" | "dismissed";
    };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { trendId, trendTitle, source, niche, action } = req.body;

  try {
    await prisma.trend_interactions.create({
      data: {
        user_id: user.id,
        trend_id: trendId || null,
        trend_title: trendTitle.substring(0, 200),
        source: source || null,
        niche: niche || null,
        action,
      },
    });
    return success(reply, { recorded: true });
  } catch (err) {
    // Non-fatal — never block UI for analytics failure
    logger.warn({ err }, "recordTrendInteraction failed");
    return success(reply, { recorded: false });
  }
};
