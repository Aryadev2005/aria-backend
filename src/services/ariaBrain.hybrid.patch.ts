// src/services/ariaBrain.hybrid.patch.ts
// ══════════════════════════════════════════════════════════════════════════════
// Drop-in replacement for `buildLiveContext` in ariaBrain.service.ts
// Uses the 3-tier hybrid retrieval instead of direct API calls
// ══════════════════════════════════════════════════════════════════════════════

import { logger } from "../utils/logger";
import { hybridRetrieve } from "./retrieval/hybrid-rag.service";
import type { User } from "../types";
import type { AgentMemoryMap } from "./ariaBrain.service";

/**
 * Hybrid replacement for `buildLiveContext`.
 *
 * Instead of hitting radar + YouTube + festivals APIs directly (with 3s timeout),
 * this pulls from the pre-built hot window (Tier 1) which is typically < 5ms.
 *
 * Usage in ariaBrain.service.ts:
 *   import { hybridBuildLiveContext as buildLiveContext } from "./ariaBrain.hybrid.patch";
 */
export const hybridBuildLiveContext = async (
  user: User,
  memory: AgentMemoryMap,
): Promise<string> => {
  // Resolve niche from memory or user profile
  const niches = Array.isArray(user.niches)
    ? user.niches
    : user.niches
      ? [user.niches]
      : [];
  const niche =
    memory["current_niche"]?.value ||
    (niches[0] as string) ||
    user.primary_platform ||
    "general";

  try {
    const result = await hybridRetrieve({ niche });

    if (result.hotWindowNarrative) {
      logger.info(
        {
          niche,
          fromCache: result.fromCache,
          timeMs: result.metadata.retrievalTimeMs,
          signals: result.metadata.signalCount,
        },
        "Hybrid context retrieved for ARIA Brain",
      );
      return result.hotWindowNarrative;
    }
  } catch (err: any) {
    logger.warn(
      { err: err.message, niche },
      "Hybrid retrieval failed — ARIA Brain proceeding without live context",
    );
  }

  return ""; // Empty string — ARIA still works, just without live data
};
