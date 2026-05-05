// src/services/voice.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Creator Voice Portrait Builder
//
// Synthesises a creator's voice fingerprint from:
//   - Their content history (aria_memory observations)
//   - Their scraped Instagram summary
//   - Their aria_last_analysis
//   - Their aria_memory entries
//
// Rebuilt weekly per user. Used by scripting to make output sound like them.
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";

const VOICE_CACHE_TTL = 60 * 60 * 24; // 24 hours

export interface VoicePortrait {
  // Core voice characteristics
  toneSignature:         string;    // e.g. "casual-humorous" | "warm-educational"
  vocabularyLevel:       "casual" | "technical" | "mixed" | "hinglish-heavy";
  energyLevel:           "high" | "medium" | "calm";
  sentenceStyle:         string;    // e.g. "short punchy sentences" | "detailed explanations"

  // Content DNA
  primaryTopics:         string[];  // top 3 topics this creator returns to
  contentTerritory:      string;    // one-line summary of their content identity
  avoidTopics:           string[];  // topics they never cover or have said to avoid

  // Hook and format patterns
  preferredHookStyle:    string;    // e.g. "question hook" | "shock statement" | "relatable story"
  preferredFormats:      string[];  // Reel, Carousel, etc.
  preferredLanguage:     string;    // Hindi | English | Hinglish

  // Audience and constraints
  audienceDescription:   string;    // who their audience is
  personalConstraints:   string[];  // faceless, solo, phone-only etc.

  // What ARIA knows about their performance
  performanceInsights:   string;    // what has worked, what hasn't

  // Meta
  confidence:            number;    // 0-1, based on data volume
  dataPoints:            number;    // how many memory items were used
  builtAt:               string;
}

// ── Get voice portrait — from cache first ────────────────────────────────────

export async function getVoicePortrait(userId: string): Promise<VoicePortrait | null> {
  const cacheKey = `voice:${userId}`;
  const cached = await cache.get(cacheKey) as VoicePortrait | null;
  if (cached) return cached;

  try {
    const row = await (prisma as any).creator_voice_profiles.findUnique({
      where: { user_id: userId },
    });

    if (!row) return null;

    const portrait = row.voice_data as VoicePortrait;
    await cache.set(cacheKey, portrait, VOICE_CACHE_TTL);
    return portrait;
  } catch (err: any) {
    logger.warn({ err: err.message, userId }, "Voice portrait fetch failed");
    return null;
  }
}

// ── Build voice portrait for a user ─────────────────────────────────────────

export async function buildVoicePortrait(userId: string): Promise<VoicePortrait | null> {
  try {
    logger.info({ userId }, "Building voice portrait...");

    // Gather all available data in parallel
    const [userRow, memoryRows, contentHistory] = await Promise.allSettled([
      prisma.users.findUnique({
        where: { id: userId },
        select: {
          archetype:          true,
          archetype_label:    true,
          niches:             true,
          primary_platform:   true,
          follower_range:     true,
          scraped_summary:    true,
          aria_last_analysis: true,
          tone_profile:       true,
        },
      }),
      prisma.aria_memory.findMany({
        where: { user_id: userId, confidence: { gte: 50 } },
        orderBy: [{ confidence: "desc" }, { times_seen: "desc" }],
        take:    50,
        select:  { category: true, key: true, value: true, confidence: true, times_seen: true },
      }),
      prisma.content_history.findMany({
        where:   { user_id: userId },
        orderBy: { created_at: "desc" },
        take:    30,
        select:  { trend_title: true, hook: true, content_format: true, niche: true },
      }),
    ]);

    const user        = userRow.status        === "fulfilled" ? userRow.value        : null;
    const memory      = memoryRows.status     === "fulfilled" ? memoryRows.value     : [];
    const history     = contentHistory.status === "fulfilled" ? contentHistory.value : [];

    if (!user) {
      logger.warn({ userId }, "User not found for voice portrait build");
      return null;
    }

    // Build a structured context string for the AI
    const scrapedSummary  = (user.scraped_summary as any)  || {};
    const ariaAnalysis    = (user.aria_last_analysis as any) || {};

    // Group memory by category
    const memoryByCategory: Record<string, any[]> = {};
    for (const mem of memory as any[]) {
      if (!memoryByCategory[mem.category]) memoryByCategory[mem.category] = [];
      memoryByCategory[mem.category].push(mem);
    }

    const memoryContext = Object.entries(memoryByCategory)
      .map(([cat, items]) =>
        `${cat}: ${(items as any[]).map(i => `${i.key}="${i.value}" (seen ${i.times_seen}x)`).join(", ")}`
      ).join("\n");

    const historyContext = (history as any[]).length > 0
      ? (history as any[]).map(h => `- ${h.trend_title} | ${h.content_format} | ${h.niche}`).join("\n")
      : "No content history yet";

    const dataPoints = (memory as any[]).length + (history as any[]).length;
    const confidence = Math.min(0.95, Math.max(0.2, dataPoints / 80));

    const { _callGroq } = await import("./ai/groq.service");

    const prompt = `You are ARIA's creator intelligence system. Build a voice portrait for this creator based on all available data.

CREATOR PROFILE:
- Archetype: ${user.archetype || "Unknown"} (${user.archetype_label || ""})
- Niche: ${Array.isArray(user.niches) ? user.niches.join(", ") : user.niches || "Unknown"}
- Platform: ${user.primary_platform || "Instagram"}
- Follower Range: ${user.follower_range || "Unknown"}

INSTAGRAM DATA (from scrape):
- Top posts: ${scrapedSummary.topPosts?.slice(0,5).join(", ") || "Not available"}
- Best posting time: ${scrapedSummary.bestPostingTime || "Unknown"}
- Top hashtags: ${scrapedSummary.topHashtags?.slice(0,8).join(", ") || "None"}
- Avg likes: ${scrapedSummary.avgLikes || "Unknown"}

ARIA ANALYSIS:
${ariaAnalysis.strengths ? `Strengths: ${ariaAnalysis.strengths?.slice(0,3).join(", ")}` : ""}
${ariaAnalysis.gaps ? `Gaps: ${ariaAnalysis.gaps?.slice(0,3).join(", ")}` : ""}

ARIA MEMORY (${(memory as any[]).length} learnings about this creator):
${memoryContext || "No memory learnings yet"}

CONTENT HISTORY (last 30 posts):
${historyContext}

Based on ALL of this, synthesise a voice portrait. Be specific to this creator, not generic.
If data is sparse, make reasonable inferences based on their archetype and niche.

Respond ONLY with valid JSON:
{
  "toneSignature": "one compound descriptor like casual-humorous or warm-educational or energetic-informative",
  "vocabularyLevel": "casual | technical | mixed | hinglish-heavy",
  "energyLevel": "high | medium | calm",
  "sentenceStyle": "describe their likely sentence structure e.g. short punchy sentences with emojis",
  "primaryTopics": ["topic1", "topic2", "topic3"],
  "contentTerritory": "one sentence describing what this creator is fundamentally about",
  "avoidTopics": ["topics they never cover or have said to avoid"],
  "preferredHookStyle": "their most natural hook type e.g. question hook or relatable story or shock statement",
  "preferredFormats": ["Reel", "Carousel"],
  "preferredLanguage": "Hindi | English | Hinglish",
  "audienceDescription": "who their audience likely is based on niche and content",
  "personalConstraints": ["list constraints like faceless creator or solo creator or phone only"],
  "performanceInsights": "one paragraph on what works for this creator based on available data",
  "confidence": ${confidence.toFixed(2)},
  "dataPoints": ${dataPoints}
}`;

    const result = await _callGroq(prompt, { maxTokens: 800, useLlama: false });
    if (!result?.toneSignature) {
      logger.warn({ userId }, "Voice portrait AI returned invalid structure");
      return null;
    }

    const portrait: VoicePortrait = {
      ...result,
      builtAt:    new Date().toISOString(),
      confidence,
      dataPoints,
    };

    // Save to DB
    await (prisma as any).creator_voice_profiles.upsert({
      where:  { user_id: userId },
      create: {
        user_id:        userId,
        voice_data:     portrait as any,
        posts_analysed: (history as any[]).length,
        confidence,
        built_at:       new Date(),
        next_rebuild_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      update: {
        voice_data:     portrait as any,
        posts_analysed: (history as any[]).length,
        confidence,
        built_at:       new Date(),
        next_rebuild_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Cache it
    await cache.set(`voice:${userId}`, portrait, VOICE_CACHE_TTL);

    logger.info({ userId, confidence, dataPoints }, "Voice portrait built successfully");
    return portrait;
  } catch (err: any) {
    logger.error({ err: err.message, userId }, "Voice portrait build failed");
    return null;
  }
}

// ── Format voice portrait as system prompt injection ─────────────────────────
// Called by aria_prompt.service.ts to inject voice into every prompt

export function formatVoiceForPrompt(portrait: VoicePortrait | null): string {
  if (!portrait) return "";

  const constraints = portrait.personalConstraints?.length > 0
    ? `\nCONSTRAINTS (never violate): ${portrait.personalConstraints.join(", ")}`
    : "";

  const avoidTopics = portrait.avoidTopics?.length > 0
    ? `\nNEVER suggest: ${portrait.avoidTopics.join(", ")}`
    : "";

  return `
══ CREATOR VOICE PORTRAIT (confidence: ${Math.round((portrait.confidence || 0) * 100)}%) ══
Identity: ${portrait.contentTerritory}
Voice: ${portrait.toneSignature} | ${portrait.vocabularyLevel} vocabulary | ${portrait.energyLevel} energy
Style: ${portrait.sentenceStyle}
Language: ${portrait.preferredLanguage}
Primary topics: ${portrait.primaryTopics?.join(", ") || "general"}
Hook style: ${portrait.preferredHookStyle}
Audience: ${portrait.audienceDescription}
Formats: ${portrait.preferredFormats?.join(", ") || "Reel"}${constraints}${avoidTopics}

PERFORMANCE INSIGHTS: ${portrait.performanceInsights}

SCRIPTING RULE: All scripts, hooks, and content ideas MUST match this voice portrait.
Write as if you are this creator, not as a generic AI. Use their natural tone, vocabulary, and style.`;
}
