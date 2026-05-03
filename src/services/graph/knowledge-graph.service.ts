// src/services/graph/knowledge-graph.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Tier 3 — Cold Knowledge Graph: Graph nodes, edges, traversal, trajectories
// Provides platform lag detection, niche cross-pollination, and trend lifecycle
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../../config/database";
import { cache } from "../../config/redis";
import { logger } from "../../utils/logger";

// ── Types ─────────────────────────────────────────────────────────────────────
export type NodeType =
  | "NICHE"
  | "PLATFORM"
  | "FORMAT"
  | "ARCHETYPE"
  | "TREND_CLUSTER";

export type EdgeType =
  | "TRENDS_ON"
  | "LAGS_BY"
  | "RELATED_TO"
  | "CROSS_POLLINATES";

export type Trajectory =
  | "RISING"
  | "PEAKING"
  | "DECLINING"
  | "DEAD"
  | "CYCLICAL";

export interface GraphNode {
  id: string;
  nodeType: NodeType;
  label: string;
  properties: Record<string, any>;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
  weight: number;
  properties: Record<string, any>;
}

export interface TrendTrajectory {
  trendTitle: string;
  niche: string | null;
  trajectory: Trajectory;
  velocityHistory: { date: string; velocity: number }[];
  firstSeen: Date;
  peakAt: Date | null;
  confidence: number;
}

// ── Node Operations ───────────────────────────────────────────────────────────

export async function upsertNode(
  nodeType: NodeType,
  label: string,
  properties: Record<string, any> = {},
): Promise<GraphNode> {
  const result = await prisma.graph_nodes.upsert({
    where: {
      node_type_label: { node_type: nodeType, label: label.toLowerCase() },
    },
    create: {
      node_type: nodeType,
      label: label.toLowerCase(),
      properties,
    },
    update: {
      properties,
      updated_at: new Date(),
    },
  });

  return {
    id: result.id,
    nodeType: result.node_type as NodeType,
    label: result.label,
    properties: (result.properties as Record<string, any>) || {},
  };
}

export async function getNode(
  nodeType: NodeType,
  label: string,
): Promise<GraphNode | null> {
  const result = await prisma.graph_nodes.findUnique({
    where: {
      node_type_label: { node_type: nodeType, label: label.toLowerCase() },
    },
  });

  if (!result) return null;
  return {
    id: result.id,
    nodeType: result.node_type as NodeType,
    label: result.label,
    properties: (result.properties as Record<string, any>) || {},
  };
}

export async function getNodesByType(nodeType: NodeType): Promise<GraphNode[]> {
  const results = await prisma.graph_nodes.findMany({
    where: { node_type: nodeType },
  });

  return results.map((r) => ({
    id: r.id,
    nodeType: r.node_type as NodeType,
    label: r.label,
    properties: (r.properties as Record<string, any>) || {},
  }));
}

// ── Edge Operations ───────────────────────────────────────────────────────────

export async function upsertEdge(
  sourceId: string,
  targetId: string,
  edgeType: EdgeType,
  weight: number = 1.0,
  properties: Record<string, any> = {},
): Promise<GraphEdge> {
  const result = await prisma.graph_edges.upsert({
    where: {
      source_id_target_id_edge_type: {
        source_id: sourceId,
        target_id: targetId,
        edge_type: edgeType,
      },
    },
    create: {
      source_id: sourceId,
      target_id: targetId,
      edge_type: edgeType,
      weight,
      properties,
    },
    update: {
      weight,
      properties,
      updated_at: new Date(),
    },
  });

  return {
    id: result.id,
    sourceId: result.source_id,
    targetId: result.target_id,
    edgeType: result.edge_type as EdgeType,
    weight: Number(result.weight),
    properties: (result.properties as Record<string, any>) || {},
  };
}

export async function getEdgesFrom(
  nodeId: string,
  edgeType?: EdgeType,
): Promise<(GraphEdge & { targetLabel: string; targetType: string })[]> {
  const where: any = { source_id: nodeId };
  if (edgeType) where.edge_type = edgeType;

  const results = await prisma.graph_edges.findMany({
    where,
    include: { target: { select: { label: true, node_type: true } } },
  });

  return results.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    targetId: r.target_id,
    edgeType: r.edge_type as EdgeType,
    weight: Number(r.weight),
    properties: (r.properties as Record<string, any>) || {},
    targetLabel: r.target.label,
    targetType: r.target.node_type,
  }));
}

export async function getEdgesTo(
  nodeId: string,
  edgeType?: EdgeType,
): Promise<(GraphEdge & { sourceLabel: string; sourceType: string })[]> {
  const where: any = { target_id: nodeId };
  if (edgeType) where.edge_type = edgeType;

  const results = await prisma.graph_edges.findMany({
    where,
    include: { source: { select: { label: true, node_type: true } } },
  });

  return results.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    targetId: r.target_id,
    edgeType: r.edge_type as EdgeType,
    weight: Number(r.weight),
    properties: (r.properties as Record<string, any>) || {},
    sourceLabel: r.source.label,
    sourceType: r.source.node_type,
  }));
}

// ── Graph Queries ─────────────────────────────────────────────────────────────

/**
 * Get cross-platform lags for a niche.
 * e.g. "fashion trends hit Instagram 2 days before YouTube"
 */
export async function getCrossPlatformLags(
  niche: string,
): Promise<{ from: string; to: string; lagDays: number; confidence: number }[]> {
  const cacheKey = `graph:lags:${niche}`;
  const cached = await cache.get(cacheKey) as any[] | null;
  if (cached) return cached;

  const nicheNode = await getNode("NICHE", niche);
  if (!nicheNode) return [];

  // Find LAGS_BY edges connected to this niche's platforms
  const platformEdges = await getEdgesFrom(nicheNode.id, "TRENDS_ON");
  const platformNodeIds = platformEdges.map((e) => e.targetId);

  if (platformNodeIds.length < 2) return [];

  const lagEdges = await prisma.graph_edges.findMany({
    where: {
      edge_type: "LAGS_BY",
      source_id: { in: platformNodeIds },
      target_id: { in: platformNodeIds },
    },
    include: {
      source: { select: { label: true } },
      target: { select: { label: true } },
    },
  });

  const result = lagEdges.map((e) => ({
    from: e.source.label,
    to: e.target.label,
    lagDays: ((e.properties as any)?.lagDays as number) || 0,
    confidence: Number(e.weight) || 0.5,
  }));

  await cache.set(cacheKey, result, 3600); // 1h cache
  return result;
}

/**
 * Get related niches (cross-pollination).
 * e.g. "fashion" → ["beauty", "lifestyle"]
 */
export async function getNicheCrossPollination(
  niche: string,
): Promise<{ niche: string; strength: number }[]> {
  const cacheKey = `graph:cross:${niche}`;
  const cached = await cache.get(cacheKey) as any[] | null;
  if (cached) return cached;

  const nicheNode = await getNode("NICHE", niche);
  if (!nicheNode) return [];

  const edges = await getEdgesFrom(nicheNode.id, "CROSS_POLLINATES");
  const result = edges
    .map((e) => ({
      niche: e.targetLabel,
      strength: Number(e.weight) || 0.5,
    }))
    .sort((a, b) => b.strength - a.strength);

  await cache.set(cacheKey, result, 3600);
  return result;
}

// ── Trajectory Operations ─────────────────────────────────────────────────────

export async function upsertTrajectory(
  trendTitle: string,
  niche: string | null,
  velocity: number,
): Promise<void> {
  const existing = await prisma.trend_trajectories.findUnique({
    where: {
      trend_title_niche: {
        trend_title: trendTitle,
        niche: niche || "general",
      },
    },
  });

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];

  if (existing) {
    const history = (existing.velocity_history as any[]) || [];
    // Avoid duplicate entries for same day
    if (!history.some((h: any) => h.date === dateStr)) {
      history.push({ date: dateStr, velocity });
    }

    // Compute trajectory from history
    const trajectory = computeTrajectory(history);
    const peakVelocity = Math.max(...history.map((h: any) => h.velocity));
    const isPeaking = velocity >= peakVelocity * 0.95;

    await prisma.trend_trajectories.update({
      where: { id: existing.id },
      data: {
        velocity_history: history,
        trajectory,
        peak_at: isPeaking ? now : existing.peak_at,
        confidence: Math.min(0.99, Number(existing.confidence) + 0.05),
        updated_at: now,
      },
    });
  } else {
    await prisma.trend_trajectories.create({
      data: {
        trend_title: trendTitle,
        niche: niche || "general",
        trajectory: "RISING",
        velocity_history: [{ date: dateStr, velocity }],
        first_seen: now,
        confidence: 0.5,
      },
    });
  }
}

function computeTrajectory(
  history: { date: string; velocity: number }[],
): Trajectory {
  if (history.length < 2) return "RISING";

  const recent = history.slice(-5);
  const velocities = recent.map((h) => h.velocity);
  const avgRecent = velocities.reduce((a, b) => a + b, 0) / velocities.length;
  const latestVelocity = velocities[velocities.length - 1];
  const firstVelocity = velocities[0];

  // Check for cyclical (goes up and down)
  if (history.length >= 7) {
    let changes = 0;
    for (let i = 1; i < velocities.length; i++) {
      if (
        Math.sign(velocities[i] - velocities[i - 1]) !==
        Math.sign(velocities[Math.max(0, i - 2)] - velocities[Math.max(0, i - 3)])
      ) {
        changes++;
      }
    }
    if (changes >= 3) return "CYCLICAL";
  }

  if (latestVelocity < 20) return "DEAD";
  if (latestVelocity > firstVelocity * 1.2) return "RISING";
  if (latestVelocity >= avgRecent * 0.95 && avgRecent > 60) return "PEAKING";
  if (latestVelocity < firstVelocity * 0.7) return "DECLINING";

  return "RISING";
}

/**
 * Get trajectories for trends matching a niche.
 * "Is it too late to post about X?"
 */
export async function getTrendTrajectories(
  options: {
    niche?: string;
    titles?: string[];
    trajectory?: Trajectory;
    limit?: number;
  } = {},
): Promise<TrendTrajectory[]> {
  const { niche, titles, trajectory, limit = 20 } = options;

  const cacheKey = `graph:traj:${niche || "all"}:${trajectory || "all"}`;
  if (!titles?.length) {
    const cached = await cache.get(cacheKey) as TrendTrajectory[] | null;
    if (cached) return cached;
  }

  const where: any = {};
  if (niche) where.niche = niche;
  if (trajectory) where.trajectory = trajectory;
  if (titles?.length) where.trend_title = { in: titles };

  const results = await prisma.trend_trajectories.findMany({
    where,
    orderBy: { updated_at: "desc" },
    take: limit,
  });

  const mapped: TrendTrajectory[] = results.map((r) => ({
    trendTitle: r.trend_title,
    niche: r.niche,
    trajectory: r.trajectory as Trajectory,
    velocityHistory: (r.velocity_history as any[]) || [],
    firstSeen: r.first_seen || new Date(),
    peakAt: r.peak_at,
    confidence: Number(r.confidence),
  }));

  if (!titles?.length) {
    await cache.set(cacheKey, mapped, 300);
  }

  return mapped;
}

// ── Bulk: Update trajectories from current live_trends ────────────────────────
export async function updateTrajectoriesFromLiveTrends(): Promise<number> {
  const trends = await prisma.live_trends.findMany({
    where: { expires_at: { gt: new Date() } },
    select: { title: true, niche_tags: true, velocity: true },
  });

  let updated = 0;
  for (const trend of trends) {
    const niche = trend.niche_tags?.[0] || "general";
    const velocity = Number(trend.velocity) || 0;
    try {
      await upsertTrajectory(trend.title, niche, velocity);
      updated++;
    } catch (err: any) {
      logger.warn(
        { err: err.message, title: trend.title },
        "Trajectory upsert failed",
      );
    }
  }

  logger.info({ updated, total: trends.length }, "Trajectories updated from live trends");
  return updated;
}

// ── Graph Context for ARIA ────────────────────────────────────────────────────
export interface GraphContext {
  platformLags: { from: string; to: string; lagDays: number }[];
  relatedNiches: { niche: string; strength: number }[];
  trajectories: TrendTrajectory[];
}

export async function getGraphContextForNiche(
  niche: string,
  topTrendTitles: string[] = [],
): Promise<GraphContext> {
  const cacheKey = `graph:ctx:${niche}`;
  const cached = await cache.get(cacheKey) as GraphContext | null;
  if (cached && !topTrendTitles.length) return cached;

  const [platformLags, relatedNiches, trajectories] = await Promise.allSettled([
    getCrossPlatformLags(niche),
    getNicheCrossPollination(niche),
    getTrendTrajectories({
      niche,
      titles: topTrendTitles.length ? topTrendTitles : undefined,
      limit: 10,
    }),
  ]);

  const result: GraphContext = {
    platformLags:
      platformLags.status === "fulfilled" ? platformLags.value : [],
    relatedNiches:
      relatedNiches.status === "fulfilled" ? relatedNiches.value : [],
    trajectories:
      trajectories.status === "fulfilled" ? trajectories.value : [],
  };

  if (!topTrendTitles.length) {
    await cache.set(cacheKey, result, 600); // 10 min cache
  }

  return result;
}
