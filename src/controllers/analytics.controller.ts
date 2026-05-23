import { FastifyRequest, FastifyReply } from "fastify";
import * as groqService from "../services/ai/groq.service";
import * as scraperService from "../services/scraper.service";
import { cache, CacheKeys, TTL } from "../config/redis";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";
import { debitCredits } from "../services/credits.service";
import { alertDebitFailed } from "../utils/alerting";
import { getOrGenerateWeeklyReport } from "../services/weeklyReport.service";

/**
 * GET /api/v1/analytics/dashboard
 * Returns ARIA persona growth map. Platform-aware: reads youtube_scraped_summary
 * for YouTube-primary users, scraped_summary for Instagram-primary users.
 */
export const getDashboard = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    const cacheKey = CacheKeys.dashboard(user.id);

    const dashboard = await cache.getOrSet(
      cacheKey,
      async () => {
        // ── Load full user row to get both summary blobs ──────────────────
        const dbUser = await (prisma.users as any).findUnique({
          where: { id: user.id },
          select: {
            primary_platform: true,
            scraped_summary: true,
            youtube_scraped_summary: true,
            niches: true,
            follower_range: true,
            engagement_rate: true,
            creator_intent: true,
            archetype: true,
            tone_profile: true,
          },
        });

        const platform = dbUser?.primary_platform || user.primary_platform || "instagram";
        const isYouTube = platform === "youtube";

        // Pick the correct data blob for this platform
        const scrapedData = isYouTube
          ? (dbUser?.youtube_scraped_summary ?? null)
          : (dbUser?.scraped_summary ?? user.scraped_summary ?? null);

        const effectiveUser = { ...user, ...(dbUser || {}) };

        // ── Archetype detection (only if not yet set) ─────────────────────
        if (!effectiveUser.archetype) {
          let archetypeResult: any;
          try {
            archetypeResult = await groqService.detectArchetype({
              niche: effectiveUser.niches?.[0] || "general",
              platform,
              followerRange: effectiveUser.follower_range || "0-1K",
              creatorIntent: effectiveUser.creator_intent || "general",
              scrapedData,
            });
          } catch (e) {
            logger.warn({ e }, "Groq detectArchetype failed");
            archetypeResult = {
              archetype: "GENERAL",
              archetypeLabel: "Creator",
              archetypeConfidence: 0,
              growthStage: "UNKNOWN",
              toneProfile: "casual",
            };
          }

          // Persist archetype (fire-and-forget)
          prisma.users
            .update({
              where: { id: user.id },
              data: {
                archetype: archetypeResult.archetype,
                archetype_label: archetypeResult.archetypeLabel,
                archetype_confidence: archetypeResult.archetypeConfidence,
                growth_stage: archetypeResult.growthStage,
                tone_profile: archetypeResult.toneProfile,
                aria_analyzed_at: new Date(),
              },
            })
            .catch((err) => logger.error({ err }, "Failed to save archetype"));

          effectiveUser.archetype = archetypeResult.archetype;
          effectiveUser.tone_profile = archetypeResult.toneProfile;
        }

        // ── Full persona growth map ────────────────────────────────────────
        try {
          return await groqService.fullPersonaGrowthMap({
            niche: effectiveUser.niches?.[0] || "general",
            platform,
            followerRange: effectiveUser.follower_range || "0-1K",
            creatorIntent: effectiveUser.creator_intent || "general",
            scrapedData,                          // ← correct blob for platform
            engagementRate: effectiveUser.engagement_rate || 0,
          });
        } catch (e) {
          logger.warn({ e }, "Groq fullPersonaGrowthMap failed");
          return {
            personaSummary: "Data currently unavailable",
            growthStage: "UNKNOWN",
            currentHealthScore: 0,
          };
        }
      },
      TTL.DASHBOARD,
    );

    const hasAnyData = !!(
      (dashboard as any)?.growthRate ||
      (dashboard as any)?.currentHealthScore ||
      (dashboard as any)?.followers
    );

    return success(reply, { isEmpty: !hasAnyData, ...(dashboard as any) });
  } catch (err) {
    logger.error({ err }, "Dashboard failed");
    return errors.serviceDown(reply, "Analytics engine");
  }
};

/**
 * Get growth predictions and milestones — AI generated
 */
export const getGrowthPrediction = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const cacheKey = `growth:${user.id}`;

    const prediction = await cache.getOrSet(
      cacheKey,
      async () => {
        const prompt = `You are ARIA — India's creator intelligence engine.

Creator profile:
- Niche: ${user.niches?.[0] || "general"}
- Platform: ${user.primary_platform || "instagram"}
- Followers: ${user.follower_range || "Under 1K"}
- Engagement rate: ${user.engagement_rate || 0}%
- Archetype: ${user.archetype || "CREATOR"}
- Growth stage: ${user.growth_stage || "DISCOVERY"}

Generate realistic growth predictions for this Indian creator.

Respond ONLY with valid JSON:
{
  "currentFollowers": 0,
  "predictedIn30Days": 0,
  "predictedIn90Days": 0,
  "daysTo10K": null,
  "daysTo50K": null,
  "daysTo100K": null,
  "growthRate": "+X% weekly",
  "recommendation": "One actionable recommendation to accelerate growth",
  "milestones": [
    { "target": 10000, "eta": "X days", "reward": "What unlocks at this milestone in India" },
    { "target": 50000, "eta": "X days", "reward": "What unlocks at this milestone" },
    { "target": 100000, "eta": "X days", "reward": "What unlocks at this milestone" }
  ]
}`;

        return await groqService._callGroq(prompt, {
          useLlama: false,
          maxTokens: 600,
          model: modelToUse,
        });
      },
      TTL.DASHBOARD,
    );

    // Debit AFTER successful response (even for cached, middleware already checked)
    await debitCredits(
      user.id,
      "growth_roadmap",
      modelToUse,
      1500, // approx input tokens
      800, // approx output tokens
     
    ).catch((err) =>
      alertDebitFailed(user.id, "growth_roadmap", err),
    );

    return success(reply, {
      ...prediction,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Growth prediction failed");
    return errors.internal(reply);
  }
};

/**
 * Get optimal posting times — AI generated based on niche + platform
 */
export const getBestPostingTimes = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const cacheKey = `best-times:${user.id}`;

    const times = await cache.getOrSet(
      cacheKey,
      async () => {
        const prompt = `You are ARIA — India's creator intelligence engine.

Creator:
- Niche: ${user.niches?.[0] || "general"}
- Platform: ${user.primary_platform || "instagram"}
- Followers: ${user.follower_range || "Under 1K"}
- Location: India (IST timezone)

Generate the best posting times for this creator based on Indian audience behaviour.

Respond ONLY with valid JSON:
{
  "instagram": {
    "monday": ["7:00 PM", "9:00 AM"],
    "tuesday": ["8:00 PM", "12:00 PM"],
    "wednesday": ["7:00 PM", "6:00 PM"],
    "thursday": ["7:00 PM", "9:00 PM"],
    "friday": ["6:00 PM", "8:00 PM"],
    "saturday": ["11:00 AM", "7:00 PM"],
    "sunday": ["10:00 AM", "6:00 PM"]
  },
  "bestDay": "Wednesday",
  "bestTime": "7:00 PM IST",
  "timezone": "Asia/Kolkata",
  "note": "One sentence explaining why these times work for this niche in India"
}`;

        return await groqService._callGroq(prompt, {
          useLlama: false,
          maxTokens: 400,
          model: modelToUse,
        });
      },
      TTL.DASHBOARD,
    );

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "posting_package",
      modelToUse,
      800, // approx input tokens
      400, // approx output tokens
      
    ).catch((err) =>
      alertDebitFailed(user.id, "posting_package", err),
    );

    return success(reply, {
      ...times,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Best times failed");
    return errors.internal(reply);
  }
};

/**
 * Get competitor insights — AI generated
 */
export const getCompetitorInsights = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const cacheKey = `competitors:${user.id}`;

    const insights = await cache.getOrSet(
      cacheKey,
      async () => {
        const prompt = `You are ARIA — India's creator intelligence engine.

Creator:
- Niche: ${user.niches?.[0] || "general"}
- Platform: ${user.primary_platform || "instagram"}
- Followers: ${user.follower_range || "Under 1K"}
- Engagement rate: ${user.engagement_rate || 0}%

Generate realistic competitor analysis for Indian creators in this niche.
Use plausible Indian creator handles (do not use real people).

Respond ONLY with valid JSON:
{
  "competitors": [
    {
      "handle": "@handle",
      "followers": 0,
      "engagement": 0.0,
      "postsPerWeek": 0,
      "topFormat": "Reels|Carousels|Shorts",
      "gap": "Specific gap this creator is missing that you can fill"
    }
  ],
  "yourAdvantage": "One sentence about what gives this creator an edge over competitors"
}`;

        return await groqService._callGroq(prompt, {
          useLlama: false,
          maxTokens: 500,
          model: modelToUse,
        });
      },
      TTL.DASHBOARD,
    );

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "competitor_gap",
      modelToUse,
      1200, // approx input tokens
      600, // approx output tokens
     
    ).catch((err) =>
      alertDebitFailed(user.id, "competitor_gap", err),
    );

    return success(reply, {
      ...insights,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Competitor insights failed");
    return errors.internal(reply);
  }
};

/**
 * Get weekly performance report — served from worker-pre-generated cache when available
 */
export const getWeeklyReport = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const report = await getOrGenerateWeeklyReport(user.id);

    await debitCredits(user.id, "weekly_report", modelToUse, 1000, 700).catch(
      (err) => alertDebitFailed(user.id, "weekly_report", err),
    );

    return success(reply, {
      ...report,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Weekly report failed");
    return errors.internal(reply);
  }
};

/**
 * Get detected creator archetype
 */
export const getArchetype = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    if (!user.archetype) {
      const dbUser = await prisma.users.findUnique({
        where: { id: user.id },
        select: {
          archetype: true,
          archetype_label: true,
          archetype_confidence: true,
          growth_stage: true,
          tone_profile: true,
          aria_analyzed_at: true,
        },
      });

      if (!dbUser?.archetype) {
        return reply.status(202).send({
          status: "analyzing",
          message:
            "ARIA is detecting your archetype. Check back in 30 seconds.",
        });
      }

      return success(reply, {
        archetype: dbUser.archetype,
        archetypeLabel: dbUser.archetype_label,
        archetypeConfidence: dbUser.archetype_confidence,
        growthStage: dbUser.growth_stage,
        toneProfile: dbUser.tone_profile,
        analyzedAt: dbUser.aria_analyzed_at,
      });
    }

    return success(reply, {
      archetype: user.archetype,
      archetypeLabel: user.archetype_label,
      archetypeConfidence: user.archetype_confidence,
      growthStage: user.growth_stage,
      toneProfile: user.tone_profile,
    });
  } catch (err) {
    logger.error({ err }, "Get archetype failed");
    return errors.internal(reply);
  }
};

/**
 * Trigger scrape for a handle — runs inline, no queue
 */
export interface TriggerScrapeBody {
  handle: string;
  platform: string;
}

export const triggerScrape = async (
  req: FastifyRequest<{ Body: TriggerScrapeBody }>,
  reply: FastifyReply,
) => {
  const { handle, platform } = req.body;
  const user = req.user as User;

  try {
    if (!handle?.trim()) {
      return errors.badRequest(reply, "Handle cannot be empty");
    }

    // Save handle to DB first
    await prisma.users.update({
      where: { id: user.id },
      data: {
        ...(platform === "instagram" && { instagram_handle: handle }),
        ...(platform === "youtube" && { youtube_handle: handle }),
        scraped_at: null,
      },
    });

    // Run scrape inline — fire-and-forget so response is immediate
    scraperService
      .scrapeAndSaveProfile(user.id, handle, platform)
      .then(() => {
        logger.info(
          { userId: user.id, handle, platform },
          "Background scrape complete",
        );
        // Bust dashboard cache so next load gets fresh data
        cache.del(CacheKeys.dashboard(user.id)).catch(() => {});
        cache.del(CacheKeys.user(user.id)).catch(() => {});
      })
      .catch((err) => logger.warn({ err, handle }, "Background scrape failed"));

    return reply.status(202).send({
      status: "scraping",
      message: `Scraping ${platform} handle @${handle}. Analysis will be ready in 2–3 minutes.`,
      handle,
      platform,
    });
  } catch (err) {
    logger.error({ err }, "Trigger scrape failed");
    return errors.internal(reply);
  }
};
