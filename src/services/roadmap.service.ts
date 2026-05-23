// src/services/roadmap.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Personalised Growth Roadmap Engine — v2
//
// Improvements over v1:
//  1. Time-awareness: knows when the roadmap was last generated + days since
//  2. Progress tracking: loads completed actions, skips them in next week
//  3. Rotating strategic lens: cycles through 5 strategic lenses per refresh
//  4. Wildcard injection: pulls a niche-matched trend from live_trends
//  5. Refresh race condition fixed: returns result before resetting state
// ══════════════════════════════════════════════════════════════════════════════

import OpenAI from "openai";
import { prisma } from "../config/database";
import { cache, getRedisClient } from "../config/redis";
import { logger } from "../utils/logger";
import { getVoicePortrait } from "./voice.service";
import { getMemory } from "./aria_memory.service";

export interface RoadmapResult {
  currentSituation: string;
  coreChallenge: string;
  weeklyPlan: {
    week1: WeekPlan;
    week2: WeekPlan;
    week3: WeekPlan;
    week4: WeekPlan;
  };
  milestones: Milestone[];
  contentStrategy: ContentStrategy;
  growthProjection: GrowthProjection;
  immediateAction: string;
  strategicLens: string;
  wildcardTrend: string | null;
  generatedAt: string;
  roadmapVersion: string;
}

interface WeekPlan {
  focus: string;
  actions: Action[];
}

interface Action {
  action: string;
  why: string;
  howTo: string;
  expectedImpact: string;
}

interface Milestone {
  target: string;
  eta: string;
  unlocks: string;
  triggerAction: string;
}

interface ContentStrategy {
  formats: string[];
  frequency: string;
  bestTimes: string;
  topicPillars: string[];
}

interface GrowthProjection {
  conservative: string;
  optimistic: string;
  keyAssumption: string;
}

// ── Direct OpenAI call — bypasses LangChain overhead entirely ────────────────
// Every other service in this codebase uses this pattern. The roadmap was
// the only outlier using LangChain ChatOpenAI which adds 500ms–2s of overhead.

let _openai: OpenAI | null = null;
const getOpenAI = (): OpenAI => {
  if (!_openai) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is required");
    _openai = new OpenAI({ apiKey });
  }
  return _openai;
};

async function callAI(prompt: string, modelOverride?: string): Promise<any> {
  const model = modelOverride || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const openai = getOpenAI();
  let lastErr: any = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const systemPrompt =
        attempt === 1
          ? "You are ARIA — India's creator growth strategist. Respond ONLY with valid JSON. No markdown, no preamble, no explanation."
          : "CRITICAL: Respond ONLY with a raw JSON object. Start with { and end with }. No text outside the JSON.";

      const res = await openai.chat.completions.create({
        model,
        max_tokens: 1600,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      });

      const content = res.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from OpenAI");

      // Strip markdown fences if model adds them despite instructions
      const clean = content
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

      return JSON.parse(clean);
    } catch (err: any) {
      logger.warn(
        { err: err.message, attempt, model },
        "roadmap AI call failed",
      );
      lastErr = err;

      // Don't retry auth errors
      if (err.status === 401 || err.status === 403) break;

      // Wait 1s before retry
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw lastErr || new Error("Roadmap AI call failed after retries");
}

// ── Strategic lenses — cycles on every fresh generation ──────────────────────
const STRATEGIC_LENSES = [
  {
    id: "distribution",
    name: "Distribution Month",
    description:
      "This month is about getting your content seen by new people. Every action focuses on reach, discovery, and algorithm signals.",
    weekBias: [
      "Platform algorithm signals",
      "Cross-platform reach",
      "Hashtag strategy",
      "Collab for reach",
    ],
  },
  {
    id: "quality",
    name: "Quality Month",
    description:
      "Slow down and make fewer, better pieces. This month is about raising the baseline of everything you produce.",
    weekBias: [
      "Hook quality",
      "Content depth",
      "Production value",
      "Save-worthy content",
    ],
  },
  {
    id: "community",
    name: "Community Month",
    description:
      "Build real relationships with your audience. Every action is about conversation, trust, and loyalty.",
    weekBias: [
      "Reply to every comment",
      "Community engagement",
      "Behind-the-scenes",
      "Ask your audience",
    ],
  },
  {
    id: "monetisation",
    name: "Monetisation Month",
    description:
      "This month you focus on turning your audience into income. Pitch, package, and position for brand deals.",
    weekBias: [
      "Brand pitch prep",
      "Rate card update",
      "Media kit",
      "DM outreach to brands",
    ],
  },
  {
    id: "content_depth",
    name: "Depth Month",
    description:
      "Go deep on your best-performing topic. Own it completely. Be the go-to creator for one specific thing.",
    weekBias: [
      "Series content",
      "Deep-dive format",
      "Expert positioning",
      "Evergreen content",
    ],
  },
];

function getNextLens(
  currentLensId: string | null,
): (typeof STRATEGIC_LENSES)[0] {
  if (!currentLensId) return STRATEGIC_LENSES[0];
  const currentIdx = STRATEGIC_LENSES.findIndex((l) => l.id === currentLensId);
  return STRATEGIC_LENSES[(currentIdx + 1) % STRATEGIC_LENSES.length];
}

// ── Roadmap version hash ──────────────────────────────────────────────────────
function makeRoadmapVersion(userId: string): string {
  const now = new Date();
  return `${userId.slice(0, 8)}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

// ── Load completed actions for a roadmap version ──────────────────────────────
async function loadCompletedActions(
  userId: string,
  version: string,
): Promise<{ weekNumber: number; actionIndex: number; actionText: string }[]> {
  try {
    const rows = await (prisma as any).roadmap_actions.findMany({
      where: {
        user_id: userId,
        roadmap_version: version,
        completed_at: { not: null },
      },
      select: { week_number: true, action_index: true, action_text: true },
    });
    return rows.map((r: any) => ({
      weekNumber: r.week_number,
      actionIndex: r.action_index,
      actionText: r.action_text,
    }));
  } catch {
    return [];
  }
}

// ── Get a niche-matched wildcard trend ────────────────────────────────────────
async function getWildcardTrend(niche: string): Promise<string | null> {
  try {
    const trend = await (prisma as any).live_trends.findFirst({
      where: {
        expires_at: { gt: new Date() },
        niche_tags: { has: niche },
        badge: { in: ["HOT", "RISING"] },
      },
      orderBy: { velocity: "desc" },
      select: { title: true, source: true, badge: true },
    });
    if (!trend) return null;
    return `"${trend.title}" (${trend.badge} on ${trend.source})`;
  } catch {
    return null;
  }
}

// ── Get content post count since last roadmap generation ─────────────────────
async function getPostsSinceLastRoadmap(
  userId: string,
  lastGeneratedAt: Date | null,
): Promise<number> {
  if (!lastGeneratedAt) return 0;
  try {
    return await prisma.content_history.count({
      where: {
        user_id: userId,
        created_at: { gt: lastGeneratedAt },
      },
    });
  } catch {
    return 0;
  }
}

// ── Main roadmap generator ────────────────────────────────────────────────────

/**
 * generatePersonalisedRoadmap
 *
 * @param userId   - authenticated user's ID
 * @param user     - merged user object from req.user + DB fields
 * @param force    - when true, SKIPS the internal Redis cache entirely and
 *                   calls the AI fresh. Always pass true on refresh flows.
 */
export async function generatePersonalisedRoadmap(
  userId: string,
  user: any,
  force = false,
  model?: string,
): Promise<RoadmapResult> {
  const funcStartMs = Date.now();
  const cacheKey = `roadmap:${userId}`;

  // ── Cache check — skipped when force=true ─────────────────────────────────
  if (!force) {
    try {
      const cached = (await cache.get(cacheKey)) as RoadmapResult | null;
      if (cached) {
        logger.debug({ userId }, "roadmap: serving from cache");
        return { ...cached, fromCache: true } as any;
      }
    } catch (err: any) {
      logger.warn(
        { err: err.message },
        "roadmap: Redis read failed — proceeding to generate",
      );
    }
  } else {
    // Explicitly evict stale cache so any parallel request also gets fresh data
    try {
      await cache.del(cacheKey);
    } catch {
      /* non-fatal */
    }
  }

  // ── Distributed lock — prevents two concurrent force-refreshes from making
  // duplicate AI calls for the same user (each call can cost ~$0.01 and takes
  // 5–15 s). Lock TTL (60 s) is well above the expected generation time.
  const lockKey = `lock:roadmap:${userId}`;
  const redis = getRedisClient();
  let lockAcquired = false;
  if (redis) {
    try {
      const result = await (redis as any).set(lockKey, "1", "EX", 60, "NX") as string | null;
      lockAcquired = result === "OK";
      if (!lockAcquired) {
        // Another request is already generating — return whatever is cached
        logger.info({ userId }, "roadmap: lock busy — returning cached result");
        const cached = (await cache.get(cacheKey)) as RoadmapResult | null;
        if (cached) return { ...cached, fromCache: true } as any;
        // No cache yet — wait a moment then fall through to generate without lock
        await new Promise((r) => setTimeout(r, 3000));
        const retryCache = (await cache.get(cacheKey)) as RoadmapResult | null;
        if (retryCache) return { ...retryCache, fromCache: true } as any;
      }
    } catch {
      // Redis lock unavailable — proceed without it (non-fatal)
    }
  }

  // ── Load all context in parallel ───────────────────────────────────────────
  const primaryNiche = Array.isArray(user.niches)
    ? user.niches[0]
    : user.niches || "general";
  const roadmapVersion = makeRoadmapVersion(userId);

  // ── ALL DB calls in ONE parallel batch — nothing sequential after this ────
  const [
    voicePortraitResult,
    memoryResult,
    contentHistoryResult,
    userMetaResult,
    wildcardTrendResult,
    completedActionsResult,
    postCountResult,
  ] = await Promise.allSettled([
    getVoicePortrait(userId),
    getMemory(userId),
    prisma.content_history.findMany({
      where: { user_id: userId },
      orderBy: { created_at: "desc" },
      take: 20,
      select: {
        trend_title: true,
        content_format: true,
        niche: true,
        created_at: true,
      },
    }),
    (prisma.users as any).findUnique({
      where: { id: userId },
      select: {
        roadmap_last_lens: true,
        roadmap_last_generated_at: true,
        roadmap_posts_at_generation: true,
      },
    }),
    // Previously sequential — now parallel:
    getWildcardTrend(primaryNiche),
    loadCompletedActions(userId, roadmapVersion),
    // posts count — inline instead of a separate function call
    prisma.content_history.count({ where: { user_id: userId } }),
  ]);

  const voicePortrait =
    voicePortraitResult.status === "fulfilled"
      ? voicePortraitResult.value
      : null;
  const memory = memoryResult.status === "fulfilled" ? memoryResult.value : {};
  const contentHistory =
    contentHistoryResult.status === "fulfilled"
      ? contentHistoryResult.value
      : [];
  const userMeta =
    userMetaResult.status === "fulfilled" ? userMetaResult.value : null;
  const wildcardTrend =
    wildcardTrendResult.status === "fulfilled"
      ? wildcardTrendResult.value
      : null;
  const completedActions =
    completedActionsResult.status === "fulfilled"
      ? completedActionsResult.value
      : [];
  const totalPostsEver =
    postCountResult.status === "fulfilled" ? postCountResult.value : 0;

  // ── Time awareness — pure computation, no awaits ──────────────────────────
  const lastGeneratedAt = userMeta?.roadmap_last_generated_at
    ? new Date(userMeta.roadmap_last_generated_at)
    : null;
  const daysSinceLast = lastGeneratedAt
    ? Math.round((Date.now() - lastGeneratedAt.getTime()) / 86_400_000)
    : null;

  // postsSinceLast — count from contentHistory items after lastGeneratedAt
  const postsSinceLast =
    lastGeneratedAt && Array.isArray(contentHistory)
      ? contentHistory.filter(
          (h: any) => new Date(h.created_at) > lastGeneratedAt,
        ).length
      : 0;
  // ↑ No extra DB query needed — we already have the history array

  const lens = getNextLens(userMeta?.roadmap_last_lens || null);
  const completedSummary =
    completedActions.length > 0
      ? `\nACTIONS ALREADY COMPLETED (do NOT repeat these — build on them):\n${completedActions.map((a) => `- Week ${a.weekNumber}: ${a.actionText}`).join("\n")}`
      : "";

  // ── Memory insights ────────────────────────────────────────────────────────
  const topMemoryInsights: any[] = [];
  if (memory && typeof memory === "object") {
    for (const [category, items] of Object.entries(memory)) {
      if (Array.isArray(items)) {
        for (const item of (items as any[]).slice(0, 2)) {
          topMemoryInsights.push({ category, ...item });
        }
      }
    }
  }

  const recentHistory = Array.isArray(contentHistory)
    ? contentHistory.slice(0, 10)
    : [];

  // ── Build context blocks ──────────────────────────────────────────────────
  // PLATFORM-AWARE DATA EXTRACTION
  // Rule: if primary_platform === "youtube", read youtube_scraped_summary.
  //       Otherwise read scraped_summary (Instagram Apify blob).
  // Both blobs share field names where possible; YouTube-specific fields
  // (subscriberCount, avgViewsPerVideo, topVideos, topTags) are normalised
  // into the same variable names the rest of the prompt already uses.

  const platform = (user.primary_platform as string) || "instagram";
  const isYouTube = platform === "youtube";

  // Pick the right summary blob
  const rawSS = isYouTube
    ? ((user as any).youtube_scraped_summary as any) || {}
    : ((user.scraped_summary as any) || {});

  // ── Normalise fields so downstream prompt blocks are platform-agnostic ────
  // followers / subscriber count
  const actualFollowers =
    user.follower_count ||
    rawSS.subscriberCount ||   // YouTube field
    rawSS.followerCount ||     // Instagram field
    rawSS.followers ||
    null;

  // engagement rate — stored as Decimal on user row, overrides summary
  const actualER = user.engagement_rate
    ? parseFloat(user.engagement_rate.toString())
    : rawSS.engagementRate
    ? parseFloat(String(rawSS.engagementRate))
    : null;

  // posts / uploads per week
  const actualPostsPerWeek = rawSS.postsPerWeek ?? null;

  // per-post averages
  const avgLikes    = rawSS.avgLikesPerVideo  ?? rawSS.avgLikes    ?? null;
  const avgComments = rawSS.avgCommentsPerVideo ?? rawSS.avgComments ?? null;
  const avgViews    = rawSS.avgViewsPerVideo   ?? rawSS.avgViews    ?? null;

  // tags / hashtags
  const topHashtags = isYouTube
    ? (rawSS.topTags?.slice(0, 8) ?? [])
    : (rawSS.topHashtags?.slice(0, 8) ?? []);

  // post type mix
  const postTypeMix  = rawSS.postTypeMix  ?? (isYouTube ? "Videos + Shorts" : null);
  const bestPostType = rawSS.bestPostType ?? (isYouTube ? "video" : null);

  // handle (for display in prompt)
  const handle = isYouTube
    ? (user.youtube_handle || null)
    : (user.instagram_handle || user.youtube_handle || null);

  // YouTube-specific extras for richer context
  const channelName       = isYouTube ? (rawSS.channelName || null) : null;
  const totalViews        = isYouTube ? (rawSS.totalViews || null) : null;
  const videoCount        = isYouTube ? (rawSS.videoCount || rawSS.totalPostsAnalyzed || null) : null;
  const recentVideoTitles = isYouTube ? (rawSS.recentVideoTitles?.slice(0, 6) ?? []) : [];
  const topVideos         = isYouTube ? (rawSS.topVideos?.slice(0, 3) ?? []) : [];
  const channelDescription = isYouTube ? (rawSS.description || null) : null;

  const contextBlocks: string[] = [];

  // ── Block 1: Creator identity with real numbers ───────────────────────────
  contextBlocks.push(`CREATOR IDENTITY:
- Handle: ${handle ? `@${handle}` : "not connected"}${channelName ? ` (Channel: ${channelName})` : ""}
- Archetype: ${user.archetype || "UNKNOWN"} (${user.archetype_label || "Unknown"})
- Platform: ${platform}
- ${isYouTube ? "Subscribers" : "Followers"}: ${actualFollowers ? actualFollowers.toLocaleString("en-IN") : user.follower_range || "unknown"}
- Follower range bucket: ${user.follower_range || "unknown"}
- Engagement rate: ${actualER !== null ? `${actualER}%` : "unknown"} ${actualER && actualER > 5 ? "(SIGNIFICANTLY above average — this is a key asset)" : actualER && actualER > 2 ? "(above average)" : ""}
- ${isYouTube ? "Uploads per week" : "Posts per week"}: ${actualPostsPerWeek !== null ? actualPostsPerWeek : "unknown"} ${actualPostsPerWeek !== null && actualPostsPerWeek < 1 ? "(⚠️ CRITICALLY LOW — less than 1 upload/week)" : actualPostsPerWeek !== null && actualPostsPerWeek < 3 ? "(below ideal — should be 3-5/week)" : ""}
- Growth stage: ${user.growth_stage || "unknown"}
- Creator intent: ${user.creator_intent || "grow_organically"}
- Tone: ${user.tone_profile || "unknown"}
- Bio: ${user.bio || "not set"}`);

  // ── Block 2: Raw performance numbers ─────────────────────────────────────
  if (avgLikes !== null || avgComments !== null || avgViews !== null || totalViews !== null) {
    contextBlocks.push(`REAL PERFORMANCE NUMBERS (from actual ${isYouTube ? "videos" : "posts"}):
- Avg likes per ${isYouTube ? "video" : "post"}: ${avgLikes?.toLocaleString("en-IN") ?? "unknown"}
- Avg comments per ${isYouTube ? "video" : "post"}: ${avgComments?.toLocaleString("en-IN") ?? "unknown"}
- Avg video views: ${avgViews?.toLocaleString("en-IN") ?? "unknown"}
${totalViews ? `- Total channel views: ${totalViews.toLocaleString("en-IN")}` : ""}
${videoCount ? `- Total videos uploaded: ${videoCount}` : ""}
- Content type mix: ${postTypeMix ?? "unknown"}
- Best performing format: ${bestPostType ?? "unknown"}
- Top ${isYouTube ? "tags" : "hashtags"}: ${topHashtags.length > 0 ? topHashtags.join(", ") : "none detected"}`);
  }

  // ── Block 2b: YouTube top videos (YouTube-only, replaces top reels) ───────
  if (isYouTube && topVideos.length > 0) {
    contextBlocks.push(`TOP PERFORMING VIDEOS:
${topVideos.map((v: any, i: number) => `  ${i + 1}. "${v.title}" — ${(v.views || 0).toLocaleString("en-IN")} views, ${(v.likes || 0).toLocaleString("en-IN")} likes`).join("\n")}
${recentVideoTitles.length > 0 ? `\nRECENT UPLOADS (titles): ${recentVideoTitles.join(" | ")}` : ""}
${channelDescription ? `\nCHANNEL DESCRIPTION: "${channelDescription.slice(0, 200)}"` : ""}`);
  }

  // ── Block 3: Voice portrait ───────────────────────────────────────────────
  if (voicePortrait) {
    contextBlocks.push(`VOICE PORTRAIT (ARIA's deep understanding of this creator):
- Content territory: ${(voicePortrait as any).contentTerritory}
- Primary topics: ${(voicePortrait as any).primaryTopics?.join(", ")}
- Audience: ${(voicePortrait as any).audienceDescription}
- Tone signature: ${(voicePortrait as any).toneSignature}
- Preferred formats: ${(voicePortrait as any).preferredFormats?.join(", ")}
- Personal constraints: ${(voicePortrait as any).personalConstraints?.join(", ")}
- Performance insights: ${(voicePortrait as any).performanceInsights || "Data in progress"}`);
  }

  // ── Block 4: ARIA memory ──────────────────────────────────────────────────
  if (topMemoryInsights.length > 0) {
    contextBlocks.push(`ARIA MEMORY (observed patterns over time):
${topMemoryInsights.map((m: any) => `- ${m.category}: ${m.key} = "${m.value}" (confidence: ${m.confidence}%)`).join("\n")}`);
  }

  // ── Block 5: Content history ──────────────────────────────────────────────
  if (recentHistory.length > 0) {
    contextBlocks.push(`CONTENT HISTORY (last ${recentHistory.length} pieces created in-app):
${recentHistory.map((h: any) => `- ${h.trend_title} | ${h.content_format} | ${h.niche}`).join("\n")}`);
  }

  // ── Block 6: ARIA analysis — read the actual shape correctly ──────────────
  if (user.aria_last_analysis) {
    const a = user.aria_last_analysis as any;

    // The onboarding analysis stores different shapes depending on the path.
    // Handle both gracefully.
    const strengths = a.strengths || a.keyStrengths || [];
    const gaps = a.gaps || a.keyGaps || a.weaknesses || [];
    const opportunities = a.opportunities || a.keyOpportunities || [];
    const ariaMsg = a.ariaMessage || a.summary || null;
    const archetypeLabel = a.archetypeLabel || a.archetype_label || null;

    const hasRealAnalysis =
      strengths.length > 0 || gaps.length > 0 || opportunities.length > 0;

    if (hasRealAnalysis) {
      contextBlocks.push(`ARIA ONBOARDING ANALYSIS:
${archetypeLabel ? `Archetype: ${archetypeLabel}` : ""}
Strengths: ${strengths.slice(0, 3).join(", ") || "Being identified"}
Gaps: ${gaps.slice(0, 3).join(", ") || "Being identified"}
Opportunities: ${opportunities.slice(0, 2).join(", ") || "Being identified"}
${ariaMsg ? `ARIA said: "${ariaMsg.slice(0, 200)}"` : ""}`);
    } else if (ariaMsg) {
      // Fallback: at least inject the aria message if no structured data
      contextBlocks.push(`ARIA ONBOARDING NOTE: "${ariaMsg.slice(0, 300)}"`);
    }
  }

  // ── Block 7: Time context ─────────────────────────────────────────────────
  const timeContext =
    daysSinceLast !== null
      ? `TIME CONTEXT:
- Days since last roadmap: ${daysSinceLast}
- Posts created since last roadmap: ${postsSinceLast}
- Total content pieces ever created in-app: ${totalPostsEver}
${
  postsSinceLast === 0 && daysSinceLast > 7
    ? "⚠️ Creator has NOT posted since last roadmap — consistency is the #1 priority for Week 1"
    : postsSinceLast >= 5
      ? "✅ Creator has been active — build on their momentum"
      : "📊 Creator has posted a little — acknowledge progress and push further"
}`
      : "TIME CONTEXT: This is the creator's first roadmap generation.";

  contextBlocks.push(timeContext);

  // ── Block 8: Strategic lens ───────────────────────────────────────────────
  contextBlocks.push(`THIS MONTH'S STRATEGIC FOCUS: ${lens.name}
${lens.description}
Weekly bias: ${lens.weekBias.join(" → ")}`);

  // ── Block 9: Wildcard trend ───────────────────────────────────────────────
  if (wildcardTrend) {
    contextBlocks.push(`CURRENT WILDCARD TREND (inject into one week naturally):
${wildcardTrend}
Use as a timeliness hook — ride this while staying true to the creator's voice.`);
  }

  // ── Critical diagnostic summary (injected last for emphasis) ─────────────
  // This ensures the AI's opening awareness is anchored to the most important facts.
  const diagnosticLines: string[] = [];

  if (actualER !== null && actualER > 10) {
    diagnosticLines.push(
      `This creator has an EXCEPTIONAL engagement rate of ${actualER}% — far above the 3% niche average. This is their single biggest asset.`,
    );
  } else if (actualER !== null && actualER > 5) {
    diagnosticLines.push(
      `This creator has a strong engagement rate of ${actualER}% vs ~3% niche average.`,
    );
  }

  if (actualPostsPerWeek !== null && actualPostsPerWeek < 1) {
    diagnosticLines.push(
      `CRITICAL BOTTLENECK: They only post ${actualPostsPerWeek}x per week. The algorithm needs minimum 3–4 posts/week to distribute content. This is the #1 lever.`,
    );
  }

  if (
    actualFollowers !== null &&
    actualER !== null &&
    actualER > 15 &&
    actualFollowers < 10000
  ) {
    diagnosticLines.push(
      `This creator is in a rare position: high engagement but low follower count = algorithm hasn't discovered them yet. The growth opportunity is massive if they increase posting frequency.`,
    );
  }

  if (diagnosticLines.length > 0) {
    contextBlocks.push(
      `KEY DIAGNOSTIC (use this to anchor the roadmap):\n${diagnosticLines.map((l) => `• ${l}`).join("\n")}`,
    );
  }

  // ── Prompt ────────────────────────────────────────────────────────────────
  const prompt = `You are ARIA — India's creator growth strategist.
Generate a HYPER-PERSONALISED growth roadmap for this specific creator.
This is NOT generic advice. Every single action must reference their ACTUAL numbers, their ACTUAL content, their ACTUAL bottleneck.

${contextBlocks.join("\n\n")}
${completedSummary}

ROADMAP RULES:
1. Reference the creator's actual follower count and engagement rate by number — never say "your followers"
2. If posts/week < 1, Week 1's ENTIRE focus must be on posting frequency — nothing else
3. If engagement rate > 10%, every action must leverage this asset explicitly
4. Never suggest a format they don't use (check post type mix)
5. Topic suggestions must be in their specific content territory — not generic
6. Never repeat a completed action — build on it
7. If a wildcard trend was provided, weave it into one week naturally
8. Each week must have exactly 3 actions — no more, no less
9. Every "howTo" must be executable with a phone, alone, in India

Respond ONLY with valid JSON (no markdown, no preamble):
{
  "currentSituation": "2-3 sentences referencing their ACTUAL numbers — e.g. 'With 7,081 followers and a 35.83% engagement rate, you are...'",
  "coreChallenge": "One sentence — the single bottleneck shown by the data",
  "weeklyPlan": {
    "week1": {
      "focus": "One sentence theme aligned with ${lens.weekBias[0]}",
      "actions": [
        {
          "action": "Specific task referencing their actual content/numbers",
          "why": "Why this matters — use their actual ER/follower data",
          "howTo": "Step-by-step, phone-executable, India-specific",
          "expectedImpact": "Concrete expected outcome"
        }
      ]
    },
    "week2": { "focus": "${lens.weekBias[1]}", "actions": [] },
    "week3": { "focus": "${lens.weekBias[2]}", "actions": [] },
    "week4": { "focus": "${lens.weekBias[3]}", "actions": [] }
  },
  "milestones": [
    {
      "target": "Specific numeric goal relevant to their current ${actualFollowers ? actualFollowers.toLocaleString("en-IN") + " followers" : "stage"}",
      "eta": "Realistic timeline",
      "unlocks": "What becomes possible — brand deals, monetisation, etc.",
      "triggerAction": "The single most important action to reach this"
    }
  ],
  "contentStrategy": {
    "formats": ["Formats they ALREADY use or can easily start"],
    "frequency": "Specific target — e.g. '4 Reels per week'",
    "bestTimes": "IST timing based on their niche audience",
    "topicPillars": ["3-4 pillars from their ACTUAL content territory"]
  },
  "growthProjection": {
    "conservative": "Follower count in 3 months if they post consistently",
    "optimistic": "Follower count in 3 months if they follow the full plan",
    "keyAssumption": "What must be true for optimistic scenario"
  },
  "immediateAction": "ONE thing executable in the next 24 hours — specific, tiny, no excuses"
}`;

  // ── Log prompt context before AI call ──────────────────────────────────────
  const t0 = Date.now();
  logger.info(
    { userId, promptChars: prompt.length, contextBlocks: contextBlocks.length },
    "roadmap: calling AI",
  );

  const roadmapRaw = await callAI(prompt, model);

  logger.info({ userId, aiMs: Date.now() - t0 }, "roadmap: AI call complete");

  const roadmap: RoadmapResult = {
    ...(roadmapRaw as any),
    strategicLens: lens.name,
    wildcardTrend: wildcardTrend || null,
    generatedAt: new Date().toISOString(),
    roadmapVersion,
  };

  // ── Persist lens + generation time to users table ─────────────────────────
  try {
    await (prisma.users as any).update({
      where: { id: userId },
      data: {
        roadmap_last_lens: lens.id,
        roadmap_last_generated_at: new Date(),
        roadmap_posts_at_generation: totalPostsEver,
      },
    });
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "roadmap: failed to update user lens meta — non-fatal",
    );
  }

  // ── Cache for 6 hours ─────────────────────────────────────────────────────
  await cache.set(cacheKey, roadmap, 6 * 60 * 60);

  // Release the distributed lock now that the result is in cache
  if (redis && lockAcquired) {
    await redis.del(lockKey).catch(() => {});
  }

  const funcEndMs = Date.now();
  logger.info(
    {
      userId,
      totalDurationMs: funcEndMs - funcStartMs,
      cacheWritten: true,
    },
    "roadmap: generation complete",
  );

  return roadmap;
}

// ── Invalidate roadmap cache ──────────────────────────────────────────────────
export async function invalidateRoadmapCache(userId: string): Promise<void> {
  try {
    await cache.del(`roadmap:${userId}`);
    logger.debug({ userId }, "Roadmap cache invalidated");
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId },
      "Roadmap cache invalidation failed",
    );
  }
}

// ── Mark an action as complete ────────────────────────────────────────────────
export async function markRoadmapActionComplete(
  userId: string,
  roadmapVersion: string,
  weekNumber: number,
  actionIndex: number,
  actionText: string,
): Promise<void> {
  try {
    await (prisma as any).roadmap_actions.upsert({
      where: {
        roadmap_actions_unique: {
          user_id: userId,
          roadmap_version: roadmapVersion,
          week_number: weekNumber,
          action_index: actionIndex,
        },
      },
      create: {
        user_id: userId,
        roadmap_version: roadmapVersion,
        week_number: weekNumber,
        action_index: actionIndex,
        action_text: actionText.substring(0, 300),
        completed_at: new Date(),
      },
      update: { completed_at: new Date() },
    });
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId },
      "markRoadmapActionComplete failed — non-fatal",
    );
  }
}

// ── Dismiss an action ─────────────────────────────────────────────────────────
export async function dismissRoadmapAction(
  userId: string,
  roadmapVersion: string,
  weekNumber: number,
  actionIndex: number,
  actionText: string,
): Promise<void> {
  try {
    await (prisma as any).roadmap_actions.upsert({
      where: {
        roadmap_actions_unique: {
          user_id: userId,
          roadmap_version: roadmapVersion,
          week_number: weekNumber,
          action_index: actionIndex,
        },
      },
      create: {
        user_id: userId,
        roadmap_version: roadmapVersion,
        week_number: weekNumber,
        action_index: actionIndex,
        action_text: actionText.substring(0, 300),
        dismissed_at: new Date(),
      },
      update: { dismissed_at: new Date() },
    });
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId },
      "dismissRoadmapAction failed — non-fatal",
    );
  }
}

/**
 * Load action states for a given roadmap version.
 * Returns a map: `${weekNumber}-${actionIndex}` → 'completed' | 'dismissed'
 */
export async function loadActionStates(
  userId: string,
  version: string,
): Promise<Record<string, "completed" | "dismissed">> {
  try {
    const rows = await (prisma as any).roadmap_actions.findMany({
      where: { user_id: userId, roadmap_version: version },
      select: {
        week_number: true,
        action_index: true,
        completed_at: true,
        dismissed_at: true,
      },
    });
    const map: Record<string, "completed" | "dismissed"> = {};
    for (const r of rows) {
      const key = `${r.week_number}-${r.action_index}`;
      if (r.completed_at) map[key] = "completed";
      else if (r.dismissed_at) map[key] = "dismissed";
    }
    return map;
  } catch {
    return {};
  }
}
