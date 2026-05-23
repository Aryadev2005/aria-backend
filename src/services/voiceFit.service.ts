// src/services/voiceFit.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Voice Fit Scoring Engine
//
// Deterministic service that scores how well a trend matches a creator's voice.
// Zero AI calls. Runs in <1ms per trend. Powers voice-gated trend discovery.
//
// Score Breakdown (0–100):
// - topicMatch:       0–30 (how well trend aligns with primary topics)
// - toneMatch:        0–25 (how well trend matches energy/tone)
// - formatMatch:      0–20 (format compatibility)
// - languageMatch:    0–15 (language preference alignment)
// - avoidPenalty:     0 to -30 (negative penalty for avoided topics)
//
// Final Score = topicMatch + toneMatch + formatMatch + languageMatch + avoidPenalty
// Clamped to 0–100
// ══════════════════════════════════════════════════════════════════════════════

import { VoicePortrait } from "./voice.service";
import { logger } from "../utils/logger";

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface VoiceFitScore {
  score: number;              // 0–100
  grade: "S" | "A" | "B" | "C" | "D";
  topicMatch: number;         // 0–30 component
  toneMatch: number;          // 0–25 component
  formatMatch: number;        // 0–20 component
  languageMatch: number;      // 0–15 component
  avoidPenalty: number;       // 0 to -30 (negative)
  reasons: string[];          // human-readable explanations
  badge?: "PERFECT_FIT" | "GREAT_FIT" | "STRETCH" | "AVOID";
}

export interface TrendInput {
  title: string;
  niche: string;
  platform: string;
  source?: string;
  format?: string;
  hookType?: string;
}

export interface TrendWithVoiceFit extends TrendInput {
  voiceFit: VoiceFitScore;
  compositeScore?: number;    // virality * 0.6 + voiceFit * 0.4
  score?: number;             // virality score from trend source
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalize and trim strings for comparison
 */
function normalize(str: string | undefined): string {
  if (!str) return "";
  return str.toLowerCase().trim();
}

/**
 * Check if any word from a list appears in target text (case-insensitive)
 * Returns: number of matches found
 */
function countMatches(words: string[], target: string): number {
  if (!words || !target) return 0;
  const normalizedTarget = normalize(target);
  let matchCount = 0;

  for (const word of words) {
    const normalizedWord = normalize(word);
    if (normalizedWord && normalizedTarget.includes(normalizedWord)) {
      matchCount++;
    }
  }

  return matchCount;
}

/**
 * Fuzzy niche matching: check if trend niche includes portrait niche
 * E.g., "personal finance" contains "finance"
 */
function nicheMatches(portraitNiche: string, trendNiche: string): boolean {
  const p = normalize(portraitNiche);
  const t = normalize(trendNiche);

  if (!p || !t) return false;

  // Exact match
  if (p === t) return true;

  // Fuzzy: check if one contains the other
  if (p.includes(t) || t.includes(p)) return true;

  // Word-level fuzzy: if portrait niche is multi-word, check if any word appears in trend niche
  const portraitWords = p.split(/\s+/);
  for (const word of portraitWords) {
    if (word && t.includes(word)) return true;
  }

  return false;
}

/**
 * Hook type matching
 */
function hookTypeMatches(hookType: string | undefined, target: string): boolean {
  if (!hookType || !target) return false;
  const h = normalize(hookType);
  const t = normalize(target);
  return t.includes(h) || h.includes(t);
}

/**
 * Determine grade from score
 */
function gradeFromScore(score: number): "S" | "A" | "B" | "C" | "D" {
  if (score >= 85) return "S";
  if (score >= 70) return "A";
  if (score >= 50) return "B";
  if (score >= 35) return "C";
  return "D";
}

/**
 * Determine badge from grade and avoid penalty
 */
function badgeFromGradeAndPenalty(
  grade: "S" | "A" | "B" | "C" | "D",
  avoidPenalty: number
): "PERFECT_FIT" | "GREAT_FIT" | "STRETCH" | "AVOID" | undefined {
  if (grade === "S") return "PERFECT_FIT";
  if (grade === "A") return "GREAT_FIT";
  if (avoidPenalty <= -20) return "AVOID";
  if ((grade === "C" || grade === "D") && avoidPenalty < -10) return "STRETCH";
  return undefined;
}

/**
 * Get badge color from grade
 */
export function getVoiceFitBadgeColor(grade: "S" | "A" | "B" | "C" | "D"): string {
  switch (grade) {
    case "S":
      return "#10b981"; // emerald
    case "A":
      return "#3b82f6"; // blue
    case "B":
      return "#f59e0b"; // amber
    case "C":
      return "#ef4444"; // red
    case "D":
      return "#6b7280"; // gray
    default:
      return "#6b7280";
  }
}

// ── Main Scoring Function ───────────────────────────────────────────────────

/**
 * Score a single trend against a voice portrait
 * Returns 0–100 deterministic score with detailed breakdown
 */
export function scoreVoiceFit(
  trend: TrendInput,
  portrait: VoicePortrait | null
): VoiceFitScore {
  // Handle null portrait
  if (!portrait) {
    return {
      score: 50,
      grade: "B",
      topicMatch: 0,
      toneMatch: 0,
      formatMatch: 10,
      languageMatch: 10,
      avoidPenalty: 0,
      reasons: ["No voice portrait — generate yours in Profile"],
    };
  }

  const reasons: string[] = [];
  let topicMatch = 0;
  let toneMatch = 0;
  let formatMatch = 0;
  let languageMatch = 0;
  let avoidPenalty = 0;

  // ──────────────────────────────────────────────────────────────────────────
  // TOPIC MATCH (0–30)
  // ──────────────────────────────────────────────────────────────────────────

  // Check primary topics word match
  if (portrait.primaryTopics && portrait.primaryTopics.length > 0) {
    const primaryTopicMatches = countMatches(portrait.primaryTopics, trend.title);
    if (primaryTopicMatches > 0) {
      topicMatch = 30;
      reasons.push(`Primary topic "${portrait.primaryTopics[0]}" mentioned in trend`);
    }
  }

  // Check niche match (if no primary topic match)
  if (topicMatch < 20 && portrait.contentTerritory) {
    if (nicheMatches(portrait.contentTerritory, trend.niche)) {
      topicMatch = Math.max(topicMatch, 20);
      reasons.push(`Niche "${trend.niche}" aligns with your content territory`);
    }
  }

  // Check content territory keyword overlap
  if (topicMatch < 30 && portrait.contentTerritory) {
    const territoryWords = portrait.contentTerritory
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((w) => w.length > 3); // Ignore short words

    const territoryMatches = countMatches(territoryWords, trend.title);
    if (territoryMatches > 0) {
      topicMatch = Math.max(topicMatch, 10);
      if (topicMatch === 10) {
        reasons.push(`Trend relates to your content territory`);
      }
    }
  }

  topicMatch = Math.min(topicMatch, 30);

  // ──────────────────────────────────────────────────────────────────────────
  // TONE MATCH (0–25)
  // ──────────────────────────────────────────────────────────────────────────

  const energyLevel = normalize(portrait.energyLevel);
  const hookType = normalize(trend.hookType || "");

  if (energyLevel === "high") {
    if (
      hookTypeMatches("shock", hookType) ||
      hookTypeMatches("challenge", hookType) ||
      hookTypeMatches("viral", hookType)
    ) {
      toneMatch = 25;
      reasons.push("High-energy trend matches your energetic style");
    }
  } else if (energyLevel === "calm") {
    if (
      hookTypeMatches("educational", hookType) ||
      hookTypeMatches("explainer", hookType) ||
      hookTypeMatches("guide", hookType)
    ) {
      toneMatch = 25;
      reasons.push("Educational format aligns with your calm, thoughtful style");
    }
  } else if (energyLevel === "medium") {
    toneMatch = 15; // Versatile
    reasons.push("Moderate energy — you're adaptable to various trend styles");
  }

  // Humor bonus
  if (toneMatch < 25 && portrait.toneSignature) {
    if (normalize(portrait.toneSignature).includes("humor")) {
      if (trend.title.includes("?") || trend.title.includes("!")) {
        toneMatch = Math.min(toneMatch + 5, 25);
        reasons.push("Humorous tone detected in trend title");
      }
    }
  }

  toneMatch = Math.min(toneMatch, 25);

  // ──────────────────────────────────────────────────────────────────────────
  // FORMAT MATCH (0–20)
  // ──────────────────────────────────────────────────────────────────────────

  if (trend.format && portrait.preferredFormats && portrait.preferredFormats.length > 0) {
    const trendFormat = normalize(trend.format);

    // Exact match
    if (
      portrait.preferredFormats.some((f) => normalize(f) === trendFormat)
    ) {
      formatMatch = 20;
      reasons.push(`${trend.format} is your preferred format`);
    }
    // Related format match (reel ↔ short, video ↔ long)
    else if (
      (normalize(trendFormat).includes("reel") && portrait.preferredFormats.some((f) => normalize(f).includes("short"))) ||
      (normalize(trendFormat).includes("short") && portrait.preferredFormats.some((f) => normalize(f).includes("reel"))) ||
      (normalize(trendFormat).includes("video") && portrait.preferredFormats.some((f) => normalize(f).includes("long"))) ||
      (normalize(trendFormat).includes("long") && portrait.preferredFormats.some((f) => normalize(f).includes("video")))
    ) {
      formatMatch = 10;
      reasons.push(`Related format — you typically use ${portrait.preferredFormats[0]}`);
    }
  } else {
    // No format info — neutral
    formatMatch = 10;
  }

  formatMatch = Math.min(formatMatch, 20);

  // ──────────────────────────────────────────────────────────────────────────
  // LANGUAGE MATCH (0–15)
  // ──────────────────────────────────────────────────────────────────────────

  const preferredLang = normalize(portrait.preferredLanguage);
  const platform = normalize(trend.platform);
  const source = normalize(trend.source || "");

  if (preferredLang === "hinglish") {
    if (platform.includes("instagram") || platform.includes("reels")) {
      languageMatch = 15;
      reasons.push("Hinglish content performs on Instagram — your preferred language");
    }
  } else if (preferredLang === "hindi") {
    // Check if trend is marked as Indian-specific
    if (trend.niche && (normalize(trend.niche).includes("india") || normalize(trend.niche).includes("indian"))) {
      languageMatch = 15;
      reasons.push("Hindi content — strong fit with Indian niche");
    }
  } else if (preferredLang === "english") {
    languageMatch = 10; // English always has baseline match
  }

  languageMatch = Math.min(languageMatch, 15);

  // ──────────────────────────────────────────────────────────────────────────
  // AVOID PENALTY (0 to -30)
  // ──────────────────────────────────────────────────────────────────────────

  if (portrait.avoidTopics && portrait.avoidTopics.length > 0) {
    const trendText = `${trend.title} ${trend.niche}`.toLowerCase();
    let penaltyApplied = 0;

    for (let i = 0; i < portrait.avoidTopics.length; i++) {
      const avoidWord = normalize(portrait.avoidTopics[i]);
      if (!avoidWord) continue;

      if (trendText.includes(avoidWord)) {
        penaltyApplied++;

        if (penaltyApplied === 1) {
          avoidPenalty -= 15;
          reasons.push(`⚠️ Avoid topic "${portrait.avoidTopics[i]}" detected`);
        } else if (penaltyApplied === 2) {
          avoidPenalty -= 10;
          reasons.push(`⚠️ Second avoid topic "${portrait.avoidTopics[i]}" detected`);
        } else {
          avoidPenalty -= 5;
        }
      }
    }
  }

  avoidPenalty = Math.max(avoidPenalty, -30);

  // ──────────────────────────────────────────────────────────────────────────
  // FINAL SCORE
  // ──────────────────────────────────────────────────────────────────────────

  let finalScore = topicMatch + toneMatch + formatMatch + languageMatch + avoidPenalty;
  finalScore = Math.max(0, Math.min(100, finalScore)); // Clamp 0–100

  const grade = gradeFromScore(finalScore);
  const badge = badgeFromGradeAndPenalty(grade, avoidPenalty);

  // Add summary reason
  if (reasons.length === 0) {
    reasons.push("Neutral fit — not explicitly aligned or misaligned with your voice");
  }

  return {
    score: finalScore,
    grade,
    topicMatch,
    toneMatch,
    formatMatch,
    languageMatch,
    avoidPenalty,
    reasons,
    badge,
  };
}

// ── Ranking Function ────────────────────────────────────────────────────────

/**
 * Score and rank trends by voice fit + virality composite
 *
 * Composite Score = (virality * 0.6) + (voiceFit.score * 0.4)
 * This ensures voice fit influences ranking but doesn't fully override viral potential
 */
export function rankTrendsByVoiceFit(
  trends: TrendInput[],
  portrait: VoicePortrait | null
): TrendWithVoiceFit[] {
  const scored = trends.map((trend) => {
    const voiceFit = scoreVoiceFit(trend, portrait);

    // Get virality score if available (default 50 if not provided)
    const viralityScore = "score" in trend ? (trend.score as number) || 50 : 50;

    const compositeScore = viralityScore * 0.6 + voiceFit.score * 0.4;

    return {
      ...trend,
      voiceFit,
      score: viralityScore,
      compositeScore,
    };
  });

  // Sort by composite score descending
  return scored.sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0));
}

// ── Batch Scoring ───────────────────────────────────────────────────────────

/**
 * Score multiple trends efficiently
 */
export function scoreMultipleTrends(
  trends: TrendInput[],
  portrait: VoicePortrait | null
): Array<TrendInput & { voiceFit: VoiceFitScore }> {
  return trends.map((trend) => ({
    ...trend,
    voiceFit: scoreVoiceFit(trend, portrait),
  }));
}

// ── Filtering Helpers ───────────────────────────────────────────────────────

/**
 * Filter trends by voice fit grade
 */
export function filterByGrade(
  trends: TrendWithVoiceFit[],
  minGrade: "S" | "A" | "B" | "C" | "D"
): TrendWithVoiceFit[] {
  const gradeOrder = { S: 5, A: 4, B: 3, C: 2, D: 1 };
  const minGradeValue = gradeOrder[minGrade];

  return trends.filter((t) => gradeOrder[t.voiceFit.grade] >= minGradeValue);
}

/**
 * Filter out trends with "AVOID" badge
 */
export function filterOutAvoided(
  trends: TrendWithVoiceFit[]
): TrendWithVoiceFit[] {
  return trends.filter((t) => t.voiceFit.badge !== "AVOID");
}

/**
 * Get trends with specific badge
 */
export function getTrendsByBadge(
  trends: TrendWithVoiceFit[],
  badge: "PERFECT_FIT" | "GREAT_FIT" | "STRETCH" | "AVOID"
): TrendWithVoiceFit[] {
  return trends.filter((t) => t.voiceFit.badge === badge);
}
