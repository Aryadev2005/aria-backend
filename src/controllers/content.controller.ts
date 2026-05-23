import { FastifyRequest, FastifyReply } from "fastify";
import * as groqService from "../services/ai/groq.service";
import { prisma } from "../config/database";
import { success, errors, paginated } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";
import { debitCredits } from "../services/credits.service";
import { alertDebitFailed } from "../utils/alerting";

export interface GenerateContentBody {
  trendTitle: string;
  platform: string;
  niche?: string;
  songTitle?: string;
  tone?: string;
  language?: string;
}

/**
 * Generate full content package (hook, caption, hashtags, etc.)
 */
export const generateContent = async (
  req: FastifyRequest<{ Body: GenerateContentBody }>,
  reply: FastifyReply,
) => {
  const { trendTitle, platform, niche, songTitle, tone, language } = req.body;
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const content = await groqService.generateContent({
      trendTitle,
      platform,
      niche: niche || user.niches?.[0] || "fashion",
      followerRange: user.follower_range || "10K–50K",
      songTitle,
      tone,
      language,
      archetype: user.archetype,
      model: modelToUse,
    });

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "content_generation",
      modelToUse,
      2000, // approx input tokens
      1000, // approx output tokens
      
    ).catch((err) =>
      alertDebitFailed(user.id, "content_generation", err),
    );

    // Save to history async — don't block response
    prisma.content_history
      .create({
        data: {
          user_id: user.id,
          trend_title: trendTitle,
          platform,
          niche: niche || user.niches?.[0] || "fashion",
          hook: content.hook,
          caption: content.caption,
          hashtags: content.hashtags || [],
          best_time_to_post: content.bestTimeToPost,
          content_format: content.contentFormat,
          thumbnail_text: content.thumbnailText,
          cta: content.cta,
          created_at: new Date(),
        },
      })
      .catch((err) => logger.error({ err }, "Save content history failed"));

    return success(reply, {
      ...content,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Content generation failed");
    return errors.serviceDown(reply, "AI content generator");
  }
};

export interface GenerateHooksBody {
  topic: string;
  platform: string;
  niche?: string;
}

/**
 * Generate multiple viral hooks for a topic
 */
export const generateHooks = async (
  req: FastifyRequest<{ Body: GenerateHooksBody }>,
  reply: FastifyReply,
) => {
  const { topic, platform, niche } = req.body;
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const result = await groqService.generateHooks({
      topic,
      platform,
      niche: niche || user.niches?.[0] || "fashion",
      followerRange: user.follower_range || "10K–50K",
      archetype: user.archetype,
      model: modelToUse,
    });

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "hook_rewrite",
      modelToUse,
      800, // approx input tokens
      400, // approx output tokens
     
    ).catch((err) =>
      alertDebitFailed(user.id, "hook_rewrite", err),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Hook generation failed");
    return errors.serviceDown(reply, "AI hook generator");
  }
};

export interface RewriteHookBody {
  hook: string;
  platform: string;
  niche?: string;
}

/**
 * Rewrite a specific hook to be more engaging
 */
export const rewriteHook = async (
  req: FastifyRequest<{ Body: RewriteHookBody }>,
  reply: FastifyReply,
) => {
  const { hook, platform, niche } = req.body;
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const result = await groqService.rewriteHook({
      hook,
      platform,
      niche: niche || user.niches?.[0] || "fashion",
      archetype: user.archetype,
      model: modelToUse,
    });

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "hook_rewrite",
      modelToUse,
      600, // approx input tokens
      300, // approx output tokens
      
    ).catch((err) =>
      alertDebitFailed(user.id, "hook_rewrite", err),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Hook rewrite failed");
    return errors.serviceDown(reply, "AI rewriter");
  }
};

export interface RepurposeBody {
  content: string;
  sourcePlatform: string;
  targetPlatforms: string[];
}

/**
 * Repurpose content from one platform to another
 */
export const repurposeContent = async (
  req: FastifyRequest<{ Body: RepurposeBody }>,
  reply: FastifyReply,
) => {
  const { content, sourcePlatform, targetPlatforms } = req.body;
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const result = await groqService.repurposeContent({
      content,
      sourcePlatform,
      targetPlatforms,
      model: modelToUse,
    });

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "content_generation",
      modelToUse,
      2500, // approx input tokens (original content)
      1500, // approx output tokens (repurposed content)
     
    ).catch((err) =>
      alertDebitFailed(user.id, "content_generation", err),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Repurpose failed");
    return errors.serviceDown(reply, "AI repurposer");
  }
};

export interface AnalyseBody {
  caption: string;
  platform: string;
  niche?: string;
}

/**
 * Analyse draft content for performance
 */
export const analyseContent = async (
  req: FastifyRequest<{ Body: AnalyseBody }>,
  reply: FastifyReply,
) => {
  const { caption, platform, niche } = req.body;
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const result = await groqService.analyseContent({
      caption,
      platform,
      niche: niche || user.niches?.[0] || "fashion",
      archetype: user.archetype,
      model: modelToUse,
    });

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "caption_analysis",
      modelToUse,
      1200, // approx input tokens (caption)
      800, // approx output tokens (analysis)
     
    ).catch((err) =>
      alertDebitFailed(user.id, "caption_analysis", err),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Analysis failed");
    return errors.serviceDown(reply, "AI analyser");
  }
};

/**
 * Get history of generated content
 */
export const getHistory = async (
  req: FastifyRequest<{ Querystring: { page?: number; limit?: number } }>,
  reply: FastifyReply,
) => {
  const { page = 1, limit = 20 } = req.query;
  const user = req.user as User;
  const offset = (page - 1) * limit;

  try {
    const [items, total] = await Promise.all([
      prisma.content_history.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true,
          trend_title: true,
          platform: true,
          niche: true,
          hook: true,
          caption: true,
          hashtags: true,
          best_time_to_post: true,
          content_format: true,
          created_at: true,
        },
      }),
      prisma.content_history.count({ where: { user_id: user.id } }),
    ]);

    return paginated(reply, items, { page, limit, total });
  } catch (err) {
    logger.error({ err }, "Get history failed");
    return errors.internal(reply);
  }
};

/**
 * Delete a generated content item from history
 */
export const deleteContent = async (
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    const deleted = await prisma.content_history.deleteMany({
      where: { id: req.params.id, user_id: user.id },
    });
    if (deleted.count === 0) return errors.notFound(reply, "Content");
    return success(reply, { deleted: true });
  } catch (err) {
    logger.error({ err }, "Delete content failed");
    return errors.internal(reply);
  }
};
