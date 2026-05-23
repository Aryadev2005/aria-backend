// src/controllers/rivalWatch.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// Rival Watch Settings Controller — manage bookmarked competitor handles
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";

// Helper: clean and validate a handle
function cleanHandle(handle: string): string {
  return handle
    .replace(/^@/, "") // Remove @ prefix
    .replace(/\/$/, "") // Remove trailing slash
    .trim()
    .toLowerCase();
}

/**
 * GET /api/v1/settings/rival-watch
 * Returns current rival watch settings and next check estimate
 */
export const getRivalWatchSettings = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  try {
    const row = await prisma.users.findUnique({
      where: { id: user.id },
      select: {
        rival_watch_handles: true,
        rival_watch_last_notified_at: true,
        primary_platform: true,
      },
    });

    if (!row) {
      return errors.notFound(reply, "User");
    }

    // Estimate next check: last notified + 6 hours (cron runs every 6h)
    // If null, estimate next check is "soon" (within 6h)
    let nextCheckAt: string | null = null;
    if (row.rival_watch_last_notified_at) {
      const nextCheck = new Date(
        row.rival_watch_last_notified_at.getTime() + 6 * 60 * 60 * 1000,
      );
      nextCheckAt = nextCheck.toISOString();
    } else {
      // Estimate: next check within 6 hours
      nextCheckAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    }

    return success(reply, {
      handles: row.rival_watch_handles || [],
      platform: row.primary_platform || "instagram",
      lastNotifiedAt: row.rival_watch_last_notified_at?.toISOString() || null,
      nextCheckAt,
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "getRivalWatchSettings failed");
    return errors.internal(reply);
  }
};

/**
 * PUT /api/v1/settings/rival-watch
 * Update rival watch handles (0–3)
 */
export const updateRivalWatch = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;

  try {
    const body = req.body as { handles?: string[] };

    // Validate body
    if (!Array.isArray(body?.handles)) {
      return errors.validation(reply, "handles must be an array");
    }

    // Validate: max 3 handles
    if (body.handles.length > 3) {
      return errors.validation(
        reply,
        "Maximum 3 rival handles allowed",
      );
    }

    // Clean and validate each handle
    const cleanedHandles: string[] = [];
    for (const handle of body.handles) {
      if (typeof handle !== "string" || handle.trim().length === 0) {
        return errors.validation(reply, "Each handle must be a non-empty string");
      }
      cleanedHandles.push(cleanHandle(handle));
    }

    // Remove duplicates
    const uniqueHandles = [...new Set(cleanedHandles)];

    // Update database
    // Clear last_notified_at so next check happens sooner
    const updated = await prisma.users.update({
      where: { id: user.id },
      data: {
        rival_watch_handles: uniqueHandles,
        rival_watch_last_notified_at: null,
      },
      select: {
        rival_watch_handles: true,
        primary_platform: true,
      },
    });

    logger.info(
      { userId: user.id, handleCount: uniqueHandles.length },
      "Rival watch handles updated",
    );

    return success(reply, {
      handles: updated.rival_watch_handles || [],
      platform: updated.primary_platform || "instagram",
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "updateRivalWatch failed");
    return errors.internal(reply);
  }
};

/**
 * DELETE /api/v1/settings/rival-watch/:handle
 * Remove one handle from rival watch list
 */
export const removeRivalHandle = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const params = req.params as { handle?: string };

  try {
    if (!params.handle) {
      return errors.validation(reply, "Handle is required");
    }

    const handleToRemove = cleanHandle(params.handle);

    // Fetch current handles
    const row = await prisma.users.findUnique({
      where: { id: user.id },
      select: { rival_watch_handles: true },
    });

    if (!row) {
      return errors.notFound(reply, "User");
    }

    const currentHandles = row.rival_watch_handles || [];
    const updatedHandles = currentHandles.filter(
      (h) => cleanHandle(h) !== handleToRemove,
    );

    // Update database
    const updated = await prisma.users.update({
      where: { id: user.id },
      data: {
        rival_watch_handles: updatedHandles,
      },
      select: {
        rival_watch_handles: true,
        primary_platform: true,
      },
    });

    logger.info(
      { userId: user.id, removed: handleToRemove, remaining: updatedHandles.length },
      "Rival handle removed",
    );

    return success(reply, {
      handles: updated.rival_watch_handles || [],
      platform: updated.primary_platform || "instagram",
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, "removeRivalHandle failed");
    return errors.internal(reply);
  }
};
