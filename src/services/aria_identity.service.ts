// src/services/aria_identity.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// ARIA Identity — What ARIA knows about this creator
//
// Serves the creator's voice portrait, key memories, and suggestion stats
// so they can see exactly what ARIA has learned about them.
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import { getVoicePortrait } from "./voice.service";
import { getSuggestionStats } from "./suggestion.service";

const IDENTITY_CACHE_TTL = 60 * 60; // 1 hour

export interface AriaIdentityResponse {
  voicePortrait: {
    contentTerritory: string;
    toneSignature: string;
    primaryTopics: string[];
    audienceDescription: string;
    personalConstraints: string[];
    preferredFormats: string[];
    preferredLanguage: string;
    confidence: number;
    lastBuiltAt: string;
  } | null;
  keyMemories: Array<{
    category: string;
    key: string;
    value: string;
    confidence: number;
  }>;
  suggestionStats: {
    totalSuggestions: number;
    followRate: number;
    topFollowedTypes: string[];
  };
  portraitAge: string;
  nextRebuildAt: string | null;
}

/**
 * Get ARIA's understanding of this creator
 */
export async function getAriaIdentity(
  userId: string,
): Promise<AriaIdentityResponse> {
  const cacheKey = `aria_identity:${userId}`;
  const cached = (await cache.get(cacheKey)) as AriaIdentityResponse | null;
  if (cached) return cached;

  try {
    // Load voice portrait, memory, and suggestion stats in parallel
    const [voicePortrait, memoryRows, suggestionStats] =
      await Promise.allSettled([
        getVoicePortrait(userId),
        prisma.aria_memory.findMany({
          where: { user_id: userId, confidence: { gte: 50 } },
          orderBy: [{ confidence: "desc" }, { times_seen: "desc" }],
          take: 10,
          select: {
            category: true,
            key: true,
            value: true,
            confidence: true,
          },
        }),
        getSuggestionStats(userId),
      ]);

    // Extract values from Promise settlements
    const portrait =
      voicePortrait.status === "fulfilled" ? voicePortrait.value : null;
    const memories = memoryRows.status === "fulfilled" ? memoryRows.value : [];
    const stats =
      suggestionStats.status === "fulfilled"
        ? suggestionStats.value
        : { totalSuggestions: 0, followRate: 0, topFollowedTypes: [] };

    // Calculate portrait age and next rebuild metadata
    let portraitAge = "not yet built";
    let nextRebuildAt: string | null = null;
    try {
      const voiceRow = await (prisma as any).creator_voice_profiles.findUnique({
        where: { user_id: userId },
        select: { built_at: true, next_rebuild_at: true },
      });
      if (voiceRow) {
        const now = new Date();
        const diff = now.getTime() - voiceRow.built_at.getTime();
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const days = Math.floor(hours / 24);

        if (days > 0) {
          portraitAge = `${days} day${days > 1 ? "s" : ""} ago`;
        } else if (hours > 0) {
          portraitAge = `${hours} hour${hours > 1 ? "s" : ""} ago`;
        } else {
          portraitAge = "just now";
        }

        nextRebuildAt = voiceRow.next_rebuild_at
          ? voiceRow.next_rebuild_at.toISOString()
          : null;
      }
    } catch (err) {
      logger.warn({ err }, "Failed to calculate portrait age");
    }

    const response: AriaIdentityResponse = {
      voicePortrait: portrait
        ? {
            contentTerritory: portrait.contentTerritory,
            toneSignature: portrait.toneSignature,
            primaryTopics: portrait.primaryTopics,
            audienceDescription: portrait.audienceDescription,
            personalConstraints: portrait.personalConstraints,
            preferredFormats: portrait.preferredFormats,
            preferredLanguage: portrait.preferredLanguage,
            confidence: portrait.confidence,
            lastBuiltAt: portrait.builtAt,
          }
        : null,
      keyMemories: (memories as any[]).map((m) => ({
        category: m.category,
        key: m.key,
        value: m.value,
        confidence: m.confidence,
      })),
      suggestionStats: stats,
      portraitAge,
      nextRebuildAt,
    };

    await cache.set(cacheKey, response, IDENTITY_CACHE_TTL);
    return response;
  } catch (err: any) {
    logger.error({ err: err.message, userId }, "Get aria identity failed");
    throw err;
  }
}

/**
 * Update a memory item directly (creator correction)
 */
export async function updateAriaMemory(
  userId: string,
  category: string,
  key: string,
  value: string,
): Promise<void> {
  try {
    const { upsertMemory } = await import("./aria_memory.service");

    await upsertMemory(userId, {
      category,
      key,
      value,
      source: "explicit", // Explicitly set by creator
    });

    // Invalidate identity cache
    await cache.del(`aria_identity:${userId}`);
    await cache.del(`aria_memory:${userId}`);

    logger.info({ userId, category, key }, "Memory updated by creator");
  } catch (err: any) {
    logger.error({ err: err.message, userId }, "Update memory failed");
    throw err;
  }
}

/**
 * Delete a memory item (creator correction)
 */
export async function deleteAriaMemory(
  userId: string,
  category: string,
  key: string,
): Promise<void> {
  try {
    // Find and delete the memory entry
    await prisma.aria_memory.deleteMany({
      where: { user_id: userId, category, key },
    });

    // Invalidate identity cache
    await cache.del(`aria_identity:${userId}`);
    await cache.del(`aria_memory:${userId}`);

    logger.info({ userId, category, key }, "Memory deleted by creator");
  } catch (err: any) {
    logger.error({ err: err.message, userId }, "Delete memory failed");
    throw err;
  }
}
