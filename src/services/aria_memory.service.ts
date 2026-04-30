import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";

const MEMORY_CACHE_TTL = 300; // 5 minutes

export interface MemoryItem {
  key: string;
  value: string;
  confidence: number;
  source: string;
}

export type MemoryMap = Record<string, MemoryItem[]>;

/**
 * Read all memories for a user
 */
export const getMemory = async (userId: string): Promise<MemoryMap> => {
  const cacheKey = `aria_memory:${userId}`;
  const cached = (await cache.get(cacheKey)) as MemoryMap | null;
  if (cached) return cached;

  const rows = (await prisma.aria_memory.findMany({
    where: {
      user_id: userId,
      confidence: { gte: 40 },
    },
    orderBy: [{ confidence: "desc" }, { times_seen: "desc" }],
    take: 30,
    select: {
      category: true,
      key: true,
      value: true,
      confidence: true,
      source: true,
      times_seen: true,
    },
  })) as any[];

  const memory: MemoryMap = {};
  for (const row of rows) {
    if (!memory[row.category]) memory[row.category] = [];
    memory[row.category].push({
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      source: row.source,
    });
  }

  await cache.set(cacheKey, memory, MEMORY_CACHE_TTL);
  return memory;
};

export interface UpsertMemoryParams {
  category: string;
  key: string;
  value: string;
  source?: "explicit" | "observed" | "inferred";
}

/**
 * Write or reinforce a memory
 */
export const upsertMemory = async (
  userId: string,
  { category, key, value, source = "inferred" }: UpsertMemoryParams,
) => {
  try {
    const existing = await prisma.aria_memory.findFirst({
      where: { user_id: userId, category, key },
      select: { id: true, value: true, confidence: true, times_seen: true },
    });

    if (existing) {
      const delta = existing.value === value ? 5 : -10;
      const nextConfidence = Math.min(
        95,
        Math.max(0, (existing.confidence || 50) + delta),
      );
      await prisma.aria_memory.update({
        where: { id: existing.id },
        data: {
          value,
          times_seen: (existing.times_seen || 0) + 1,
          confidence: nextConfidence,
          last_seen_at: new Date(),
        },
      });
    } else {
      const baseConfidence =
        source === "explicit" ? 85 : source === "observed" ? 70 : 55;
      await prisma.aria_memory.create({
        data: {
          user_id: userId,
          category,
          key,
          value,
          source,
          confidence: baseConfidence,
          times_seen: 1,
          last_seen_at: new Date(),
        },
      });
    }

    // Bust cache so next session gets fresh memory
    await cache.del(`aria_memory:${userId}`);
  } catch (err) {
    logger.warn(
      { err, userId, category, key },
      "Memory upsert failed — non-fatal",
    );
  }
};

/**
 * Extract and save learnings from a completed ARIA response
 */
export const extractLearningsFromTurn = async (
  userId: string,
  userMessage: string,
  ariaResponse: string,
) => {
  const lowerMsg = userMessage.toLowerCase();
  const lowerRes = ariaResponse.toLowerCase();

  const extractions: UpsertMemoryParams[] = [];

  // Hook language preference
  if (lowerMsg.includes("hindi") || lowerRes.includes("hindi hook")) {
    extractions.push({
      category: "hook_language",
      key: "preferred_language",
      value: "Hindi",
      source: "explicit",
    });
  }
  if (lowerMsg.includes("english hook") || lowerMsg.includes("in english")) {
    extractions.push({
      category: "hook_language",
      key: "preferred_language",
      value: "English",
      source: "explicit",
    });
  }
  if (lowerMsg.includes("hinglish")) {
    extractions.push({
      category: "hook_language",
      key: "preferred_language",
      value: "Hinglish",
      source: "explicit",
    });
  }

  // Tone preferences
  if (lowerMsg.includes("more casual") || lowerMsg.includes("too formal")) {
    extractions.push({
      category: "tone",
      key: "preferred_tone",
      value: "casual",
      source: "explicit",
    });
  }
  if (
    lowerMsg.includes("more professional") ||
    lowerMsg.includes("too casual")
  ) {
    extractions.push({
      category: "tone",
      key: "preferred_tone",
      value: "professional",
      source: "explicit",
    });
  }
  if (lowerMsg.includes("funny") || lowerMsg.includes("humorous")) {
    extractions.push({
      category: "tone",
      key: "preferred_tone",
      value: "humorous",
      source: "explicit",
    });
  }

  // Content format preferences
  if (lowerMsg.includes("i like reels") || lowerMsg.includes("prefer reels")) {
    extractions.push({
      category: "content_format",
      key: "preferred_format",
      value: "Reel",
      source: "explicit",
    });
  }
  if (
    lowerMsg.includes("i like carousels") ||
    lowerMsg.includes("prefer carousels")
  ) {
    extractions.push({
      category: "content_format",
      key: "preferred_format",
      value: "Carousel",
      source: "explicit",
    });
  }

  // Schedule preferences
  const timeMatch = lowerMsg.match(
    /(\d{1,2}(?::\d{2})?\s?(?:am|pm)\s?(?:ist)?)/i,
  );
  if (
    timeMatch &&
    (lowerMsg.includes("post") || lowerMsg.includes("schedule"))
  ) {
    extractions.push({
      category: "schedule",
      key: "preferred_post_time",
      value: timeMatch[1].trim(),
      source: "explicit",
    });
  }

  // Brand voice
  if (lowerMsg.includes("no emojis") || lowerMsg.includes("without emojis")) {
    extractions.push({
      category: "brand_voice",
      key: "emoji_preference",
      value: "none",
      source: "explicit",
    });
  }
  if (lowerMsg.includes("more emojis") || lowerMsg.includes("add emojis")) {
    extractions.push({
      category: "brand_voice",
      key: "emoji_preference",
      value: "heavy",
      source: "explicit",
    });
  }

  // Save all extracted learnings
  for (const learning of extractions) {
    await upsertMemory(userId, learning);
  }

  return extractions;
};

/**
 * Build the memory injection block for the system prompt
 */
export const buildMemoryBlock = (memory: MemoryMap): string => {
  if (!memory || Object.keys(memory).length === 0) return "";

  const lines: string[] = [];

  if (memory.hook_language?.length) {
    const lang = memory.hook_language.find(
      (m) => m.key === "preferred_language",
    );
    if (lang) lines.push(`- Always write hooks and captions in ${lang.value}`);
  }

  if (memory.tone?.length) {
    const tone = memory.tone.find((m) => m.key === "preferred_tone");
    if (tone) lines.push(`- Use a ${tone.value} tone in all responses`);
  }

  if (memory.content_format?.length) {
    const fmt = memory.content_format.find((m) => m.key === "preferred_format");
    if (fmt)
      lines.push(
        `- User prefers ${fmt.value} format — bias suggestions toward it`,
      );
  }

  if (memory.schedule?.length) {
    const time = memory.schedule.find((m) => m.key === "preferred_post_time");
    if (time)
      lines.push(`- User's preferred posting time is ${time.value} IST`);
  }

  if (memory.brand_voice?.length) {
    const emoji = memory.brand_voice.find((m) => m.key === "emoji_preference");
    if (emoji) {
      if (emoji.value === "none")
        lines.push("- Do NOT use emojis in any output");
      if (emoji.value === "heavy")
        lines.push("- Use emojis liberally in captions and hooks");
    }
  }

  if (memory.audience_insight?.length) {
    memory.audience_insight.forEach((m) => {
      lines.push(`- ${m.key}: ${m.value}`);
    });
  }

  if (lines.length === 0) return "";

  return `\nPERSONAL LEARNINGS (apply these to every response — user has told you this over time):
${lines.join("\n")}`;
};

/**
 * Save ARIA's own suggestions so we can follow up
 */
export const storeSuggestion = async (
  userId: string,
  sessionId: string,
  suggestionType: string,
  suggestionData: any,
) => {
  try {
    const followUpAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    await prisma.aria_suggestions.create({
      data: {
        user_id: userId,
        session_id: sessionId,
        suggestion_type: suggestionType,
        suggestion_data: suggestionData,
        follow_up_at: followUpAt,
      },
    });
  } catch (err) {
    logger.warn({ err }, "Store suggestion failed — non-fatal");
  }
};

/**
 * Get pending suggestions for the 48hr follow-up nudge
 */
export const getPendingSuggestions = async (userId: string) => {
  try {
    return await prisma.aria_suggestions.findMany({
      where: {
        user_id: userId,
        status: "pending",
        follow_up_at: { lte: new Date() },
        follow_up_sent: false,
      },
      orderBy: { created_at: "desc" },
      take: 3,
      select: {
        id: true,
        suggestion_type: true,
        suggestion_data: true,
        created_at: true,
      },
    });
  } catch (err) {
    return [];
  }
};

/**
 * Observe analytics data and auto-write memories
 */
export const observeFromAnalytics = async (
  userId: string,
  analyticsData: any,
) => {
  const observations: UpsertMemoryParams[] = [];

  if (analyticsData.bestDay) {
    observations.push({
      category: "schedule",
      key: "best_posting_day",
      value: analyticsData.bestDay,
      source: "observed",
    });
  }

  if (analyticsData.bestTime) {
    observations.push({
      category: "schedule",
      key: "best_posting_time_observed",
      value: analyticsData.bestTime,
      source: "observed",
    });
  }

  if (analyticsData.topFormat) {
    observations.push({
      category: "content_format",
      key: "best_performing_format",
      value: analyticsData.topFormat,
      source: "observed",
    });
  }

  if (analyticsData.engagementRate) {
    observations.push({
      category: "audience_insight",
      key: "avg_engagement_rate",
      value: `${analyticsData.engagementRate}%`,
      source: "observed",
    });
  }

  for (const obs of observations) {
    await upsertMemory(userId, obs);
  }
};
