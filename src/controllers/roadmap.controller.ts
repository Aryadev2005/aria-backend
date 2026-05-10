// src/controllers/roadmap.controller.ts

import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";
import { debitCredits } from "../services/credits.service";
import {
  generatePersonalisedRoadmap,
  markRoadmapActionComplete,
  dismissRoadmapAction,
  loadActionStates,
} from "../services/roadmap.service";

// ── Pull EVERY field the AI needs to personalise the roadmap ──────────────────
// Missing fields here = generic output. This is the full set.
const USER_SELECT = {
  archetype: true,
  archetype_label: true,
  primary_platform: true,
  follower_range: true,
  follower_count: true, // ← was missing — actual number e.g. 7081
  engagement_rate: true, // ← stored as Decimal — the 35.83 figure
  growth_stage: true,
  creator_intent: true,
  scraped_summary: true, // ← full JSON blob from Apify scrape
  aria_last_analysis: true, // ← full onboarding analysis JSON
  niches: true,
  instagram_handle: true, // ← so prompt can reference @handle
  youtube_handle: true,
  tone_profile: true, // ← casual / educational / entertaining etc.
  bio: true, // ← their actual IG bio
};

// ── GET /api/v1/analytics/roadmap ─────────────────────────────────────────────
export const getPersonalisedRoadmap = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  // ?force=true bypasses BOTH the controller-level cache check AND
  // the service-level cache check — guarantees a fresh AI generation
  const force = (req.query as any)?.force === "true";
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    // Controller-level cache check (only for non-forced requests)
    if (!force) {
      const cached = await cache.get(`roadmap:${user.id}`);
      if (cached) {
        // Debit credits even for cached response (middleware already checked)
        await debitCredits(
          user.id,
          "growth_roadmap",
          modelToUse,
          3000, // approx input tokens (large context)
          1200, // approx output tokens
          0.000109, // approx cost USD
        ).catch((err) =>
          logger.warn(
            { err },
            "Debit failed — non-fatal, roadmap already returned",
          ),
        );

        return success(reply, {
          ...(cached as object),
          fromCache: true,
          creditsUsed: req.creditCheck?.cost ?? 0,
        });
      }
    }

    const fullUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: USER_SELECT,
    });
    if (!fullUser) return errors.notFound(reply, "User");

    // Pass force=true into service so it also skips its own internal cache
    const roadmap = await generatePersonalisedRoadmap(
      user.id,
      { ...user, ...fullUser },
      force,
      modelToUse,
    );

    // Debit AFTER successful AI generation
    await debitCredits(
      user.id,
      "growth_roadmap",
      modelToUse,
      3000, // approx input tokens (large context)
      1200, // approx output tokens
      0.000109, // approx cost USD
    ).catch((err) =>
      logger.warn(
        { err },
        "Debit failed — non-fatal, roadmap already returned",
      ),
    );

    return success(reply, {
      ...roadmap,
      fromCache: false,
      creditsUsed: req.creditCheck?.cost ?? 0,
    });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, "Get roadmap failed");
    return errors.internal(reply, "Failed to generate roadmap");
  }
};

// ── GET /api/v1/analytics/roadmap/refresh ─────────────────────────────────────
export const refreshRoadmap = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    // Explicit cache delete first (belt + suspenders alongside force=true)
    await cache.del(`roadmap:${user.id}`);

    const fullUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: USER_SELECT,
    });
    if (!fullUser) return errors.notFound(reply, "User");

    const roadmap = await generatePersonalisedRoadmap(
      user.id,
      { ...user, ...fullUser },
      true,
      modelToUse,
    );

    // Debit AFTER successful AI generation
    await debitCredits(
      user.id,
      "growth_roadmap",
      modelToUse,
      3000, // approx input tokens (large context)
      1200, // approx output tokens
      0.000109, // approx cost USD
    ).catch((err) =>
      logger.warn(
        { err },
        "Debit failed — non-fatal, roadmap already returned",
      ),
    );

    return success(reply, {
      ...roadmap,
      refreshed: true,
      fromCache: false,
      creditsUsed: req.creditCheck?.cost ?? 0,
    });
  } catch (err: any) {
    logger.error(
      { err: err.message, userId: user.id },
      "Refresh roadmap failed",
    );
    return errors.internal(reply, "Failed to refresh roadmap");
  }
};

// ── GET /api/v1/analytics/roadmap/action-states?version=xxx ──────────────────
// Returns the completed/dismissed state of every action for a roadmap version.
// The frontend calls this on mount to restore persisted checkboxes.
export const getActionStates = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const version = (req.query as any)?.version as string | undefined;

  if (!version)
    return errors.validation(reply, "version query param is required");

  try {
    const states = await loadActionStates(user.id, version);
    return success(reply, { states, version });
  } catch (err: any) {
    logger.error(
      { err: err.message, userId: user.id },
      "getActionStates failed",
    );
    return errors.internal(reply, "Failed to load action states");
  }
};

// ── POST /api/v1/analytics/roadmap/action/complete ───────────────────────────
export const completeRoadmapAction = async (
  req: FastifyRequest<{
    Body: {
      roadmapVersion: string;
      weekNumber: number;
      actionIndex: number;
      actionText: string;
    };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { roadmapVersion, weekNumber, actionIndex, actionText } = req.body;

  // Basic validation
  if (
    !roadmapVersion ||
    weekNumber == null ||
    actionIndex == null ||
    !actionText
  ) {
    return errors.validation(
      reply,
      "roadmapVersion, weekNumber, actionIndex, actionText are required",
    );
  }

  try {
    await markRoadmapActionComplete(
      user.id,
      roadmapVersion,
      weekNumber,
      actionIndex,
      actionText,
    );
    return success(reply, { completed: true });
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId: user.id },
      "completeRoadmapAction failed",
    );
    // Non-fatal — never block UI
    return success(reply, { completed: false });
  }
};

// ── POST /api/v1/analytics/roadmap/action/dismiss ────────────────────────────
export const dismissRoadmapActionHandler = async (
  req: FastifyRequest<{
    Body: {
      roadmapVersion: string;
      weekNumber: number;
      actionIndex: number;
      actionText: string;
    };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { roadmapVersion, weekNumber, actionIndex, actionText } = req.body;

  if (
    !roadmapVersion ||
    weekNumber == null ||
    actionIndex == null ||
    !actionText
  ) {
    return errors.validation(
      reply,
      "roadmapVersion, weekNumber, actionIndex, actionText are required",
    );
  }

  try {
    await dismissRoadmapAction(
      user.id,
      roadmapVersion,
      weekNumber,
      actionIndex,
      actionText,
    );
    return success(reply, { dismissed: true });
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId: user.id },
      "dismissRoadmapAction failed",
    );
    return success(reply, { dismissed: false });
  }
};
