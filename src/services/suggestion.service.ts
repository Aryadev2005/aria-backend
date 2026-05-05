// src/services/suggestion.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Suggestion Loop Management
//
// Handles reading pending suggestions, tracking feedback, and learning from
// creator responses to make future suggestions smarter.
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { logger } from "../utils/logger";
import { upsertMemory } from "./aria_memory.service";

// ── Get suggestions due for follow-up ────────────────────────────────────────

export async function getDueSuggestions(userId: string): Promise<any[]> {
  try {
    return await prisma.aria_suggestions.findMany({
      where: {
        user_id: userId,
        status: "pending",
        follow_up_sent: false,
        follow_up_at: { lte: new Date() },
      },
      orderBy: { created_at: "desc" },
      take: 3,
      select: {
        id: true,
        suggestion_type: true,
        suggestion_data: true,
        created_at: true,
        follow_up_at: true,
      },
    });
  } catch (err: any) {
    logger.warn({ err: err.message, userId }, "Get due suggestions failed");
    return [];
  }
}

// ── Record feedback on a suggestion ──────────────────────────────────────────

export async function recordSuggestionFeedback(
  suggestionId: string,
  userId: string,
  outcome: "followed" | "ignored" | "partially",
  notes?: string,
): Promise<void> {
  try {
    await prisma.aria_suggestions.update({
      where: { id: suggestionId },
      data: {
        status:
          outcome === "followed"
            ? "acted"
            : outcome === "ignored"
              ? "ignored"
              : "partial",
        follow_up_sent: true,
        result_data: { outcome, notes, recordedAt: new Date() },
      },
    });

    // Write result back to memory so ARIA learns from it
    const suggestion = await prisma.aria_suggestions.findUnique({
      where: { id: suggestionId },
      select: { suggestion_type: true, suggestion_data: true },
    });

    if (suggestion) {
      await upsertMemory(userId, {
        category: "suggestion_outcome",
        key: `${suggestion.suggestion_type}_outcome`,
        value: `${outcome}: ${notes || "no notes"}`,
        source: "observed",
      });

      // If followed, boost confidence in that suggestion type
      if (outcome === "followed") {
        await upsertMemory(userId, {
          category: "responsive_to",
          key: suggestion.suggestion_type,
          value: "follows_this_type",
          source: "observed",
        });
      }
    }
  } catch (err: any) {
    logger.warn(
      { err: err.message, suggestionId },
      "Record suggestion feedback failed",
    );
  }
}

// ── Mark suggestions as sent ─────────────────────────────────────────────────

export async function markSuggestionsAsSent(
  suggestionIds: string[],
): Promise<void> {
  if (!suggestionIds.length) return;
  try {
    await prisma.aria_suggestions.updateMany({
      where: { id: { in: suggestionIds } },
      data: { follow_up_sent: true },
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, "Mark suggestions sent failed");
  }
}

// ── Get suggestion stats for a user ──────────────────────────────────────────
// Used by ARIA Brain to understand which suggestion types this creator acts on

export async function getSuggestionStats(userId: string): Promise<{
  totalSuggestions: number;
  followed: number;
  ignored: number;
  followRate: number;
  topFollowedTypes: string[];
}> {
  try {
    const suggestions = await prisma.aria_suggestions.findMany({
      where: { user_id: userId, status: { not: "pending" } },
      select: { suggestion_type: true, status: true },
      take: 100,
    });

    const followed = suggestions.filter((s) => s.status === "acted").length;
    const ignored = suggestions.filter((s) => s.status === "ignored").length;
    const followRate = suggestions.length > 0 ? followed / suggestions.length : 0;

    const typeCounts: Record<string, number> = {};
    for (const s of suggestions.filter((s) => s.status === "acted")) {
      typeCounts[s.suggestion_type] =
        (typeCounts[s.suggestion_type] || 0) + 1;
    }

    const topFollowedTypes = Object.entries(typeCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([type]) => type);

    return {
      totalSuggestions: suggestions.length,
      followed,
      ignored,
      followRate,
      topFollowedTypes,
    };
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId },
      "Get suggestion stats failed",
    );
    return {
      totalSuggestions: 0,
      followed: 0,
      ignored: 0,
      followRate: 0,
      topFollowedTypes: [],
    };
  }
}
