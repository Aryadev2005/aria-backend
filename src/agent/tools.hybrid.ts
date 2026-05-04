// src/agent/tools.hybrid.ts
// ══════════════════════════════════════════════════════════════════════════════
// 4 new ARIA tools for the Hybrid RAG system
//
// 1. get_hybrid_context    — main Tier 1 hot window retrieval
// 2. get_trend_trajectory  — "is it too late to post about X?"
// 3. get_related_niches    — cross-pollination insight
// 4. find_similar_trends   — semantic search ("trends like X")
// ══════════════════════════════════════════════════════════════════════════════

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../utils/logger";

// ── Tool 1: Get Hybrid Context (Tier 1 Hot Window) ───────────────────────────
const getHybridContext = tool(
  async ({ niche, forceRefresh }: { niche: string; forceRefresh?: boolean }) => {
    try {
      const { hybridRetrieve } = await import(
        "../services/retrieval/hybrid-rag.service"
      );
      const result = await hybridRetrieve({ niche, forceRefresh });

      return JSON.stringify({
        context: result.hotWindowNarrative,
        fromCache: result.fromCache,
        signalCount: result.metadata.signalCount,
        retrievalTimeMs: result.metadata.retrievalTimeMs,
      });
    } catch (err: any) {
      logger.warn({ err: err.message, niche }, "Hybrid context tool failed");
      return JSON.stringify({
        error: `Hybrid context unavailable: ${err.message}`,
        context: "",
      });
    }
  },
  {
    name: "get_hybrid_context",
    description:
      "Get ARIA's complete live intelligence context for a niche — includes live trends, semantic matches, trend lifecycles, platform timing, and cross-niche opportunities. This is the primary tool for trend-based advice. Returns a pre-assembled narrative. Call this FIRST when helping with content strategy.",
    schema: z.object({
      niche: z
        .string()
        .describe(
          'Creator niche e.g. "fashion", "tech", "fitness", "comedy"',
        ),
      forceRefresh: z
        .boolean()
        .optional()
        .describe(
          "Force refresh even if cache is fresh (default: false). Only use when user explicitly asks for fresh data.",
        ),
    }),
  },
);

// ── Tool 2: Get Trend Trajectory ─────────────────────────────────────────────
const getTrendTrajectory = tool(
  async ({
    trendTitle,
    niche,
  }: {
    trendTitle: string;
    niche?: string;
  }) => {
    try {
      const { getTrendTrajectories } = await import(
        "../services/graph/knowledge-graph.service"
      );
      const trajectories = await getTrendTrajectories({
        titles: [trendTitle],
        niche,
        limit: 1,
      });

      if (!trajectories.length) {
        return JSON.stringify({
          trendTitle,
          trajectory: "UNKNOWN",
          message:
            "No trajectory data yet for this trend. It may be too new or not tracked.",
          advice: "If the trend is < 24h old, it's likely RISING. Jump on it.",
        });
      }

      const t = trajectories[0];
      const advice = getTrajectoryAdvice(t.trajectory, t.confidence);

      return JSON.stringify({
        trendTitle: t.trendTitle,
        trajectory: t.trajectory,
        confidence: `${(t.confidence * 100).toFixed(0)}%`,
        firstSeen: t.firstSeen,
        peakAt: t.peakAt,
        velocityHistory: t.velocityHistory.slice(-7), // last 7 data points
        advice,
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, "Trend trajectory tool failed");
      return JSON.stringify({ error: `Trajectory unavailable: ${err.message}` });
    }
  },
  {
    name: "get_trend_trajectory",
    description:
      'Check the lifecycle stage of a specific trend: RISING, PEAKING, DECLINING, DEAD, or CYCLICAL. Use when user asks "is it too late to post about X?" or "should I still jump on this trend?"',
    schema: z.object({
      trendTitle: z
        .string()
        .describe("The trend title or topic to check trajectory for"),
      niche: z
        .string()
        .optional()
        .describe("Optional niche context for more precise matching"),
    }),
  },
);

function getTrajectoryAdvice(
  trajectory: string,
  confidence: number,
): string {
  const conf = confidence > 0.7 ? "high confidence" : "moderate confidence";
  switch (trajectory) {
    case "RISING":
      return `🚀 This trend is RISING (${conf}). Jump on it NOW — you're early. Create content in the next 24-48 hours for maximum reach.`;
    case "PEAKING":
      return `🔥 This trend is at its PEAK (${conf}). You can still ride it but you need to post TODAY. Tomorrow might be too late. Find a unique angle.`;
    case "DECLINING":
      return `📉 This trend is DECLINING (${conf}). It's NOT too late but the window is closing. Only post if you have a truly unique take.`;
    case "DEAD":
      return `💀 This trend is DEAD (${conf}). Don't chase it. Focus on the next wave instead.`;
    case "CYCLICAL":
      return `🔄 This trend is CYCLICAL (${conf}). It comes and goes. Save your content idea and post when it resurges (usually every 2-4 weeks).`;
    default:
      return "No trajectory data available. If you're seeing it trend now, act fast.";
  }
}

// ── Tool 3: Get Related Niches ───────────────────────────────────────────────
const getRelatedNiches = tool(
  async ({ niche }: { niche: string }) => {
    try {
      const { getNicheCrossPollination } = await import(
        "../services/graph/knowledge-graph.service"
      );
      const related = await getNicheCrossPollination(niche);

      if (!related.length) {
        return JSON.stringify({
          niche,
          related: [],
          message:
            "No cross-pollination data yet. The knowledge graph builds over time from observed trends.",
        });
      }

      return JSON.stringify({
        niche,
        related: related.map((r) => ({
          niche: r.niche,
          overlapStrength: `${(r.strength * 100).toFixed(0)}%`,
          suggestion: `Content from ${niche} × ${r.niche} can reach both audiences`,
        })),
        advice: `Consider creating content that bridges ${niche} with ${related[0]?.niche || "related niches"} — audience overlap means double reach.`,
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, "Related niches tool failed");
      return JSON.stringify({ error: `Related niches unavailable: ${err.message}` });
    }
  },
  {
    name: "get_related_niches",
    description:
      "Find niches that cross-pollinate with the user's niche. Use for suggesting content collaborations, audience expansion, or when the user wants to explore adjacent topics.",
    schema: z.object({
      niche: z.string().describe("The niche to find related niches for"),
    }),
  },
);

// ── Tool 4: Find Similar Trends (Semantic Search) ────────────────────────────
const findSimilarTrendsToQuery = tool(
  async ({
    query,
    niche,
    limit,
  }: {
    query: string;
    niche?: string;
    limit?: number;
  }) => {
    try {
      const { findSimilarTrends } = await import(
        "../services/vector/embedding.service"
      );
      const results = await findSimilarTrends(query, {
        limit: limit || 8,
        niches: niche ? [niche] : undefined,
        minSimilarity: 0.2,
      });

      if (!results.length) {
        return JSON.stringify({
          query,
          results: [],
          message:
            "No semantically similar trends found. Try a different query or wait for more trends to be embedded.",
        });
      }

      return JSON.stringify({
        query,
        results: results.map((r) => ({
          title: r.title,
          similarity: `${(r.similarity * 100).toFixed(0)}%`,
          niche: r.niche,
        })),
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, "Similar trends tool failed");
      return JSON.stringify({
        error: `Semantic search unavailable: ${err.message}`,
      });
    }
  },
  {
    name: "find_similar_trends",
    description:
      'Semantic search for trends similar to a topic or query. Uses AI embeddings to find conceptually related trends, not just keyword matches. Use when user asks "what trends are like X?" or "find me similar topics to X".',
    schema: z.object({
      query: z
        .string()
        .describe(
          'Search query — e.g. "affordable fashion haul India" or "budget skincare routine"',
        ),
      niche: z
        .string()
        .optional()
        .describe("Optional niche filter for results"),
      limit: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe("Max results to return, default 8"),
    }),
  },
);

// ── Export all hybrid tools ───────────────────────────────────────────────────
export const hybridTools = [
  getHybridContext,
  getTrendTrajectory,
  getRelatedNiches,
  findSimilarTrendsToQuery,
];
