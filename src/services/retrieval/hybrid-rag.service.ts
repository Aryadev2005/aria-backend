// src/services/retrieval/hybrid-rag.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// 3-Tier Hybrid Retrieval Orchestrator
//
// Tier 1 — Hot Window: Pre-assembled narrative cached in Redis + Postgres
// Tier 2 — Warm Retrieval: pgvector cosine similarity on trend embeddings
// Tier 3 — Cold Knowledge Graph: Platform lags, niche clusters, trajectories
//
// ARIA only ever sees Tier 1. Tiers 2 & 3 feed what goes into Tier 1.
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../../config/database";
import { cache } from "../../config/redis";
import { logger } from "../../utils/logger";
import {
  findSimilarTrends,
  type SimilarTrendResult,
} from "../vector/embedding.service";
import {
  getGraphContextForNiche,
  getNicheCrossPollination,
  type GraphContext,
  type TrendTrajectory,
} from "../graph/knowledge-graph.service";

// ── Config ────────────────────────────────────────────────────────────────────
const HOT_WINDOW_TTL_SECONDS = 30 * 60; // 30 minutes
const HOT_WINDOW_TTL_MS = HOT_WINDOW_TTL_SECONDS * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface HybridRetrievalResult {
  hotWindowNarrative: string;
  fromCache: boolean;
  signals: {
    vectorResults: SimilarTrendResult[];
    graphContext: GraphContext;
    liveSignals: any[];
  };
  metadata: {
    niche: string;
    retrievalTimeMs: number;
    signalCount: number;
    cacheAge?: number;
  };
}

export interface HybridRetrievalOptions {
  niche: string;
  forceRefresh?: boolean;
  limit?: number;
}

// ── Tier 1: Hot Window Check ──────────────────────────────────────────────────

async function getHotWindow(
  niche: string,
): Promise<{ narrative: string; metadata: any; age: number } | null> {
  // L1: Redis cache
  const redisCacheKey = `hot:${niche}`;
  const redisHit = await cache.get(redisCacheKey) as any;
  if (redisHit?.narrative) {
    return {
      narrative: redisHit.narrative,
      metadata: redisHit.metadata || {},
      age: Date.now() - (redisHit.createdAt || 0),
    };
  }

  // L2: Postgres hot_window_cache
  try {
    const row = await prisma.hot_window_cache.findFirst({
      where: {
        cache_key: `hot:${niche}`,
        expires_at: { gt: new Date() },
      },
    });

    if (row) {
      const age = Date.now() - (row.created_at?.getTime() || 0);
      const result = {
        narrative: row.narrative,
        metadata: row.metadata || {},
        age,
      };

      // Promote back to Redis for next request
      await cache.set(redisCacheKey, {
        narrative: row.narrative,
        metadata: row.metadata,
        createdAt: row.created_at?.getTime(),
      }, Math.max(60, Math.round((row.expires_at.getTime() - Date.now()) / 1000)));

      return result;
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Hot window Postgres fetch failed");
  }

  return null;
}

async function setHotWindow(
  niche: string,
  narrative: string,
  metadata: Record<string, any> = {},
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + HOT_WINDOW_TTL_MS);

  // Write to Redis
  await cache.set(
    `hot:${niche}`,
    { narrative, metadata, createdAt: now.getTime() },
    HOT_WINDOW_TTL_SECONDS,
  );

  // Write to Postgres (L2 backup)
  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO hot_window_cache (cache_key, narrative, metadata, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cache_key)
       DO UPDATE SET narrative = $2, metadata = $3, created_at = $4, expires_at = $5`,
      `hot:${niche}`,
      narrative,
      JSON.stringify(metadata),
      now,
      expiresAt,
    );
  } catch (err: any) {
    logger.warn({ err: err.message }, "Hot window Postgres write failed");
  }
}

// ── Build the Hot Window Narrative ────────────────────────────────────────────

function buildHotWindowNarrative(
  niche: string,
  liveSignals: any[],
  vectorResults: SimilarTrendResult[],
  graphContext: GraphContext,
): string {
  const parts: string[] = [];

  // ─ Live trend signals ─
  if (liveSignals.length > 0) {
    parts.push(
      "📊 LIVE TRENDS RIGHT NOW:\n" +
        liveSignals
          .slice(0, 8)
          .map(
            (t: any) =>
              `• "${t.title}" — velocity ${t.velocity}/100 [${t.badge || "NEW"}] (${t.source})${t.recommendation ? ` → ${t.recommendation}` : ""}`,
          )
          .join("\n"),
    );
  }

  // ─ Semantically similar trends (from vector search) ─
  if (vectorResults.length > 0) {
    const uniqueTitles = new Set(liveSignals.map((s: any) => s.title));
    const newFromVector = vectorResults.filter(
      (v) => !uniqueTitles.has(v.title),
    );

    if (newFromVector.length > 0) {
      parts.push(
        "🔍 RELATED SIGNALS (semantic match):\n" +
          newFromVector
            .slice(0, 5)
            .map(
              (v) =>
                `• "${v.title}" — ${(v.similarity * 100).toFixed(0)}% match${v.niche ? ` [${v.niche}]` : ""}`,
            )
            .join("\n"),
      );
    }
  }

  // ─ Trend trajectories ─
  const activeTrajectories = graphContext.trajectories.filter(
    (t) => t.trajectory !== "DEAD",
  );
  if (activeTrajectories.length > 0) {
    parts.push(
      "📈 TREND LIFECYCLE:\n" +
        activeTrajectories
          .slice(0, 5)
          .map((t) => {
            const emoji =
              t.trajectory === "RISING"
                ? "🚀"
                : t.trajectory === "PEAKING"
                  ? "🔥"
                  : t.trajectory === "DECLINING"
                    ? "📉"
                    : "🔄";
            const peakInfo = t.peakAt
              ? ` (peaked ${_timeAgo(t.peakAt)})`
              : "";
            return `• ${emoji} "${t.trendTitle}" — ${t.trajectory}${peakInfo} [${(t.confidence * 100).toFixed(0)}% confidence]`;
          })
          .join("\n"),
    );
  }

  // ─ Platform lags ─
  if (graphContext.platformLags.length > 0) {
    parts.push(
      "⏱️ PLATFORM TIMING:\n" +
        graphContext.platformLags
          .map(
            (lag) =>
              `• ${lag.from} → ${lag.to}: trends arrive ~${lag.lagDays} days later`,
          )
          .join("\n"),
    );
  }

  // ─ Cross-pollination ─
  if (graphContext.relatedNiches.length > 0) {
    parts.push(
      "🔗 CROSS-NICHE OPPORTUNITIES:\n" +
        graphContext.relatedNiches
          .slice(0, 3)
          .map(
            (r) =>
              `• ${niche} × ${r.niche} — overlap strength ${(r.strength * 100).toFixed(0)}%`,
          )
          .join("\n"),
    );
  }

  if (parts.length === 0) {
    return `No live intelligence available for "${niche}" right now. Trends will populate as the system collects more data.`;
  }

  return parts.join("\n\n");
}

function _timeAgo(date: Date): string {
  const hours = Math.round((Date.now() - date.getTime()) / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ── Main Retrieval Function ───────────────────────────────────────────────────

export async function hybridRetrieve(
  options: HybridRetrievalOptions,
): Promise<HybridRetrievalResult> {
  const startTime = Date.now();
  const { niche, forceRefresh = false, limit = 10 } = options;
  const RETRIEVAL_TIMEOUT_MS = 3000; // 3-second timeout guard

  // ─ Tier 1: Check hot window cache ─
  if (!forceRefresh) {
    const hotWindow = await getHotWindow(niche);
    if (hotWindow) {
      logger.info(
        { niche, age: hotWindow.age },
        "Hot window HIT — returning cached narrative",
      );
      return {
        hotWindowNarrative: hotWindow.narrative,
        fromCache: true,
        signals: {
          vectorResults: [],
          graphContext: {
            platformLags: [],
            relatedNiches: [],
            trajectories: [],
          },
          liveSignals: [],
        },
        metadata: {
          niche,
          retrievalTimeMs: Date.now() - startTime,
          signalCount: (hotWindow.metadata as any)?.signalCount || 0,
          cacheAge: hotWindow.age,
        },
      };
    }
  }

  // ─ Tier 2 + 3: Full retrieval with timeout guard ─
  logger.info({ niche }, "Hot window MISS — performing full hybrid retrieval");

  // Build the full retrieval promise with timeout protection
  const fullRetrievalPromise = (async () => {
    // Parallel retrieval from all tiers — getNicheCrossPollination now runs
    // in parallel instead of serially, saving ~500ms-1s
    const [crossPollinationResult, liveSignalsResult, graphResult] =
      await Promise.allSettled([
        // Cross-pollination lookup (now parallel!)
        getNicheCrossPollination(niche),

        // Tier 2: Get live signals from DB
        prisma.live_trends
          .findMany({
            where: {
              expires_at: { gt: new Date() },
              niche_tags: { hasSome: [niche] },
            },
            orderBy: { velocity: "desc" },
            take: limit,
            select: {
              id: true,
              title: true,
              velocity: true,
              badge: true,
              source: true,
              recommendation: true,
              niche_tags: true,
            },
          })
          .catch(() => []),

        // Tier 3: Knowledge graph context (called once with empty titles)
        getGraphContextForNiche(
          niche,
          [], // Will use top titles from live signals for trajectories
        ).catch(() => ({
          platformLags: [],
          relatedNiches: [],
          trajectories: [],
        })),
      ]);

    // Extract results
    const relatedNichesList =
      crossPollinationResult.status === "fulfilled"
        ? (crossPollinationResult.value as any[])
        : [];

    const liveSignals =
      liveSignalsResult.status === "fulfilled"
        ? (liveSignalsResult.value as any[])
        : [];

    const graphContext =
      graphResult.status === "fulfilled"
        ? (graphResult.value as GraphContext)
        : { platformLags: [], relatedNiches: [], trajectories: [] };

    // Build search niches for vector search
    const searchNiches = [
      niche,
      ...relatedNichesList.slice(0, 2).map((r) => r.niche),
    ];

    // Tier 2: Vector similarity search (now runs after we have search niches)
    let vectorResults: SimilarTrendResult[] = [];
    try {
      vectorResults = await findSimilarTrends(`${niche} trending content India`, {
        limit,
        niches: searchNiches,
        minSimilarity: 0.25,
      });
    } catch {
      vectorResults = [];
    }

    return { liveSignals, vectorResults, graphContext };
  })();

  // Race timeout against full retrieval
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("retrieval timeout")),
      RETRIEVAL_TIMEOUT_MS,
    ),
  );

  let liveSignals: any[] = [];
  let vectorResults: SimilarTrendResult[] = [];
  let graphContext: GraphContext = {
    platformLags: [],
    relatedNiches: [],
    trajectories: [],
  };
  let timedOut = false;

  try {
    const result = await Promise.race([
      fullRetrievalPromise,
      timeoutPromise,
    ]);
    liveSignals = result.liveSignals;
    vectorResults = result.vectorResults;
    graphContext = result.graphContext;
  } catch (err: any) {
    if (err.message === "retrieval timeout") {
      timedOut = true;
      logger.warn(
        { niche },
        "Hybrid retrieval timed out after 3s — returning empty narrative for fast response",
      );
    } else {
      // Some other error — log but continue with empty results
      logger.error({ niche, err: err.message }, "Hybrid retrieval error");
    }
  }

  // ─ Build hot window narrative ─
  const narrative = buildHotWindowNarrative(
    niche,
    liveSignals,
    vectorResults,
    graphContext,
  );

  const signalCount =
    liveSignals.length + vectorResults.length + graphContext.trajectories.length;

  // ─ Cache as new Tier 1 hot window ─
  await setHotWindow(niche, narrative, {
    signalCount,
    liveCount: liveSignals.length,
    vectorCount: vectorResults.length,
    graphTrajectoryCount: graphContext.trajectories.length,
    generatedAt: new Date().toISOString(),
  }).catch((err) =>
    logger.warn({ err }, "Failed to cache hot window — non-critical"),
  );

  const retrievalTimeMs = Date.now() - startTime;
  logger.info(
    { niche, signalCount, retrievalTimeMs },
    "Hybrid retrieval complete — hot window built",
  );

  return {
    hotWindowNarrative: narrative,
    fromCache: false,
    signals: {
      vectorResults,
      graphContext,
      liveSignals,
    },
    metadata: {
      niche,
      retrievalTimeMs,
      signalCount,
    },
  };
}

// ── Invalidate hot window (call after niche change or manual refresh) ────────
export async function invalidateHotWindow(niche: string): Promise<void> {
  await cache.del(`hot:${niche}`);
  try {
    await prisma.hot_window_cache.deleteMany({
      where: { cache_key: `hot:${niche}` },
    });
  } catch {
    // Non-critical
  }
  logger.info({ niche }, "Hot window invalidated");
}

export async function invalidateAllHotWindows(): Promise<void> {
  await cache.delPattern("hot:*");
  try {
    await prisma.hot_window_cache.deleteMany({});
  } catch {
    // Non-critical
  }
  logger.info("All hot windows invalidated");
}
