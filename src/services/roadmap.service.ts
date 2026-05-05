// src/services/roadmap.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Personalised Growth Roadmap Engine
//
// Generates a truly personalised roadmap using everything ARIA knows:
// - Voice portrait (how they create)
// - Memory (what they return to, what works for them)
// - Content history (what they've actually made)
// - Platform data (real engagement patterns)
// - Growth stage (where they are now)
//
// This is NOT generic advice. Every section is specific to this creator.
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import { _callGroq } from "./ai/groq.service";
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

// ── Main roadmap generator ──────────────────────────────────────────────────

export async function generatePersonalisedRoadmap(
  userId: string,
  user: any,
): Promise<RoadmapResult> {
  try {
    const cacheKey = `roadmap:${userId}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return cached as RoadmapResult;
    }

    // Parallel load of all context
    const [voicePortraitResult, memoryResult, contentHistoryResult] =
      await Promise.allSettled([
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
      ]);

    const voicePortrait =
      voicePortraitResult.status === "fulfilled"
        ? voicePortraitResult.value
        : null;
    const memory =
      memoryResult.status === "fulfilled" ? memoryResult.value : {};
    const contentHistory =
      contentHistoryResult.status === "fulfilled"
        ? contentHistoryResult.value
        : [];

    // Extract memory insights
    const topMemoryInsights: any[] = [];
    if (memory && typeof memory === "object") {
      for (const [category, items] of Object.entries(memory)) {
        if (Array.isArray(items)) {
          for (const item of items.slice(0, 2)) {
            topMemoryInsights.push({
              category,
              ...item,
            });
          }
        }
      }
    }

    // Format recent content history
    const recentHistory =
      contentHistory && Array.isArray(contentHistory)
        ? contentHistory.slice(0, 10)
        : [];

    // Build deeply personalised context string
    const contextBlocks: string[] = [];

    // Block 1: Creator Identity
    contextBlocks.push(`CREATOR IDENTITY:
- Archetype: ${user.archetype} (${user.archetype_label})
- Platform: ${user.primary_platform}
- Follower range: ${user.follower_range}
- Engagement rate: ${user.engagement_rate}%
- Growth stage: ${user.growth_stage}
- Creator intent: ${user.creator_intent}`);

    // Block 2: Voice Portrait (if available)
    if (voicePortrait) {
      contextBlocks.push(`VOICE PORTRAIT (what ARIA knows about this creator):
- Content territory: ${voicePortrait.contentTerritory}
- Primary topics: ${voicePortrait.primaryTopics?.join(", ")}
- Audience: ${voicePortrait.audienceDescription}
- Tone: ${voicePortrait.toneSignature}
- Energy level: ${voicePortrait.energyLevel}
- Vocabulary: ${voicePortrait.vocabularyLevel}
- Formats they use: ${voicePortrait.preferredFormats?.join(", ")}
- Personal constraints: ${voicePortrait.personalConstraints?.join(", ")}
- Performance insights: ${voicePortrait.performanceInsights || "Data in progress"}`);
    }

    // Block 3: Memory (what ARIA has observed)
    if (topMemoryInsights.length > 0) {
      contextBlocks.push(`ARIA MEMORY (observed over time):
${topMemoryInsights
  .map(
    (m) =>
      `- ${m.category}: ${m.key} = "${m.value}" (confidence: ${m.confidence}%)`,
  )
  .join("\n")}`);
    }

    // Block 4: Recent content history
    if (recentHistory.length > 0) {
      contextBlocks.push(`CONTENT HISTORY (last ${recentHistory.length} pieces):
${recentHistory
  .map((h) => `- ${h.trend_title} | ${h.content_format} | ${h.niche}`)
  .join("\n")}`);
    }

    // Block 5: ARIA Profile Analysis
    if (user.aria_last_analysis) {
      const analysis = user.aria_last_analysis;
      contextBlocks.push(`ARIA PROFILE ANALYSIS:
Strengths: ${analysis.strengths?.slice(0, 3).join(", ") || "Being identified"}
Gaps: ${analysis.gaps?.slice(0, 3).join(", ") || "Being identified"}
Opportunities: ${analysis.opportunities?.slice(0, 2).join(", ") || "Being identified"}`);
    }

    // Block 6: Scraped platform data
    if (user.scraped_summary) {
      contextBlocks.push(`REAL PLATFORM DATA:
${user.scraped_summary}`);
    }

    // Build final prompt
    const prompt = `You are ARIA — India's creator growth strategist.

Generate a PERSONALISED growth roadmap for this specific creator.
This is NOT generic advice. Use every piece of data below to make this specific to them.

${contextBlocks.join("\n\n")}

ROADMAP RULES:
1. Every action must be specific to THIS creator's voice, territory, and constraints
2. Never suggest anything that violates their personal constraints
3. Week 1 actions must be executable with their current setup (no team, no budget if those are constraints)
4. Format suggestions must match their preferred formats
5. Topic suggestions must be in their content territory
6. Timeline must be realistic for their current growth stage
7. The "why now" for each action must reference something specific about their situation

Respond ONLY with valid JSON:
{
  "currentSituation": "2-3 sentences specific to this creator's exact situation — not generic",
  "coreChallenge": "The ONE thing holding this specific creator back right now",
  "weeklyPlan": {
    "week1": {
      "focus": "One sentence theme",
      "actions": [
        {
          "action": "Specific actionable task",
          "why": "Why this matters for THIS creator specifically",
          "howTo": "Exactly how to do it given their constraints",
          "expectedImpact": "What this should change"
        }
      ]
    },
    "week2": { "focus": "", "actions": [] },
    "week3": { "focus": "", "actions": [] },
    "week4": { "focus": "", "actions": [] }
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
  "immediateAction": "The ONE thing to do in the next 24 hours"
}`;

    const roadmap = await _callGroq(prompt, {
      maxTokens: 2000,
      useLlama: false,
    });

    // Cache for 6 hours
    await cache.set(cacheKey, roadmap, 6 * 60 * 60);

    return roadmap as RoadmapResult;
  } catch (err: any) {
    logger.error({ err: err.message, userId }, "Generate personalised roadmap failed");
    throw err;
  }
}

// ── Invalidate roadmap cache (called after voice rebuild) ──────────────────

export async function invalidateRoadmapCache(userId: string): Promise<void> {
  try {
    const cacheKey = `roadmap:${userId}`;
    await cache.del(cacheKey);
    logger.debug({ userId }, "Roadmap cache invalidated");
  } catch (err: any) {
    logger.warn(
      { err: err.message, userId },
      "Roadmap cache invalidation failed",
    );
  }
}
