// src/controllers/thumbnail.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// Thumbnail Variants API — Generate and manage A/B/C thumbnail concepts
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { debitCredits } from "../services/credits.service";
import { alertDebitFailed } from "../utils/alerting";
import { User } from "../types";
import {
  generateThumbnailVariants,
} from "../services/thumbnailVision.service";
import { getVoicePortrait } from "../services/voice.service";
import type { ThumbnailVariant } from "../types/thumbnail.types";

// ─────────────────────────────────────────────────────────────────────────────
// 1. generateVariants — POST /api/v1/thumbnail/variants/generate
//
// Auth: authenticateFirebase + requireCredits('thumbnail_variants')
// Body: { studioSessionId: string, hookLine: string, idea: string, niche?: string, platform?: string }
//
// Fetches studio session for archetype + voice portrait
// Calls generateThumbnailVariants() from thumbnailVision.service
// Saves result to thumbnail_variants table (status: 'draft')
// Returns: { variantId: string, variants: ThumbnailVariant[] }
// ─────────────────────────────────────────────────────────────────────────────

export const generateVariants = async (
  req: FastifyRequest<{
    Body: {
      studioSessionId: string;
      hookLine: string;
      idea: string;
      niche?: string;
      platform?: string;
    };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { studioSessionId, hookLine, idea, niche, platform } = req.body;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  logger.info(
    { userId: user.id, studioSessionId },
    "Thumbnail variants generation started",
  );

  try {
    // Fetch studio session to get script metadata (archetype, tone)
    const studioSession = await prisma.studio_scripts.findUnique({
      where: { id: studioSessionId },
      select: {
        user_id: true,
        archetype: true,
        tone_signature: true,
        niche: true,
        platform: true,
      },
    });

    if (!studioSession) {
      return errors.notFound(reply, "Studio Session");
    }

    // Verify user owns the session
    if (studioSession.user_id !== user.id) {
      return errors.forbidden(reply, "Studio Session");
    }

    // Resolve niche and platform from params or session
    const resolvedNiche = niche || studioSession.niche || "general";
    const resolvedPlatform =
      (platform as "instagram" | "youtube") ||
      (studioSession.platform as "instagram" | "youtube") ||
      "youtube";

    // Fetch user's voice portrait if available (for tone consistency)
    let voicePortrait: any = null;
    try {
      voicePortrait = await getVoicePortrait(user.id);
    } catch {
      // Voice portrait is optional — continue without it
      logger.debug({ userId: user.id }, "Voice portrait not available");
    }

    // Generate variants using the thumbnail vision service
    const variants = await generateThumbnailVariants({
      hookLine,
      idea,
      niche: resolvedNiche,
      platform: resolvedPlatform,
      archetype: studioSession.archetype || "EDUCATOR",
      toneSignature: voicePortrait?.toneSignature || studioSession.tone_signature,
    });

    // Save to database
    const variantRecord = await prisma.thumbnail_variants.create({
      data: {
        user_id: user.id,
        studio_session_id: studioSessionId,
        variants: variants as any,
        status: "draft",
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      },
    });

    logger.info(
      { userId: user.id, studioSessionId, variantId: variantRecord.id },
      "Thumbnail variants generated successfully",
    );

    // Debit credits (non-fatal)
    await debitCredits(user.id, "thumbnail_variants", modelToUse, 800, 400).catch(
      (err: any) => alertDebitFailed(user.id, "thumbnail_variants", err),
    );

    const responsePayload = {
      variantId: variantRecord.id,
      variants,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    };

    return success(reply, responsePayload);
  } catch (err: any) {
    logger.error(
      { err: err.message, userId: user.id, studioSessionId },
      "Thumbnail variants generation failed",
    );
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. getVariants — GET /api/v1/thumbnail/variants/:studioSessionId
//
// Auth: authenticateFirebase only
// Returns: the most recent non-expired draft for this session
// Returns 404 if none found
// Filters: expires_at > NOW() and user_id = req.user.id (security)
// ─────────────────────────────────────────────────────────────────────────────

export const getVariants = async (
  req: FastifyRequest<{ Params: { studioSessionId: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { studioSessionId } = req.params;

  logger.info({ userId: user.id, studioSessionId }, "Fetching thumbnail variants");

  try {
    // Verify the session belongs to the user
    const session = await prisma.studio_scripts.findUnique({
      where: { id: studioSessionId },
      select: { user_id: true },
    });

    if (!session || session.user_id !== user.id) {
      return errors.notFound(reply, "Studio Session");
    }

    // Get most recent non-expired draft
    const variant = await prisma.thumbnail_variants.findFirst({
      where: {
        studio_session_id: studioSessionId,
        user_id: user.id,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: "desc" },
    });

    if (!variant) {
      return errors.notFound(reply, "Thumbnail Variants");
    }

    logger.info(
      { userId: user.id, studioSessionId, variantId: variant.id },
      "Thumbnail variants fetched",
    );

    return success(reply, {
      variantId: variant.id,
      variants: variant.variants as ThumbnailVariant[],
      status: variant.status,
      createdAt: variant.created_at,
      expiresAt: variant.expires_at,
    });
  } catch (err: any) {
    logger.error(
      { err: err.message, userId: user.id, studioSessionId },
      "Failed to fetch thumbnail variants",
    );
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. updateVariantStatus — PATCH /api/v1/thumbnail/variants/:id/status
//
// Auth: authenticateFirebase
// Body: { status: 'rotating' | 'decided', winner?: 'a' | 'b' | 'c', videoId?: string }
//
// Validates user owns the variant (user_id check)
// When status → 'rotating': sets rotation_started_at = NOW(), rotation_ends_at = NOW() + 48h
// When status → 'decided': sets winner, clears rotation fields
// Returns: updated record
// ─────────────────────────────────────────────────────────────────────────────

export const updateVariantStatus = async (
  req: FastifyRequest<{
    Params: { id: string };
    Body: {
      status: "rotating" | "decided";
      winner?: "a" | "b" | "c";
      videoId?: string;
    };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { id } = req.params;
  const { status, winner, videoId } = req.body;

  logger.info({ userId: user.id, variantId: id, status }, "Updating variant status");

  try {
    // Verify user owns the variant
    const existing = await prisma.thumbnail_variants.findUnique({
      where: { id },
      select: { user_id: true, status: true },
    });

    if (!existing) {
      return errors.notFound(reply, "Thumbnail Variant");
    }

    if (existing.user_id !== user.id) {
      return errors.forbidden(reply, "Thumbnail Variant");
    }

    // Prepare update payload
    const updateData: any = { status };

    if (status === "rotating") {
      // Start rotation: 48-hour window
      updateData.rotation_started_at = new Date();
      updateData.rotation_ends_at = new Date(Date.now() + 48 * 60 * 60 * 1000);
      if (videoId) {
        updateData.video_id = videoId;
      }
    } else if (status === "decided") {
      // End rotation: set winner, clear rotation fields
      if (!winner || !["a", "b", "c"].includes(winner)) {
        return errors.error(
          reply,
          'When status="decided", winner must be "a", "b", or "c"',
          400,
          "VALIDATION_ERROR",
        );
      }
      updateData.winner = winner;
      updateData.rotation_started_at = null;
      updateData.rotation_ends_at = null;
    }

    // Update in database
    const updated = await prisma.thumbnail_variants.update({
      where: { id },
      data: updateData,
    });

    logger.info(
      { userId: user.id, variantId: id, status, winner },
      "Variant status updated",
    );

    return success(reply, {
      variantId: updated.id,
      status: updated.status,
      winner: updated.winner,
      rotationStartedAt: updated.rotation_started_at,
      rotationEndsAt: updated.rotation_ends_at,
      videoId: updated.video_id,
    });
  } catch (err: any) {
    logger.error(
      { err: err.message, userId: user.id, variantId: id },
      "Failed to update variant status",
    );
    return errors.internal(reply);
  }
};
