import { FastifyRequest, FastifyReply } from "fastify";
import * as launchSvc from "../services/launch.service";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { debitCredits } from "../services/credits.service";
import { getPlatformContext } from "../utils/platformRouter";

// ─────────────────────────────────────────────────────────────────────────────
// GUARD — blocks incomplete profiles from getting silently wrong advice
// ─────────────────────────────────────────────────────────────────────────────

const requireArchetype = (
  archetype: string | null,
  reply: FastifyReply,
): boolean => {
  if (!archetype) {
    reply.code(422).send({
      success: false,
      error: "INCOMPLETE_PROFILE",
      message:
        "Complete your profile setup to unlock Launch intelligence. ARIA needs your archetype to personalise timing and brand recommendations.",
    });
    return false;
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/launch/package
// ─────────────────────────────────────────────────────────────────────────────

export const getPostingPackage = async (
  req: FastifyRequest<{ Body: { idea?: string; script?: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as any;
  const { idea, script } = req.body;

  try {
    const ctx = getPlatformContext(user);

    if (!requireArchetype(ctx.archetype, reply)) return;

    let pkg: any;
    try {
      pkg = await launchSvc.generatePostingPackage({
        niche: ctx.niche,
        platform: ctx.platform,
        archetype: ctx.archetype!,
        followerRange: ctx.followerRange,
        idea,
        script,
      });
    } catch (e) {
      logger.warn({ e }, "Posting package LLM failed — returning empty shell");
      pkg = {
        caption: "",
        firstComment: "",
        hashtags: { mega: [], mid: [], niche: [] },
        storyCopy: "",
        bestDayTime: "",
      };
    }

    // Fire-and-forget DB save — never block the response
    launchSvc.saveLaunchPackage(user.id, { idea, pkg }).catch(() => {});

    const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "posting_package",
      modelToUse,
      1500,
      800,
      0.000078,
    ).catch((err) => logger.warn({ err }, "Debit failed — non-fatal"));

    return success(reply, { ...pkg, creditsUsed: req.creditCheck?.cost ?? 0 });
  } catch (err) {
    logger.error({ err, userId: user.id }, "getPostingPackage failed");
    return errors.serviceDown(reply, "ARIA Launch");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/launch/timing
// ─────────────────────────────────────────────────────────────────────────────

export const getTimingIntelligence = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as any;

  try {
    const ctx = getPlatformContext(user);

    if (!requireArchetype(ctx.archetype, reply)) return;

    let timing: any;
    try {
      timing = await launchSvc.getTimingIntelligence({
        archetype: ctx.archetype!,
        niche: ctx.niche,
        platform: ctx.platform,
        followerRange: ctx.followerRange,
      });
    } catch (e) {
      logger.warn(
        { e },
        "Timing intelligence LLM failed — returning empty shell",
      );
      timing = {
        bestSlots: [],
        weeklyPattern: "",
        platformInsight: "",
        avoidWindows: [],
        nextBestSlot: "",
        nextBestSlotHoursAway: 0,
        ariaReason: "",
      };
    }

    const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "posting_package",
      modelToUse,
      1000,
      600,
      0.000055,
    ).catch((err) => logger.warn({ err }, "Debit failed — non-fatal"));

    return success(reply, {
      ...timing,
      creditsUsed: req.creditCheck?.cost ?? 0,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "getTimingIntelligence failed");
    return errors.serviceDown(reply, "ARIA Timing");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/launch/brand-alert
// ─────────────────────────────────────────────────────────────────────────────

export const getBrandAlert = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as any;

  try {
    const ctx = getPlatformContext(user);

    if (!requireArchetype(ctx.archetype, reply)) return;

    let alert: any;
    try {
      alert = await launchSvc.generateBrandAlert({
        niche: ctx.niche,
        platform: ctx.platform,
        archetype: ctx.archetype!,
        followerRange: ctx.followerRange,
        engagementRate: ctx.engagementRate,
      });
    } catch (e) {
      logger.warn({ e }, "Brand alert LLM failed — returning empty shell");
      alert = {
        brandOpportunities: [],
        pitchTemplate: { subject: "", body: "", whatsappVersion: "" },
        ariaAdvice: "",
      };
    }

    const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

    // Debit AFTER successful response
    await debitCredits(
      user.id,
      "brand_alert",
      modelToUse,
      1200,
      700,
      0.000063,
    ).catch((err) => logger.warn({ err }, "Debit failed — non-fatal"));

    return success(reply, {
      ...alert,
      creditsUsed: req.creditCheck?.cost ?? 0,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "getBrandAlert failed");
    return errors.serviceDown(reply, "ARIA Brand Alert");
  }
};
