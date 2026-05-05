// src/controllers/aria_identity.controller.ts
// ══════════════════════════════════════════════════════════════════════════════
// ARIA Identity Controller
//
// Serves the creator's profile as ARIA understands it, and handles corrections.
// ══════════════════════════════════════════════════════════════════════════════

import { FastifyRequest, FastifyReply } from "fastify";
import {
  getAriaIdentity,
  updateAriaMemory,
  deleteAriaMemory,
} from "../services/aria_identity.service";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { User } from "../types";

/**
 * GET /api/v1/profile/aria-identity
 * Fetch ARIA's understanding of this creator
 */
export const getIdentity = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  try {
    const identity = await getAriaIdentity(user.id);
    return success(reply, identity);
  } catch (err) {
    logger.error({ err, userId: user.id }, "Get ARIA identity failed");
    return errors.internal(reply, "Failed to fetch ARIA identity");
  }
};

interface UpdateMemoryBody {
  category: string;
  key: string;
  value: string;
}

/**
 * PUT /api/v1/profile/aria-identity/memory
 * Update a memory item (creator correction)
 */
export const updateMemory = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { category, key, value } = req.body as UpdateMemoryBody;

  try {
    if (!category || !key || !value) {
      return errors.badRequest(
        reply,
        "Missing category, key, or value",
      );
    }

    await updateAriaMemory(user.id, category, key, value);
    return success(reply, { updated: true, category, key, value });
  } catch (err) {
    logger.error({ err, userId: user.id }, "Update memory failed");
    return errors.internal(reply, "Failed to update memory");
  }
};

interface DeleteMemoryBody {
  category: string;
  key: string;
}

/**
 * DELETE /api/v1/profile/aria-identity/memory
 * Delete a memory item (creator correction)
 */
export const deleteMemory = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { category, key } = req.body as DeleteMemoryBody;

  try {
    if (!category || !key) {
      return errors.badRequest(reply, "Missing category or key");
    }

    await deleteAriaMemory(user.id, category, key);
    return success(reply, { deleted: true, category, key });
  } catch (err) {
    logger.error({ err, userId: user.id }, "Delete memory failed");
    return errors.internal(reply, "Failed to delete memory");
  }
};
