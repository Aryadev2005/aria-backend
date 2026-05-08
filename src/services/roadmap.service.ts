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

import { prisma }          from '../config/database';
import { cache }           from '../config/redis';
import { logger }          from '../utils/logger';
import { _callGroq }       from './ai/groq.service';
import { getVoicePortrait } from './voice.service';
import { getMemory }       from './aria_memory.service';

export interface RoadmapResult {
  currentSituation: string;
  coreChallenge:    string;
  weeklyPlan: {
    week1: WeekPlan;
    week2: WeekPlan;
    week3: WeekPlan;
    week4: WeekPlan;
  };
  milestones:      Milestone[];
  contentStrategy: ContentStrategy;
  growthProjection:GrowthProjection;
  immediateAction: string;
  strategicLens:   string;
  wildcardTrend:   string | null;
  generatedAt:     string;
  roadmapVersion:  string;
}

interface WeekPlan {
  focus:   string;
  actions: Action[];
}

interface Action {
  action:         string;
  why:            string;
  howTo:          string;
  expectedImpact: string;
}

interface Milestone {
  target:        string;
  eta:           string;
  unlocks:       string;
  triggerAction: string;
}

interface ContentStrategy {
  formats:      string[];
  frequency:    string;
  bestTimes:    string;
  topicPillars: string[];
}

interface GrowthProjection {
  conservative:   string;
  optimistic:     string;
  keyAssumption:  string;
}

// ── Strategic lenses — cycles on every fresh generation ──────────────────────
const STRATEGIC_LENSES = [
  {
    id:          'distribution',
    name:        'Distribution Month',
    description: 'This month is about getting your content seen by new people. Every action focuses on reach, discovery, and algorithm signals.',
    weekBias:    ['Platform algorithm signals', 'Cross-platform reach', 'Hashtag strategy', 'Collab for reach'],
  },
  {
    id:          'quality',
    name:        'Quality Month',
    description: 'Slow down and make fewer, better pieces. This month is about raising the baseline of everything you produce.',
    weekBias:    ['Hook quality', 'Content depth', 'Production value', 'Save-worthy content'],
  },
  {
    id:          'community',
    name:        'Community Month',
    description: 'Build real relationships with your audience. Every action is about conversation, trust, and loyalty.',
    weekBias:    ['Reply to every comment', 'Community engagement', 'Behind-the-scenes', 'Ask your audience'],
  },
  {
    id:          'monetisation',
    name:        'Monetisation Month',
    description: 'This month you focus on turning your audience into income. Pitch, package, and position for brand deals.',
    weekBias:    ['Brand pitch prep', 'Rate card update', 'Media kit', 'DM outreach to brands'],
  },
  {
    id:          'content_depth',
    name:        'Depth Month',
    description: 'Go deep on your best-performing topic. Own it completely. Be the go-to creator for one specific thing.',
    weekBias:    ['Series content', 'Deep-dive format', 'Expert positioning', 'Evergreen content'],
  },
];

function getNextLens(currentLensId: string | null): typeof STRATEGIC_LENSES[0] {
  if (!currentLensId) return STRATEGIC_LENSES[0];
  const currentIdx = STRATEGIC_LENSES.findIndex(l => l.id === currentLensId);
  return STRATEGIC_LENSES[(currentIdx + 1) % STRATEGIC_LENSES.length];
}

// ── Roadmap version hash ──────────────────────────────────────────────────────
function makeRoadmapVersion(userId: string): string {
  const now = new Date();
  return `${userId.slice(0, 8)}-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
}

// ── Load completed actions for a roadmap version ──────────────────────────────
async function loadCompletedActions(
  userId: string, version: string
): Promise<{ weekNumber: number; actionIndex: number; actionText: string }[]> {
  try {
    const rows = await (prisma as any).roadmap_actions.findMany({
      where:  { user_id: userId, roadmap_version: version, completed_at: { not: null } },
      select: { week_number: true, action_index: true, action_text: true },
    });
    return rows.map((r: any) => ({
      weekNumber:  r.week_number,
      actionIndex: r.action_index,
      actionText:  r.action_text,
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
        badge:      { in: ['HOT', 'RISING'] },
      },
      orderBy: { velocity: 'desc' },
      select:  { title: true, source: true, badge: true },
    });
    if (!trend) return null;
    return `"${trend.title}" (${trend.badge} on ${trend.source})`;
  } catch {
    return null;
  }
}

// ── Get content post count since last roadmap generation ─────────────────────
async function getPostsSinceLastRoadmap(
  userId: string, lastGeneratedAt: Date | null
): Promise<number> {
  if (!lastGeneratedAt) return 0;
  try {
    return await prisma.content_history.count({
      where: {
        user_id:    userId,
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
): Promise<RoadmapResult> {
  const cacheKey = `roadmap:${userId}`;

  // ── Cache check — skipped when force=true ─────────────────────────────────
  if (!force) {
    try {
      const cached = await cache.get(cacheKey) as RoadmapResult | null;
      if (cached) {
        logger.debug({ userId }, 'roadmap: serving from cache');
        return { ...cached, fromCache: true } as any;
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'roadmap: Redis read failed — proceeding to generate');
    }
  } else {
    // Explicitly evict stale cache so any parallel request also gets fresh data
    try {
      await cache.del(cacheKey);
    } catch { /* non-fatal */ }
  }

  // ── Load all context in parallel ───────────────────────────────────────────
  const primaryNiche = Array.isArray(user.niches) ? user.niches[0] : (user.niches || 'general');

  const [
    voicePortraitResult,
    memoryResult,
    contentHistoryResult,
    userMetaResult,
  ] = await Promise.allSettled([
    getVoicePortrait(userId),
    getMemory(userId),
    prisma.content_history.findMany({
      where:   { user_id: userId },
      orderBy: { created_at: 'desc' },
      take:    20,
      select:  { trend_title: true, content_format: true, niche: true, created_at: true },
    }),
    (prisma.users as any).findUnique({
      where:  { id: userId },
      select: {
        roadmap_last_lens:           true,
        roadmap_last_generated_at:   true,
        roadmap_posts_at_generation: true,
      },
    }),
  ]);

  const voicePortrait  = voicePortraitResult.status  === 'fulfilled' ? voicePortraitResult.value  : null;
  const memory         = memoryResult.status         === 'fulfilled' ? memoryResult.value         : {};
  const contentHistory = contentHistoryResult.status === 'fulfilled' ? contentHistoryResult.value : [];
  const userMeta       = userMetaResult.status       === 'fulfilled' ? userMetaResult.value       : null;

  // ── Time awareness ─────────────────────────────────────────────────────────
  const lastGeneratedAt   = userMeta?.roadmap_last_generated_at ? new Date(userMeta.roadmap_last_generated_at) : null;
  const daysSinceLast     = lastGeneratedAt
    ? Math.round((Date.now() - lastGeneratedAt.getTime()) / 86400000)
    : null;
  const postsSinceLast    = await getPostsSinceLastRoadmap(userId, lastGeneratedAt);
  const totalPostsEver    = Array.isArray(contentHistory) ? contentHistory.length : 0;

  // ── Strategic lens rotation ────────────────────────────────────────────────
  const lens = getNextLens(userMeta?.roadmap_last_lens || null);

  // ── Wildcard trend ─────────────────────────────────────────────────────────
  const wildcardTrend = await getWildcardTrend(primaryNiche);

  // ── Roadmap version + completed actions ───────────────────────────────────
  const roadmapVersion    = makeRoadmapVersion(userId);
  const completedActions  = await loadCompletedActions(userId, roadmapVersion);
  const completedSummary  = completedActions.length > 0
    ? `\nACTIONS ALREADY COMPLETED (do NOT repeat these — build on them):\n${completedActions.map(a => `- Week ${a.weekNumber}: ${a.actionText}`).join('\n')}`
    : '';

  // ── Memory insights ────────────────────────────────────────────────────────
  const topMemoryInsights: any[] = [];
  if (memory && typeof memory === 'object') {
    for (const [category, items] of Object.entries(memory)) {
      if (Array.isArray(items)) {
        for (const item of (items as any[]).slice(0, 2)) {
          topMemoryInsights.push({ category, ...item });
        }
      }
    }
  }

  const recentHistory = Array.isArray(contentHistory) ? contentHistory.slice(0, 10) : [];

  // ── Build context blocks ───────────────────────────────────────────────────
  const contextBlocks: string[] = [];

  contextBlocks.push(`CREATOR IDENTITY:
- Archetype: ${user.archetype} (${user.archetype_label})
- Platform: ${user.primary_platform}
- Follower range: ${user.follower_range}
- Engagement rate: ${user.engagement_rate}%
- Growth stage: ${user.growth_stage}
- Creator intent: ${user.creator_intent}`);

  if (voicePortrait) {
    contextBlocks.push(`VOICE PORTRAIT:
- Content territory: ${voicePortrait.contentTerritory}
- Primary topics: ${voicePortrait.primaryTopics?.join(', ')}
- Audience: ${voicePortrait.audienceDescription}
- Tone: ${voicePortrait.toneSignature}
- Formats they use: ${voicePortrait.preferredFormats?.join(', ')}
- Personal constraints: ${voicePortrait.personalConstraints?.join(', ')}
- Performance insights: ${voicePortrait.performanceInsights || 'Data in progress'}`);
  }

  if (topMemoryInsights.length > 0) {
    contextBlocks.push(`ARIA MEMORY (observed over time):
${topMemoryInsights.map(m => `- ${m.category}: ${m.key} = "${m.value}" (confidence: ${m.confidence}%)`).join('\n')}`);
  }

  if (recentHistory.length > 0) {
    contextBlocks.push(`CONTENT HISTORY (last ${recentHistory.length} pieces):
${recentHistory.map((h: any) => `- ${h.trend_title} | ${h.content_format} | ${h.niche}`).join('\n')}`);
  }

  if (user.aria_last_analysis) {
    const a = user.aria_last_analysis as any;
    contextBlocks.push(`ARIA PROFILE ANALYSIS:
Strengths: ${a.strengths?.slice(0,3).join(', ') || 'Being identified'}
Gaps: ${a.gaps?.slice(0,3).join(', ')           || 'Being identified'}
Opportunities: ${a.opportunities?.slice(0,2).join(', ') || 'Being identified'}`);
  }

  if (user.scraped_summary) {
    contextBlocks.push(`REAL PLATFORM DATA:\n${JSON.stringify(user.scraped_summary).slice(0, 400)}`);
  }

  // ── Time context block ────────────────────────────────────────────────────
  const timeContext = daysSinceLast !== null
    ? `TIME CONTEXT:
- Days since last roadmap: ${daysSinceLast}
- Posts created since last roadmap: ${postsSinceLast}
- Total content pieces ever: ${totalPostsEver}
${postsSinceLast === 0 && daysSinceLast > 7
  ? '⚠️ Creator has NOT posted since last roadmap — consistency is the priority for Week 1'
  : postsSinceLast >= 5
    ? '✅ Creator has been active — build on momentum'
    : '📊 Creator has posted a little — acknowledge the progress and push further'}`
    : `TIME CONTEXT: This is the creator's first roadmap generation.`;

  contextBlocks.push(timeContext);

  // ── Strategic lens block ──────────────────────────────────────────────────
  contextBlocks.push(`THIS MONTH'S STRATEGIC FOCUS: ${lens.name}
${lens.description}
Weekly bias: ${lens.weekBias.join(' → ')}`);

  // ── Wildcard trend block ──────────────────────────────────────────────────
  if (wildcardTrend) {
    contextBlocks.push(`CURRENT WILDCARD TREND (inject into one week naturally):
${wildcardTrend}
Use this as a "timeliness hook" — create a content idea that rides this trend while staying true to the creator's voice.`);
  }

  // ── Build final prompt ────────────────────────────────────────────────────
  const prompt = `You are ARIA — India's creator growth strategist.
Generate a PERSONALISED growth roadmap for this specific creator.
This is NOT generic advice. Use every piece of data below to make this specific to them.

${contextBlocks.join('\n\n')}
${completedSummary}

ROADMAP RULES:
1. Every action must be specific to THIS creator's voice, territory, and constraints
2. Never suggest anything that violates their personal constraints
3. Week 1 focus must align with "${lens.weekBias[0]}" (this month's lens)
4. If the creator has not posted recently, Week 1 actions must be small and executable TODAY
5. Format suggestions must match their preferred formats
6. Topic suggestions must be in their content territory
7. Never repeat a completed action — build on top of it instead
8. If a wildcard trend was provided, weave it into one week naturally

Respond ONLY with valid JSON:
{
  "currentSituation": "2-3 sentences specific to this creator's exact situation — reference their actual numbers and what they've done recently",
  "coreChallenge": "The ONE thing holding this specific creator back right now",
  "weeklyPlan": {
    "week1": {
      "focus": "One sentence theme — must align with ${lens.weekBias[0]}",
      "actions": [
        {
          "action": "Specific actionable task",
          "why": "Why this matters for THIS creator specifically — reference their data",
          "howTo": "Exactly how to do it given their constraints",
          "expectedImpact": "What this should change"
        }
      ]
    },
    "week2": { "focus": "${lens.weekBias[1]}", "actions": [] },
    "week3": { "focus": "${lens.weekBias[2]}", "actions": [] },
    "week4": { "focus": "${lens.weekBias[3]}", "actions": [] }
  },
  "milestones": [
    {
      "target": "Specific goal e.g. 10K followers or 5% engagement",
      "eta": "Realistic timeline",
      "unlocks": "What becomes possible at this milestone for an Indian creator",
      "triggerAction": "The single most important thing to do to reach this milestone"
    }
  ],
  "contentStrategy": {
    "formats": ["Format mix specific to this creator"],
    "frequency": "Realistic posting frequency given their constraints",
    "bestTimes": "Based on their niche and audience",
    "topicPillars": ["3-4 topic pillars specific to their content territory"]
  },
  "growthProjection": {
    "conservative": "Realistic low estimate at 3 months",
    "optimistic": "Realistic high estimate at 3 months",
    "keyAssumption": "What has to be true for the optimistic scenario"
  },
  "immediateAction": "The ONE thing to do in the next 24 hours — must be tiny and executable right now"
}`;

  const roadmapRaw = await _callGroq(prompt, { maxTokens: 2200, useLlama: false });

  const roadmap: RoadmapResult = {
    ...(roadmapRaw as any),
    strategicLens:  lens.name,
    wildcardTrend:  wildcardTrend || null,
    generatedAt:    new Date().toISOString(),
    roadmapVersion,
  };

  // ── Persist lens + generation time to users table ─────────────────────────
  try {
    await (prisma.users as any).update({
      where: { id: userId },
      data:  {
        roadmap_last_lens:           lens.id,
        roadmap_last_generated_at:   new Date(),
        roadmap_posts_at_generation: totalPostsEver,
      },
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, 'roadmap: failed to update user lens meta — non-fatal');
  }

  // ── Cache for 6 hours ─────────────────────────────────────────────────────
  await cache.set(cacheKey, roadmap, 6 * 60 * 60);

  return roadmap;
}

// ── Invalidate roadmap cache ──────────────────────────────────────────────────
export async function invalidateRoadmapCache(userId: string): Promise<void> {
  try {
    await cache.del(`roadmap:${userId}`);
    logger.debug({ userId }, 'Roadmap cache invalidated');
  } catch (err: any) {
    logger.warn({ err: err.message, userId }, 'Roadmap cache invalidation failed');
  }
}

// ── Mark an action as complete ────────────────────────────────────────────────
export async function markRoadmapActionComplete(
  userId:         string,
  roadmapVersion: string,
  weekNumber:     number,
  actionIndex:    number,
  actionText:     string,
): Promise<void> {
  try {
    await (prisma as any).roadmap_actions.upsert({
      where: {
        roadmap_actions_unique: { user_id: userId, roadmap_version: roadmapVersion, week_number: weekNumber, action_index: actionIndex },
      },
      create: {
        user_id: userId, roadmap_version: roadmapVersion,
        week_number: weekNumber, action_index: actionIndex,
        action_text: actionText.substring(0, 300),
        completed_at: new Date(),
      },
      update: { completed_at: new Date() },
    });
  } catch (err: any) {
    logger.warn({ err: err.message, userId }, 'markRoadmapActionComplete failed — non-fatal');
  }
}

// ── Dismiss an action ─────────────────────────────────────────────────────────
export async function dismissRoadmapAction(
  userId:         string,
  roadmapVersion: string,
  weekNumber:     number,
  actionIndex:    number,
  actionText:     string,
): Promise<void> {
  try {
    await (prisma as any).roadmap_actions.upsert({
      where: {
        roadmap_actions_unique: { user_id: userId, roadmap_version: roadmapVersion, week_number: weekNumber, action_index: actionIndex },
      },
      create: {
        user_id: userId, roadmap_version: roadmapVersion,
        week_number: weekNumber, action_index: actionIndex,
        action_text: actionText.substring(0, 300),
        dismissed_at: new Date(),
      },
      update: { dismissed_at: new Date() },
    });
  } catch (err: any) {
    logger.warn({ err: err.message, userId }, 'dismissRoadmapAction failed — non-fatal');
  }
}

/**
 * Load action states for a given roadmap version.
 * Returns a map: `${weekNumber}-${actionIndex}` → 'completed' | 'dismissed'
 */
export async function loadActionStates(
  userId:  string,
  version: string,
): Promise<Record<string, 'completed' | 'dismissed'>> {
  try {
    const rows = await (prisma as any).roadmap_actions.findMany({
      where:  { user_id: userId, roadmap_version: version },
      select: { week_number: true, action_index: true, completed_at: true, dismissed_at: true },
    });
    const map: Record<string, 'completed' | 'dismissed'> = {};
    for (const r of rows) {
      const key = `${r.week_number}-${r.action_index}`;
      if (r.completed_at) map[key] = 'completed';
      else if (r.dismissed_at) map[key] = 'dismissed';
    }
    return map;
  } catch {
    return {};
  }
}
