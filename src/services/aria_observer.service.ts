// src/services/aria_observer.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// ARIA Behavioural Observer
//
// Watches what creators DO, not just what they say.
// Called after every completed turn to detect implicit preferences.
//
// Observations tracked:
//   1. Script rewrite requests — creator asked to change output
//   2. Topic territory — what subjects keep appearing in conversation
//   3. Ignored suggestions — what ARIA suggested that creator moved past
//   4. Format signals — what content formats appear in creator's messages
//   5. Engagement patterns — time of day, session length, return frequency
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import { upsertMemory } from "./aria_memory.service";

// ── Detect if this turn was a correction/rewrite request ────────────────────
// When a creator asks to rewrite something, it signals the first version
// did not match their voice. Track what they asked to change.

function isRewriteRequest(userMessage: string): boolean {
  const lower = userMessage.toLowerCase();
  const rewriteSignals = [
    "rewrite", "redo", "change this", "make it more", "make it less",
    "too formal", "too casual", "doesn't sound like me", "not my style",
    "more like me", "different tone", "try again", "not quite right",
    "change the hook", "different hook", "not what i wanted",
  ];
  return rewriteSignals.some(signal => lower.includes(signal));
}

// ── Extract topic territory from message ────────────────────────────────────
// Identifies recurring subjects that define the creator's content identity

function extractTopicSignals(userMessage: string): string[] {
  const lower = userMessage.toLowerCase();
  const topicMap: Record<string, string[]> = {
    budget:       ["budget", "affordable", "cheap", "save money", "low cost", "₹"],
    luxury:       ["luxury", "premium", "high end", "expensive", "brand"],
    food:         ["recipe", "cooking", "food", "eat", "dish", "kitchen", "restaurant"],
    fitness:      ["workout", "gym", "exercise", "fitness", "weight", "muscle", "yoga"],
    travel:       ["travel", "trip", "destination", "hotel", "flight", "explore"],
    fashion:      ["outfit", "fashion", "clothes", "wear", "style", "ootd"],
    beauty:       ["skincare", "makeup", "beauty", "glow", "skin", "hair"],
    tech:         ["tech", "gadget", "phone", "laptop", "app", "software"],
    education:    ["learn", "study", "tips", "how to", "guide", "tutorial", "explain"],
    comedy:       ["funny", "joke", "humor", "laugh", "meme", "comedy"],
    motivation:   ["motivation", "inspire", "hustle", "success", "mindset", "goal"],
    relationships:["relationship", "dating", "love", "friends", "family", "couple"],
    business:     ["business", "startup", "entrepreneur", "money", "income", "brand"],
    bollywood:    ["bollywood", "movie", "song", "actor", "film", "hindi film"],
    cricket:      ["cricket", "ipl", "match", "team", "player", "score"],
  };

  const detected: string[] = [];
  for (const [topic, keywords] of Object.entries(topicMap)) {
    if (keywords.some(kw => lower.includes(kw))) {
      detected.push(topic);
    }
  }
  return detected;
}

// ── Extract format preference signals ───────────────────────────────────────

function extractFormatSignals(userMessage: string): string | null {
  const lower = userMessage.toLowerCase();
  if (lower.includes("reel") || lower.includes("reels")) return "Reel";
  if (lower.includes("carousel")) return "Carousel";
  if (lower.includes("short") || lower.includes("youtube short")) return "Short";
  if (lower.includes("long form") || lower.includes("youtube video") || lower.includes("full video")) return "Long-form";
  if (lower.includes("story") || lower.includes("stories")) return "Story";
  return null;
}

// ── Detect personal constraint signals ──────────────────────────────────────
// Things the creator cannot or will not do

function extractConstraints(userMessage: string): Array<{key: string, value: string}> {
  const lower = userMessage.toLowerCase();
  const constraints: Array<{key: string, value: string}> = [];

  if (lower.includes("no face") || lower.includes("dont show face") || lower.includes("don't show my face") || lower.includes("faceless")) {
    constraints.push({ key: "face_on_camera", value: "never shows face on camera" });
  }
  if (lower.includes("no budget") || lower.includes("no money to spend") || lower.includes("can't afford")) {
    constraints.push({ key: "production_budget", value: "minimal to zero production budget" });
  }
  if (lower.includes("solo creator") || lower.includes("just me") || lower.includes("i work alone") || lower.includes("no team")) {
    constraints.push({ key: "team_size", value: "solo creator, no team" });
  }
  if (lower.includes("can't edit") || lower.includes("no editing skills") || lower.includes("basic editing only")) {
    constraints.push({ key: "editing_skill", value: "basic editing only" });
  }
  if (lower.includes("phone only") || lower.includes("just my phone") || lower.includes("no camera")) {
    constraints.push({ key: "equipment", value: "smartphone only, no dedicated camera" });
  }

  return constraints;
}

// ── Main observer function — called after every turn ────────────────────────

export async function observeTurn(
  userId: string,
  userMessage: string,
  ariaResponse: string,
  toolsUsed: string[] = [],
): Promise<void> {
  try {
    // 1. Track rewrite requests — voice mismatch signal
    if (isRewriteRequest(userMessage)) {
      await upsertMemory(userId, {
        category: "voice_signal",
        key:      "rewrite_count",
        value:    String(await getRewriteCount(userId) + 1),
        source:   "observed",
      });

      // Also track what they asked to change
      const lowerMsg = userMessage.toLowerCase();
      if (lowerMsg.includes("casual") || lowerMsg.includes("informal")) {
        await upsertMemory(userId, { category: "tone", key: "preferred_tone", value: "casual", source: "observed" });
      }
      if (lowerMsg.includes("formal") || lowerMsg.includes("professional")) {
        await upsertMemory(userId, { category: "tone", key: "preferred_tone", value: "professional", source: "observed" });
      }
      if (lowerMsg.includes("funny") || lowerMsg.includes("humorous")) {
        await upsertMemory(userId, { category: "tone", key: "preferred_tone", value: "humorous", source: "observed" });
      }
    }

    // 2. Track topic territory — what subjects this creator keeps returning to
    const topics = extractTopicSignals(userMessage);
    for (const topic of topics) {
      await incrementTopicFrequency(userId, topic);
    }

    // 3. Track format preferences mentioned in passing
    const format = extractFormatSignals(userMessage);
    if (format) {
      await upsertMemory(userId, {
        category: "content_format",
        key:      "mentioned_format",
        value:    format,
        source:   "observed",
      });
    }

    // 4. Track personal constraints
    const constraints = extractConstraints(userMessage);
    for (const constraint of constraints) {
      await upsertMemory(userId, {
        category: "personal_constraint",
        key:      constraint.key,
        value:    constraint.value,
        source:   "observed",
      });
    }

    // 5. Track tools used — gives us signal about what the creator cares about
    if (toolsUsed.length > 0) {
      const toolCategories = toolsUsed.map(t => {
        if (t.includes("trend")) return "trends";
        if (t.includes("song") || t.includes("bgm")) return "audio";
        if (t.includes("youtube") || t.includes("instagram")) return "analytics";
        if (t.includes("content_history")) return "content_history";
        return null;
      }).filter(Boolean);

      for (const category of toolCategories) {
        if (category) {
          await upsertMemory(userId, {
            category: "interest_signal",
            key:      `frequently_uses_${category}`,
            value:    "true",
            source:   "observed",
          });
        }
      }
    }

  } catch (err: any) {
    // Never throw — observer is non-critical
    logger.warn({ err: err.message, userId }, "Observer failed — non-fatal");
  }
}

// ── Helper: Get current rewrite count ───────────────────────────────────────

async function getRewriteCount(userId: string): Promise<number> {
  try {
    const mem = await prisma.aria_memory.findFirst({
      where: { user_id: userId, category: "voice_signal", key: "rewrite_count" },
      select: { value: true },
    });
    return mem ? parseInt(mem.value) || 0 : 0;
  } catch { return 0; }
}

// ── Helper: Increment topic frequency counter ────────────────────────────────

async function incrementTopicFrequency(userId: string, topic: string): Promise<void> {
  try {
    const existing = await prisma.aria_memory.findFirst({
      where: { user_id: userId, category: "content_territory", key: `topic_${topic}` },
      select: { id: true, value: true },
    });

    const currentCount = existing ? parseInt(existing.value) || 0 : 0;
    const newCount = currentCount + 1;

    if (existing) {
      await prisma.aria_memory.update({
        where: { id: existing.id },
        data: {
          value:        String(newCount),
          times_seen:   newCount,
          last_seen_at: new Date(),
        },
      });
    } else {
      await prisma.aria_memory.create({
        data: {
          user_id:    userId,
          category:   "content_territory",
          key:        `topic_${topic}`,
          value:      "1",
          source:     "observed",
          confidence: 55,
          times_seen: 1,
        },
      });
    }

    // If a topic has been mentioned 3+ times, boost confidence
    if (newCount >= 3) {
      await prisma.aria_memory.updateMany({
        where: { user_id: userId, category: "content_territory", key: `topic_${topic}` },
        data: { confidence: Math.min(90, 55 + newCount * 5) },
      });

      // Also write a synthesised summary memory for this territory
      await upsertMemory(userId, {
        category: "content_territory",
        key:      "primary_topic",
        value:    topic,
        source:   "observed",
      });
    }
  } catch (err: any) {
    logger.warn({ err: err.message, userId, topic }, "Topic frequency update failed");
  }
}
