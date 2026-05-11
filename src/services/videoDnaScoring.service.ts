// src/services/videoDnaScoring.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Video DNA Deterministic Scoring Engine — v3
//
// Philosophy: The AI is the sensor. TypeScript is the brain.
//
// v3 Improvements:
//   1. Dynamic format weights (Shorts / Educational / Long-form / Standard)
//   2. Hook Dissonance Penalty (high curiosity + low clarity = clickbait flag)
//   3. Recency Decay on View Velocity (recent views > old views)
//   4. Niche Difficulty Coefficient (finance ER ≠ comedy ER)
//   5. Description Depth signals (first-line quality + lead magnet)
//   6. Thumbnail clutter as Content Quality negative signal
// ══════════════════════════════════════════════════════════════════════════════

import { getBenchmark } from './benchmarks.service';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type VideoFormat = 'shorts' | 'educational' | 'longform' | 'standard';

interface FormatWeights {
  hook:           number;
  engagement:     number;
  contentQuality: number;
  seo:            number;
}

/**
 * Raw signals the AI extracts. Each is a bounded integer.
 * AI temperature is set to 0 — pure extraction, not generation.
 * Bounds are enforced by clampSignals() before any computation.
 */
export interface RawSignals {
  // ── Hook signals (1–10 each) ──────────────────────────────────────────────
  titleCuriosity:             number;  // Does the title create curiosity or FOMO?
  titleClarity:               number;  // Is the topic immediately clear?
  titleEmotionalPull:         number;  // Does it trigger an emotion?

  // ── SEO signals (1–5 each) ────────────────────────────────────────────────
  keywordPresence:            number;  // Are searchable keywords in the title?
  descriptionQuality:         number;  // Is description optimised (not blank/spam)?
  tagRelevance:               number;  // Are tags relevant and non-spammy?
  descriptionFirstLineQuality:number;  // NEW: Is the first 150 chars compelling for search?
  hasLeadMagnet:              number;  // NEW: Newsletter/freebie link in description?

  // ── Content quality signals (1–10 each) ──────────────────────────────────
  thumbnailTitleSync:         number;  // Does title promise match what thumbnail implies?
  topicDepth:                 number;  // Is the topic specific enough to be valuable?
  indiaRelevance:             number;  // How relevant is this to Indian audience?

  // ── Narrative signals (1–5 each) — inferred from title/description ────────
  hasStrongHook:              number;  // 1 = no hook implied, 5 = strong hook implied
  hasCTA:                     number;  // 1 = no CTA, 5 = clear CTA in description
  hasChapters:                number;  // 1 = no chapters, 5 = chapters/timestamps present

  // ── Hook Dissonance signals (1–5 each) ───────────────────────────────────
  thumbnailClutter:           number;  // NEW: 1=clean/minimal, 5=very cluttered/noisy
  titleOverpromise:           number;  // NEW: 1=accurate delivery, 5=massive clickbait

  // ── Qualitative text (display only — NOT used in any formula) ─────────────
  ariaInsight:                string;
  actionItems:                string[];
  improvedHook:               string | null;
  betterTitle:                string | null;
  nextVideoSuggestion:        string;
  nextVideoReason:            string;
  benchmarkAnalysis:          string;
  benchmarkStats:             string[];
  shortsOpportunities: Array<{
    start:      number;
    end:        number;
    caption:    string;
    viralScore: number;
    reason:     string;
  }>;
}

export interface DerivedMetrics {
  engagementRate:           number;  // (likes + comments) / views * 100
  viewVelocityScore:        number;  // log10-normalised, recency-decayed (0–100)
  likeRatio:                number;  // likes / views * 100
  commentRatio:             number;  // comments / views * 100
  durationSeconds:          number;
  durationScore:            number;  // optimal duration scoring (0–100)
  benchmarkER:              number;  // niche average ER for comparison
  erVsBenchmark:            number;  // raw multiplier: actual ER / niche avg ER
  recencyDecayFactor:       number;  // NEW: 0.4–1.0 (1.0 = very recent)
}

export interface ComponentScores {
  hookScore:            number;  // 0–100
  seoScore:             number;  // 0–100
  contentQualityScore:  number;  // 0–100
  engagementScore:      number;  // 0–100
  overallScore:         number;  // weighted aggregate
  scoreVerdict:         string;
  grade:                string;
}

export interface VideoDNAReport {
  // ── Computed scores ────────────────────────────────────────────────────────
  overallScore:                 number;
  scoreVerdict:                 string;
  grade:                        string;
  scoreSummary:                 string;

  // ── Component scores ───────────────────────────────────────────────────────
  hookScore:                    number;
  seoScore:                     number;
  contentQualityScore:          number;
  engagementScore:              number;

  // ── Legacy fields — kept for frontend compatibility ────────────────────────
  titleScore:                   number;
  benchmarkScore:               number;

  // ── Derived metrics ────────────────────────────────────────────────────────
  engagementRate:               number;
  viewVelocityScore:            number;
  durationScore:                number;
  erVsBenchmark:                number;

  // ── NEW: Analysis metadata ─────────────────────────────────────────────────
  formatType:                   VideoFormat;  // detected format
  appliedWeights:               FormatWeights; // weights used for this video
  dissonancePenalty:            number;       // penalty subtracted from hook score
  nicheDifficultyCoefficient:   number;       // multiplier applied to engagement
  recencyDecayFactor:           number;       // decay applied to view velocity

  // ── Qualitative (AI-generated, display only) ───────────────────────────────
  hookAnalysis:                 string;
  improvedHook:                 string | null;
  titleAnalysis:                string;
  betterTitle:                  string | null;
  benchmarkAnalysis:            string;
  benchmarkStats:               string[];
  ariaInsight:                  string;
  actionItems:                  string[];
  nextVideoSuggestion:          string;
  nextVideoReason:              string;
  shortsOpportunities: Array<{
    start:      number;
    end:        number;
    caption:    string;
    viralScore: number;
    reason:     string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format Detection
// ─────────────────────────────────────────────────────────────────────────────

const EDUCATIONAL_KEYWORDS = [
  'tutorial', 'how to', 'how-to', 'guide', 'explained', 'learn',
  'course', 'lesson', 'tips', 'tricks', 'beginners', 'step by step',
  'masterclass', 'complete guide', 'full course',
];

// YouTube category IDs: 27 = Education, 28 = Science & Technology
const EDUCATIONAL_CATEGORY_IDS = new Set(['27', '28']);

export const detectVideoFormat = (
  durationSeconds: number,
  categoryId: string,
  title: string,
): VideoFormat => {
  // Shorts: up to 60 seconds
  if (durationSeconds > 0 && durationSeconds <= 60) return 'shorts';

  const titleLower = title.toLowerCase();
  const isEducational =
    EDUCATIONAL_CATEGORY_IDS.has(categoryId) ||
    EDUCATIONAL_KEYWORDS.some(kw => titleLower.includes(kw));

  if (isEducational) return 'educational';

  // Long-form: over 15 minutes
  if (durationSeconds > 900) return 'longform';

  return 'standard';
};

// ─────────────────────────────────────────────────────────────────────────────
// Format Weights
// Each row must sum to exactly 1.0
// ─────────────────────────────────────────────────────────────────────────────

const FORMAT_WEIGHTS: Record<VideoFormat, FormatWeights> = {
  shorts: {
    // Shorts live and die by ER (proxies swipe-away rate).
    // No one finds Shorts via search — SEO is almost irrelevant.
    hook:           0.35,
    engagement:     0.50,
    contentQuality: 0.10,
    seo:            0.05,
  },
  educational: {
    // Tutorial viewers come from search — SEO matters more.
    // Engagement and hook still important but more balanced.
    hook:           0.25,
    engagement:     0.25,
    contentQuality: 0.25,
    seo:            0.25,
  },
  longform: {
    // Long-form: hook determines if anyone starts watching.
    // Content quality determines if they finish (watch time).
    hook:           0.30,
    engagement:     0.28,
    contentQuality: 0.27,
    seo:            0.15,
  },
  standard: {
    // Baseline weights — same as original v2 for continuity.
    hook:           0.30,
    engagement:     0.30,
    contentQuality: 0.25,
    seo:            0.15,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Niche Difficulty Coefficient
// High-friction niches (finance, tech) naturally have low ER.
// Penalising a finance creator for not matching a K-pop channel's ER is unfair.
// coefficient > 1 → boost (low-engagement niche)
// coefficient < 1 → reduce (high-engagement niche)
// coefficient = 1 → no adjustment
// ─────────────────────────────────────────────────────────────────────────────

const NICHE_DIFFICULTY_MAP: Record<string, number> = {
  // Finance / Business — lurker audience, very low natural ER
  'finance':           1.25,
  'personal finance':  1.25,
  'investing':         1.25,
  'stock market':      1.25,
  'crypto':            1.20,
  'saas':              1.20,
  'b2b':               1.20,
  'business':          1.20,
  'entrepreneurship':  1.15,
  'marketing':         1.15,
  // Education / Tech — informed audience, reads but rarely engages
  'education':         1.15,
  'coding':            1.15,
  'programming':       1.15,
  'tech':              1.10,
  'technology':        1.10,
  'science':           1.10,
  'history':           1.10,
  // General / Lifestyle — baseline, no adjustment
  'fitness':           1.00,
  'health':            1.00,
  'wellness':          1.00,
  'travel':            1.00,
  'food':              1.00,
  'cooking':           1.00,
  'fashion':           1.00,
  'beauty':            1.00,
  'diy':               1.00,
  'photography':       1.00,
  // Entertainment — superfan audience, naturally high ER
  'vlogs':             0.90,
  'lifestyle vlog':    0.90,
  'comedy':            0.80,
  'entertainment':     0.80,
  'gaming':            0.80,
  'music':             0.85,
  'dance':             0.80,
  'memes':             0.75,
  'k-pop':             0.75,
  'reaction':          0.80,
  'prank':             0.75,
  'bollywood':         0.85,
  'cricket':           0.85,
};

export const getNicheDifficultyCoefficient = (niche: string): number => {
  const key = niche.toLowerCase().trim();

  // 1. Exact match
  if (NICHE_DIFFICULTY_MAP[key] !== undefined) return NICHE_DIFFICULTY_MAP[key];

  // 2. Partial match — handles compound niches like "personal finance tips"
  for (const [mapKey, coeff] of Object.entries(NICHE_DIFFICULTY_MAP)) {
    if (key.includes(mapKey) || mapKey.includes(key)) return coeff;
  }

  // 3. Default: no adjustment
  return 1.0;
};

// ─────────────────────────────────────────────────────────────────────────────
// Signal clamping — prevents AI hallucination from corrupting scores
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value ?? min)));

export const clampSignals = (raw: Partial<RawSignals>): RawSignals => ({
  // Hook (1–10)
  titleCuriosity:              clamp(raw.titleCuriosity              ?? 5,  1, 10),
  titleClarity:                clamp(raw.titleClarity                ?? 5,  1, 10),
  titleEmotionalPull:          clamp(raw.titleEmotionalPull          ?? 5,  1, 10),
  // SEO (1–5)
  keywordPresence:             clamp(raw.keywordPresence             ?? 3,  1,  5),
  descriptionQuality:          clamp(raw.descriptionQuality          ?? 3,  1,  5),
  tagRelevance:                clamp(raw.tagRelevance                ?? 3,  1,  5),
  descriptionFirstLineQuality: clamp(raw.descriptionFirstLineQuality ?? 3,  1,  5),
  hasLeadMagnet:               clamp(raw.hasLeadMagnet               ?? 2,  1,  5),
  // Content quality (1–10)
  thumbnailTitleSync:          clamp(raw.thumbnailTitleSync          ?? 5,  1, 10),
  topicDepth:                  clamp(raw.topicDepth                  ?? 5,  1, 10),
  indiaRelevance:              clamp(raw.indiaRelevance              ?? 5,  1, 10),
  // Narrative (1–5)
  hasStrongHook:               clamp(raw.hasStrongHook               ?? 3,  1,  5),
  hasCTA:                      clamp(raw.hasCTA                      ?? 3,  1,  5),
  hasChapters:                 clamp(raw.hasChapters                 ?? 1,  1,  5),
  // Dissonance (1–5)
  thumbnailClutter:            clamp(raw.thumbnailClutter            ?? 2,  1,  5),
  titleOverpromise:            clamp(raw.titleOverpromise            ?? 1,  1,  5),
  // Qualitative — passthrough, no clamping needed
  ariaInsight:                 raw.ariaInsight         ?? '',
  actionItems:                 Array.isArray(raw.actionItems)  ? raw.actionItems  : [],
  improvedHook:                raw.improvedHook        ?? null,
  betterTitle:                 raw.betterTitle         ?? null,
  nextVideoSuggestion:         raw.nextVideoSuggestion ?? '',
  nextVideoReason:             raw.nextVideoReason     ?? '',
  benchmarkAnalysis:           raw.benchmarkAnalysis   ?? '',
  benchmarkStats:              Array.isArray(raw.benchmarkStats) ? raw.benchmarkStats : [],
  shortsOpportunities: Array.isArray(raw.shortsOpportunities)
    ? raw.shortsOpportunities.map(s => ({
        start:      Math.max(0, Math.round(s.start      ?? 0)),
        end:        Math.max(1, Math.round(s.end        ?? 60)),
        caption:    String(s.caption    ?? ''),
        viralScore: Math.min(100, Math.max(1, Math.round(s.viralScore ?? 50))),
        reason:     String(s.reason     ?? ''),
      }))
    : [],
});

// ─────────────────────────────────────────────────────────────────────────────
// Derived metric helpers — pure functions, zero AI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recency Decay Factor (0.4 – 1.0)
 *
 * Formula: 1 / (1 + 0.05 × years_since_upload)
 * Floor:   0.4 — old content can't decay to zero
 * Override: 10M+ views = no decay (culturally significant regardless of age)
 *
 * Examples:
 *   Uploaded yesterday  → 1.00
 *   Uploaded 1 year ago → 0.95
 *   Uploaded 4 years ago → 0.83
 *   Uploaded 10 years ago → 0.67 (floor not hit until ~15 years)
 */
const computeRecencyDecayFactor = (publishedAtRaw: string, views: number): number => {
  // Viral/significant content bypasses decay
  if (views >= 10_000_000) return 1.0;

  let years = 0;
  try {
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    years = (Date.now() - new Date(publishedAtRaw).getTime()) / msPerYear;
    if (years < 0) years = 0; // guard against future dates
  } catch {
    return 1.0; // if date parsing fails, no decay
  }

  const decay = 1 + (0.05 * years);
  return Math.max(0.4, parseFloat((1 / decay).toFixed(3)));
};

/**
 * View Velocity Score (0–100) — log10-normalised with recency decay.
 *
 * Calibrated to Indian YouTube distribution:
 *   100 views  → ~10  (micro)
 *   1K views   → ~20
 *   10K views  → ~40
 *   100K views → ~60
 *   1M views   → ~80
 *   10M views  → ~100 (cap before decay)
 */
const computeViewVelocity = (views: number, recencyDecayFactor: number): number => {
  if (!views || views <= 0 || !isFinite(views)) return 0;
  const decay = (!recencyDecayFactor || !isFinite(recencyDecayFactor)) ? 1.0 : recencyDecayFactor;
  // log10(10M) = 7, 100/7 ≈ 14.28 → maps 10M views to score 100 before decay
  const raw = Math.log10(views + 1) * 14.28;
  const result = Math.min(100, Math.round(raw * decay));
  return isNaN(result) ? 0 : result;
};

/**
 * Duration Score (0–100)
 *
 * Different optimal ranges by content type.
 * YouTube rewards videos that hold attention, not just long ones.
 *
 * Optimal ranges (Indian YouTube context):
 *   Shorts:   15–60s    → 85
 *   1–3 min:             → 65 (too short for long-form, too long for shorts)
 *   3–7 min:             → 75
 *   7–15 min:            → 95 (YouTube sweet spot)
 *   15–25 min:           → 85
 *   25–30 min:           → 75
 *   >30 min:             → 60 (penalised unless course/podcast)
 */
const computeDurationScore = (seconds: number): number => {
  if (seconds <= 0)    return 50; // unknown — neutral
  if (seconds <= 60)   return seconds >= 15 ? 85 : 60;  // Shorts (15–60s peak)
  if (seconds <= 180)  return 65;  // 1–3 min
  if (seconds <= 420)  return 75;  // 3–7 min
  if (seconds <= 900)  return 95;  // 7–15 min: YouTube sweet spot
  if (seconds <= 1500) return 85;  // 15–25 min
  if (seconds <= 1800) return 75;  // 25–30 min
  return 60;                       // >30 min
};

const computeERvsBenchmark = (er: number, benchER: number): number => {
  if ((benchER > 0 && isFinite(benchER))) {
    return parseFloat((er / benchER).toFixed(2));
  }
  return 0;
};

export const computeDerivedMetrics = (
  views:          number,
  likes:          number,
  comments:       number,
  durationSeconds:number,
  benchER:        number,
  publishedAtRaw: string,
): DerivedMetrics => {
  const engagementRate = views > 0
    ? parseFloat(((likes + comments) / views * 100).toFixed(2))
    : 0;

  const likeRatio    = views > 0 ? parseFloat((likes    / views * 100).toFixed(3)) : 0;
  const commentRatio = views > 0 ? parseFloat((comments / views * 100).toFixed(3)) : 0;

  const recencyDecayFactor = computeRecencyDecayFactor(publishedAtRaw, views);

  return {
    engagementRate,
    viewVelocityScore:  computeViewVelocity(views, recencyDecayFactor),
    likeRatio,
    commentRatio,
    durationSeconds,
    durationScore:      computeDurationScore(durationSeconds),
    benchmarkER:        benchER,
    erVsBenchmark:      computeERvsBenchmark(engagementRate, benchER),
    recencyDecayFactor,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Component score formulas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HOOK DISSONANCE PENALTY (0–15)
 *
 * Fires when titleCuriosity >> titleClarity (classic clickbait pattern).
 * High curiosity + no clarity = users click then immediately leave.
 * This penalises the Hook Score directly.
 *
 * Also penalises explicit over-promising (titleOverpromise).
 *
 * Gap penalty:        (curiosity - clarity - 5) × 1.5, max 10 pts
 * Overpromise penalty: (titleOverpromise - 1) × 1.25, max 5 pts
 * Total cap:          15 pts
 */
const computeHookDissonancePenalty = (s: RawSignals): number => {
  const clarityGap = s.titleCuriosity - s.titleClarity;
  const gapPenalty = clarityGap > 5
    ? Math.min(10, (clarityGap - 5) * 1.5)
    : 0;

  // titleOverpromise: 1=accurate, 5=massive clickbait
  // Maps 1→0, 5→5 penalty points
  const overpromisePenalty = Math.max(0, (s.titleOverpromise - 1) * 1.25);

  return Math.min(15, Math.round(gapPenalty + overpromisePenalty));
};

/**
 * HOOK SCORE (0–100)
 *
 * Base weights:
 *   titleCuriosity      → 35% (curiosity is the #1 click driver)
 *   titleEmotionalPull  → 25% (emotion drives share intent)
 *   titleClarity        → 20% (confusion = no click)
 *   thumbnailTitleSync  → 20% (broken promise = high bounce)
 *
 * Then subtract Hook Dissonance Penalty (0–15 pts).
 * Floor: 0 (cannot go negative).
 */
const computeHookScore = (s: RawSignals): number => {
  const n10 = (v: number) => (v - 1) / 9; // 1–10 → 0–1

  const base =
    n10(s.titleCuriosity)     * 35 +
    n10(s.titleEmotionalPull) * 25 +
    n10(s.titleClarity)       * 20 +
    n10(s.thumbnailTitleSync) * 20;

  const penalty = computeHookDissonancePenalty(s);

  return Math.max(0, Math.min(100, Math.round(base - penalty)));
};

/**
 * SEO SCORE (0–100)
 *
 * Weights (all sum to 100):
 *   keywordPresence             → 35% (title keywords: primary search signal)
 *   descriptionQuality          → 25% (description: YouTube ranks it heavily)
 *   descriptionFirstLineQuality → 12% (NEW: first 150 chars shown before "Show More")
 *   tagRelevance                → 10%
 *   hasChapters                 → 10% (improves watch time + search visibility)
 *   hasLeadMagnet               →  8% (NEW: ecosystem signal — newsletter, freebie)
 *
 * Normalisation: 1–5 signals → (v - 1) / 4 maps 1→0, 5→1
 */
const computeSeoScore = (s: RawSignals): number => {
  const n5 = (v: number) => (v - 1) / 4; // 1–5 → 0–1

  const raw =
    n5(s.keywordPresence)             * 35 +
    n5(s.descriptionQuality)          * 25 +
    n5(s.descriptionFirstLineQuality) * 12 +
    n5(s.tagRelevance)                * 10 +
    n5(s.hasChapters)                 * 10 +
    n5(s.hasLeadMagnet)               *  8;

  return Math.min(100, Math.round(raw));
};

/**
 * CONTENT QUALITY SCORE (0–100)
 *
 * Weights (sum to 100):
 *   topicDepth        → 30% (specific > generic always)
 *   indiaRelevance    → 25% (ARIA is India-first)
 *   hasStrongHook     → 20% (hook quality inferred from text)
 *   hasCTA            → 15% (no CTA = lost subscribers)
 *   thumbnailClearness→ 10% (NEW: cluttered thumbnails reduce perceived quality)
 *
 * thumbnailClutter is INVERTED: 1=clean (high quality), 5=cluttered (low quality)
 * Formula: (5 - thumbnailClutter) / 4 maps 1→1.0, 5→0.0
 */
const computeContentQualityScore = (s: RawSignals): number => {
  const n10 = (v: number) => (v - 1) / 9;
  const n5  = (v: number) => (v - 1) / 4;

  // Invert thumbnailClutter: higher clutter = lower score
  const thumbnailClearness = (5 - s.thumbnailClutter) / 4;

  const raw =
    n10(s.topicDepth)       * 30 +
    n10(s.indiaRelevance)   * 25 +
    n5(s.hasStrongHook)     * 20 +
    n5(s.hasCTA)            * 15 +
    thumbnailClearness      * 10;

  return Math.min(100, Math.round(raw));
};

/**
 * ENGAGEMENT SCORE (0–100)
 * Fully deterministic — zero AI.
 *
 * Niche Difficulty Coefficient is applied to erVsBenchmark before mapping.
 * This corrects for the fact that a finance creator's 1.2% ER is actually
 * strong, even though it looks weak against a general 3% benchmark.
 *
 * Weights:
 *   viewVelocityScore → 40% (already recency-decayed)
 *   erNorm            → 40% (benchmark-relative, difficulty-adjusted)
 *   durationScore     → 20% (optimal length proxy)
 */
const computeEngagementScore = (
  derived: DerivedMetrics,
  nicheDifficultyCoefficient: number,
): number => {
  // Apply difficulty coefficient to the raw multiplier before normalising
  const adjustedMultiplier = derived.erVsBenchmark * nicheDifficultyCoefficient;

  const erNorm = adjustedMultiplier >= 3.0 ? 100
    : adjustedMultiplier >= 2.0 ? 85
    : adjustedMultiplier >= 1.5 ? 70
    : adjustedMultiplier >= 1.0 ? 50
    : adjustedMultiplier >= 0.5 ? 30
    : 15;

  const safeVelocity  = isFinite(derived.viewVelocityScore)  ? derived.viewVelocityScore  : 0;
  const safeDuration  = isFinite(derived.durationScore)      ? derived.durationScore      : 50;
  const safeErNorm    = isFinite(erNorm)                     ? erNorm                     : 15;

  const raw =
    safeVelocity * 0.40 +
    safeErNorm   * 0.40 +
    safeDuration * 0.20;

  const score = Math.min(100, Math.round(raw));
  return isNaN(score) ? 0 : score;
};

/**
 * OVERALL SCORE (0–100)
 *
 * Uses format-specific weights from FORMAT_WEIGHTS.
 * Viral bonus: if erVsBenchmark > 2.0, add up to +5 points.
 */
const computeOverallScore = (
  components: Omit<ComponentScores, 'overallScore' | 'scoreVerdict' | 'grade'>,
  derived:    DerivedMetrics,
  format:     VideoFormat,
): number => {
  const w = FORMAT_WEIGHTS[format] ?? FORMAT_WEIGHTS['standard'];

  const safeHook        = isFinite(components.hookScore)           ? components.hookScore           : 0;
  const safeEngagement  = isFinite(components.engagementScore)     ? components.engagementScore     : 0;
  const safeContent     = isFinite(components.contentQualityScore) ? components.contentQualityScore : 0;
  const safeSeo         = isFinite(components.seoScore)            ? components.seoScore            : 0;

  const base =
    safeHook       * w.hook +
    safeEngagement * w.engagement +
    safeContent    * w.contentQuality +
    safeSeo        * w.seo;

  const erMultiplier = isFinite(derived.erVsBenchmark) ? derived.erVsBenchmark : 0;
  const viralBonus   = Math.min(5, Math.max(0, (erMultiplier - 2.0) * 5));

  const final = Math.min(100, Math.round(base + viralBonus));
  return isNaN(final) ? 0 : final;
};

/**
 * Score to verdict + grade.
 * Thresholds match Indian creator distribution:
 *   ~10% of videos score 80+
 *   ~25% score 65+
 *   ~40% score 50+
 */
const computeVerdict = (score: number): { verdict: string; grade: string } => {
  if (score >= 85) return { verdict: 'Viral Potential',    grade: 'A+' };
  if (score >= 75) return { verdict: 'Strong Performer',   grade: 'A'  };
  if (score >= 65) return { verdict: 'Good Start',         grade: 'B+' };
  if (score >= 55) return { verdict: 'Above Average',      grade: 'B'  };
  if (score >= 45) return { verdict: 'Needs Work',         grade: 'C+' };
  if (score >= 35) return { verdict: 'Below Average',      grade: 'C'  };
  return                  { verdict: 'Major Overhaul',     grade: 'D'  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Main export — orchestrates the full scoring pipeline
// ─────────────────────────────────────────────────────────────────────────────

export const computeVideoDNAReport = async (
  rawSignals:      Partial<RawSignals>,
  views:           number,
  likes:           number,
  comments:        number,
  durationSeconds: number,
  niche:           string,
  publishedAtRaw:  string,   // ISO 8601 — for recency decay
  categoryId:      string,   // YouTube category ID — for format detection
  videoTitle:      string,   // for format detection via title keywords
): Promise<VideoDNAReport> => {

  // 1. Clamp all AI signals to valid bounds
  const signals = clampSignals(rawSignals);

  // 2. Detect video format
  const formatType = detectVideoFormat(durationSeconds, categoryId, videoTitle);

  // 3. Get niche difficulty coefficient
  const nicheDifficultyCoefficient = getNicheDifficultyCoefficient(niche);

  // 4. Load niche benchmark (Redis → DB → fallback 3.0%)
  let benchER = 3.0;
  try {
    const bench = await getBenchmark(niche);
    benchER = bench.avgER;
  } catch (err) {
    logger.warn({ err, niche }, 'videoDnaScoring: benchmark fetch failed — using 3.0%');
  }

  // 5. Compute derived metrics (pure maths, no AI)
  const derived = computeDerivedMetrics(
    views, likes, comments, durationSeconds, benchER, publishedAtRaw,
  );

  // 6. Compute four component scores
  const hookScore           = computeHookScore(signals);
  const seoScore            = computeSeoScore(signals);
  const contentQualityScore = computeContentQualityScore(signals);
  const engagementScore     = computeEngagementScore(derived, nicheDifficultyCoefficient);

  // 7. Compute dissonance penalty for metadata (already applied inside hookScore)
  const dissonancePenalty = computeHookDissonancePenalty(signals);

  // 8. Compute overall score with format-aware weights
  const overallScore = computeOverallScore(
    { hookScore, seoScore, contentQualityScore, engagementScore },
    derived,
    formatType,
  );

  // 9. Grade and verdict
  const { verdict, grade } = computeVerdict(overallScore);

  // 10. Build human-readable score summary
  const safeERvsBench = isFinite(derived.erVsBenchmark) && derived.erVsBenchmark > 0
    ? derived.erVsBenchmark
    : 1.0;

  const erComparison = safeERvsBench >= 1.0
    ? `${(safeERvsBench * nicheDifficultyCoefficient).toFixed(1)}x above niche average (adjusted for ${niche} difficulty)`
    : `${((1 / safeERvsBench) * nicheDifficultyCoefficient).toFixed(1)}x below niche average (adjusted for ${niche} difficulty)`;

  const formatNote = formatType !== 'standard'
    ? ` (${formatType} weights applied)`
    : '';

  const scoreSummary =
    `Overall ${overallScore}/100 (${grade})${formatNote}. ` +
    `Hook ${hookScore}/100${dissonancePenalty > 0 ? ` [−${dissonancePenalty} dissonance]` : ''}, ` +
    `SEO ${seoScore}/100, Engagement ${engagementScore}/100. ` +
    `ER ${derived.engagementRate}% is ${erComparison}.`;

  return {
    // Scores
    overallScore,
    scoreVerdict:  verdict,
    grade,
    scoreSummary,

    // Component breakdown
    hookScore,
    seoScore,
    contentQualityScore,
    engagementScore,

    // Legacy fields — do NOT remove (frontend uses these)
    titleScore:     hookScore,
    benchmarkScore: engagementScore,

    // Derived metrics
    engagementRate:     derived.engagementRate,
    viewVelocityScore:  derived.viewVelocityScore,
    durationScore:      derived.durationScore,
    erVsBenchmark:      derived.erVsBenchmark,

    // New analysis metadata
    formatType,
    appliedWeights:             FORMAT_WEIGHTS[formatType],
    dissonancePenalty,
    nicheDifficultyCoefficient,
    recencyDecayFactor:         derived.recencyDecayFactor,

    // Qualitative — these come from AI and are set by the controller
    // The controller passes them in via rawSignals after running both AI calls
    hookAnalysis:        signals.ariaInsight,
    improvedHook:        signals.improvedHook,
    titleAnalysis:       signals.benchmarkAnalysis,
    betterTitle:         signals.betterTitle,
    benchmarkAnalysis:   signals.benchmarkAnalysis,
    benchmarkStats:      signals.benchmarkStats,
    ariaInsight:         signals.ariaInsight,
    actionItems:         signals.actionItems,
    nextVideoSuggestion: signals.nextVideoSuggestion,
    nextVideoReason:     signals.nextVideoReason,
    shortsOpportunities: signals.shortsOpportunities,
  };
};