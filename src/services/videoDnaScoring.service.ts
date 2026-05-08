// src/services/videoDnaScoring.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Video DNA Deterministic Scoring Engine
//
// Philosophy: The AI is the sensor. TypeScript is the brain.
// AI extracts raw 1–10 signals from the video metadata.
// Every final score (0–100) is computed here with explicit, auditable formulas.
// Same inputs → same outputs. Always. No AI variance in final numbers.
//
// Architecture:
//   1. RawSignals     — what the AI extracts (bounded integers, low temp)
//   2. DerivedMetrics — what we compute from YouTube data (pure maths)
//   3. ComponentScores — each dimension scored 0–100 deterministically
//   4. FinalReport    — weighted aggregation + verdict
// ══════════════════════════════════════════════════════════════════════════════

import { getBenchmark } from './benchmarks.service';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw signals the AI extracts. Each is a bounded integer.
 * AI temperature is set to 0 for these — pure extraction, not generation.
 * Bounds are enforced by clampSignal() before any computation.
 */
export interface RawSignals {
  // Hook signals (1–10 each)
  titleCuriosity:       number;  // Does the title create curiosity or FOMO?
  titleClarity:         number;  // Is the topic immediately clear?
  titleEmotionalPull:   number;  // Does it trigger an emotion?

  // SEO signals (1–5 each)
  keywordPresence:      number;  // Are searchable keywords in the title?
  descriptionQuality:   number;  // Is description optimised (not blank/spam)?
  tagRelevance:         number;  // Are tags relevant and non-spammy?

  // Content quality signals (1–10 each)
  thumbnailTitleSync:   number;  // Does title promise match what thumbnail implies?
  topicDepth:           number;  // Is the topic specific enough to be valuable?
  indiaRelevance:       number;  // How relevant is this to Indian audience?

  // Narrative signals (1–5 each) — inferred from title/description
  hasStrongHook:        number;  // 1 = no hook implied, 5 = strong hook implied
  hasCTA:               number;  // 1 = no CTA, 5 = clear CTA in description
  hasChapters:          number;  // 1 = no chapters, 5 = chapters present

  // Qualitative text (for display only — not used in formulas)
  ariaInsight:          string;
  actionItems:          string[];
  improvedHook:         string | null;
  betterTitle:          string | null;
  nextVideoSuggestion:  string;
  nextVideoReason:      string;
  benchmarkAnalysis:    string;
  benchmarkStats:       string[];
}

export interface DerivedMetrics {
  engagementRate:       number;  // (likes + comments) / views * 100
  viewVelocityScore:    number;  // log10-normalised view score (0–100)
  likeRatio:            number;  // likes / views * 100
  commentRatio:         number;  // comments / views * 100
  durationSeconds:      number;
  durationScore:        number;  // optimal duration scoring (0–100)
  benchmarkER:          number;  // niche average ER for comparison
  erVsBenchmark:        number;  // how many times above/below benchmark ER
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
  // Computed scores
  overallScore:         number;
  scoreVerdict:         string;
  grade:                string;
  scoreSummary:         string;

  // Component scores
  hookScore:            number;
  seoScore:             number;
  contentQualityScore:  number;
  engagementScore:      number;

  // Legacy fields (kept for frontend compatibility)
  titleScore:           number;
  benchmarkScore:       number;

  // Derived metrics (useful for display)
  engagementRate:       number;
  viewVelocityScore:    number;
  durationScore:        number;
  erVsBenchmark:        number;

  // Qualitative (AI-generated, display only)
  hookAnalysis:         string;
  improvedHook:         string | null;
  titleAnalysis:        string;
  betterTitle:          string | null;
  benchmarkAnalysis:    string;
  benchmarkStats:       string[];
  ariaInsight:          string;
  actionItems:          string[];
  nextVideoSuggestion:  string;
  nextVideoReason:      string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Clamp and validate raw signals
// Prevents AI hallucination outside bounds from corrupting scores
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value ?? min)));

const clampSignals = (raw: Partial<RawSignals>): RawSignals => ({
  titleCuriosity:      clamp(raw.titleCuriosity      ?? 5, 1, 10),
  titleClarity:        clamp(raw.titleClarity        ?? 5, 1, 10),
  titleEmotionalPull:  clamp(raw.titleEmotionalPull  ?? 5, 1, 10),
  keywordPresence:     clamp(raw.keywordPresence     ?? 3, 1, 5),
  descriptionQuality:  clamp(raw.descriptionQuality  ?? 3, 1, 5),
  tagRelevance:        clamp(raw.tagRelevance        ?? 3, 1, 5),
  thumbnailTitleSync:  clamp(raw.thumbnailTitleSync  ?? 5, 1, 10),
  topicDepth:          clamp(raw.topicDepth          ?? 5, 1, 10),
  indiaRelevance:      clamp(raw.indiaRelevance      ?? 5, 1, 10),
  hasStrongHook:       clamp(raw.hasStrongHook       ?? 3, 1, 5),
  hasCTA:              clamp(raw.hasCTA              ?? 3, 1, 5),
  hasChapters:         clamp(raw.hasChapters         ?? 1, 1, 5),
  // Qualitative — passthrough, no clamping
  ariaInsight:         raw.ariaInsight         ?? '',
  actionItems:         raw.actionItems         ?? [],
  improvedHook:        raw.improvedHook        ?? null,
  betterTitle:         raw.betterTitle         ?? null,
  nextVideoSuggestion: raw.nextVideoSuggestion ?? '',
  nextVideoReason:     raw.nextVideoReason     ?? '',
  benchmarkAnalysis:   raw.benchmarkAnalysis   ?? '',
  benchmarkStats:      raw.benchmarkStats      ?? [],
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Derive metrics from raw YouTube numbers (pure maths, zero AI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * log10 view velocity — same logic as scoring.service.ts discovery engine.
 * Acknowledges diminishing returns: 1K→10K is equivalent difficulty to 100K→1M.
 *
 * Calibrated to Indian YouTube:
 *   100 views   → score ~10  (micro)
 *   1K  views   → score ~20
 *   10K views   → score ~40
 *   100K views  → score ~60
 *   1M  views   → score ~80
 *   10M views   → score ~100 (cap)
 */
const computeViewVelocity = (views: number): number => {
  if (views <= 0) return 0;
  // log10(views) ranges: 2=100views, 3=1K, 4=10K, 5=100K, 6=1M, 7=10M
  const raw = Math.log10(views + 1) * 14.28; // 14.28 = 100/7 → maps log10(10M)=7 to score 100
  return Math.min(100, Math.round(raw));
};

/**
 * Duration score — different optimal ranges by content type.
 * YouTube algorithm rewards videos that hold attention, not just long ones.
 *
 * Optimal ranges for Indian YouTube:
 *   Shorts:  15–60s   → peak score
 *   Regular: 7–15 min → peak score
 *   Long:    15–25 min → good score
 *   Too long: >30 min → penalty unless it's a course/podcast
 */
const computeDurationScore = (seconds: number): number => {
  if (seconds <= 0) return 50; // unknown duration
  if (seconds <= 60)  return seconds >= 15 ? 85 : 60;  // Shorts range
  if (seconds <= 180) return 65;  // 1–3 min: too short for long-form
  if (seconds <= 420) return 75;  // 3–7 min: decent
  if (seconds <= 900) return 95;  // 7–15 min: YouTube sweet spot
  if (seconds <= 1500) return 85; // 15–25 min: good
  if (seconds <= 1800) return 75; // 25–30 min: slightly long
  return 60;                      // >30 min: penalised unless niche content
};

/**
 * Engagement vs niche benchmark.
 * Returns a multiplier: 1.0 = exactly at benchmark, 2.0 = twice the benchmark.
 */
const computeERvsBenchmark = (er: number, benchER: number): number => {
  if (benchER <= 0) return 1.0;
  return parseFloat((er / benchER).toFixed(2));
};

export const computeDerivedMetrics = (
  views: number,
  likes: number,
  comments: number,
  durationSeconds: number,
  benchER: number,
): DerivedMetrics => {
  const engagementRate = views > 0
    ? parseFloat(((likes + comments) / views * 100).toFixed(2))
    : 0;
  const likeRatio    = views > 0 ? parseFloat((likes    / views * 100).toFixed(3)) : 0;
  const commentRatio = views > 0 ? parseFloat((comments / views * 100).toFixed(3)) : 0;

  return {
    engagementRate,
    viewVelocityScore:  computeViewVelocity(views),
    likeRatio,
    commentRatio,
    durationSeconds,
    durationScore:      computeDurationScore(durationSeconds),
    benchmarkER:        benchER,
    erVsBenchmark:      computeERvsBenchmark(engagementRate, benchER),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Component score formulas
// Each formula is documented with its weights so anyone can audit it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HOOK SCORE (0–100)
 *
 * Weights:
 *   titleCuriosity      → 35% (curiosity is the #1 click driver)
 *   titleEmotionalPull  → 25% (emotion drives share intent)
 *   titleClarity        → 20% (confusion = no click)
 *   thumbnailTitleSync  → 20% (broken promise = high bounce)
 *
 * Normalisation: each signal is on 1–10 scale.
 * (signal - 1) / 9 maps 1→0, 10→1.
 * Then multiply by 100.
 */
const computeHookScore = (s: RawSignals): number => {
  const normalise10 = (v: number) => (v - 1) / 9;

  const raw =
    normalise10(s.titleCuriosity)     * 35 +
    normalise10(s.titleEmotionalPull) * 25 +
    normalise10(s.titleClarity)       * 20 +
    normalise10(s.thumbnailTitleSync) * 20;

  return Math.min(100, Math.round(raw));
};

/**
 * SEO SCORE (0–100)
 *
 * Weights:
 *   keywordPresence     → 40% (title keywords are the primary signal)
 *   descriptionQuality  → 35% (description drives YouTube search ranking)
 *   tagRelevance        → 15% (tags matter less than title/desc now)
 *   hasChapters bonus   → 10% (chapters improve watch time + search visibility)
 *
 * Normalisation:
 *   1–5 signals: (signal - 1) / 4 maps 1→0, 5→1
 */
const computeSeoScore = (s: RawSignals): number => {
  const normalise5  = (v: number) => (v - 1) / 4;

  const raw =
    normalise5(s.keywordPresence)    * 40 +
    normalise5(s.descriptionQuality) * 35 +
    normalise5(s.tagRelevance)       * 15 +
    normalise5(s.hasChapters)        * 10;

  return Math.min(100, Math.round(raw));
};

/**
 * CONTENT QUALITY SCORE (0–100)
 *
 * Weights:
 *   topicDepth          → 30% (specific > generic always)
 *   indiaRelevance      → 25% (ARIA is India-first; irrelevant content gets penalised)
 *   hasStrongHook       → 25% (hook quality inferred from title/desc text)
 *   hasCTA              → 20% (no CTA = lost subscribers/watch time)
 *
 * Normalisation:
 *   1–10 signals → (signal - 1) / 9
 *   1–5 signals  → (signal - 1) / 4
 */
const computeContentQualityScore = (s: RawSignals): number => {
  const normalise10 = (v: number) => (v - 1) / 9;
  const normalise5  = (v: number) => (v - 1) / 4;

  const raw =
    normalise10(s.topicDepth)       * 30 +
    normalise10(s.indiaRelevance)   * 25 +
    normalise5(s.hasStrongHook)     * 25 +
    normalise5(s.hasCTA)            * 20;

  return Math.min(100, Math.round(raw));
};

/**
 * ENGAGEMENT SCORE (0–100)
 * Fully deterministic — uses only YouTube data, zero AI.
 *
 * Components:
 *   viewVelocityScore  → 40% (log10 view normalisation)
 *   erVsBenchmark      → 40% (engagement vs niche benchmark)
 *   durationScore      → 20% (optimal length bonus)
 *
 * erVsBenchmark normalisation:
 *   0.5x benchmark   → score 20
 *   1.0x benchmark   → score 50
 *   1.5x benchmark   → score 70
 *   2.0x benchmark   → score 85
 *   3.0x+ benchmark  → score 100
 */
const computeEngagementScore = (
  derived: DerivedMetrics,
): number => {
  // Normalise erVsBenchmark to 0–100
  const erMultiplier = derived.erVsBenchmark;
  const erNorm = erMultiplier >= 3.0 ? 100
    : erMultiplier >= 2.0 ? 85
    : erMultiplier >= 1.5 ? 70
    : erMultiplier >= 1.0 ? 50
    : erMultiplier >= 0.5 ? 30
    : 15;

  const raw =
    derived.viewVelocityScore * 0.40 +
    erNorm                    * 0.40 +
    derived.durationScore     * 0.20;

  return Math.min(100, Math.round(raw));
};

/**
 * OVERALL SCORE (0–100)
 *
 * Weights — justified:
 *   hookScore            → 30% (hook = CTR → determines if video gets views at all)
 *   engagementScore      → 30% (engagement = YouTube algorithm signal)
 *   contentQualityScore  → 25% (quality → retention → repeat viewers)
 *   seoScore             → 15% (SEO matters but hook + quality compound faster)
 *
 * Engagement bonus: if erVsBenchmark > 2.0 add up to +5 points.
 * This rewards genuinely viral outliers without letting it dominate.
 */
const computeOverallScore = (
  components: Omit<ComponentScores, 'overallScore' | 'scoreVerdict' | 'grade'>,
  derived: DerivedMetrics,
): number => {
  const base =
    components.hookScore           * 0.30 +
    components.engagementScore     * 0.30 +
    components.contentQualityScore * 0.25 +
    components.seoScore            * 0.15;

  const viralBonus = Math.min(5, Math.max(0, (derived.erVsBenchmark - 2.0) * 5));

  return Math.min(100, Math.round(base + viralBonus));
};

/**
 * Score to verdict mapping.
 * Thresholds chosen to match Indian creator distribution.
 * ~10% of videos score 80+, ~25% score 65+, ~40% score 50+.
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
// Step 4: Assemble the final report
// ─────────────────────────────────────────────────────────────────────────────

export const computeVideoDNAReport = async (
  rawSignals: Partial<RawSignals>,
  views: number,
  likes: number,
  comments: number,
  durationSeconds: number,
  niche: string,
): Promise<VideoDNAReport> => {
  // Clamp AI signals to valid bounds
  const signals = clampSignals(rawSignals);

  // Load niche benchmark (Redis → DB → fallback)
  let benchER = 3.0;
  try {
    const bench = await getBenchmark(niche);
    benchER = bench.avgER;
  } catch (err) {
    logger.warn({ err, niche }, 'Benchmark fetch failed — using default 3.0%');
  }

  // Compute derived metrics from YouTube numbers
  const derived = computeDerivedMetrics(views, likes, comments, durationSeconds, benchER);

  // Compute component scores
  const hookScore           = computeHookScore(signals);
  const seoScore            = computeSeoScore(signals);
  const contentQualityScore = computeContentQualityScore(signals);
  const engagementScore     = computeEngagementScore(derived);

  // Compute final weighted score
  const overallScore = computeOverallScore(
    { hookScore, seoScore, contentQualityScore, engagementScore },
    derived,
  );

  const { verdict, grade } = computeVerdict(overallScore);

  // Score summary built from data, not AI
  const erComparison = derived.erVsBenchmark >= 1.0
    ? `${derived.erVsBenchmark}x above niche average` 
    : `${(1 - derived.erVsBenchmark + 1).toFixed(1)}x below niche average`;

  const scoreSummary = `Overall score of ${overallScore}/100 (${grade}). ` 
    + `Engagement rate of ${derived.engagementRate}% is ${erComparison}. ` 
    + `Hook score ${hookScore}/100, SEO ${seoScore}/100.`;

  return {
    // Computed scores
    overallScore,
    scoreVerdict: verdict,
    grade,
    scoreSummary,

    // Component breakdown
    hookScore,
    seoScore,
    contentQualityScore,
    engagementScore,

    // Legacy fields for frontend compatibility
    titleScore:    hookScore,      // hookScore subsumes titleScore
    benchmarkScore: engagementScore, // engagementScore subsumes benchmarkScore

    // Derived metrics
    engagementRate:     derived.engagementRate,
    viewVelocityScore:  derived.viewVelocityScore,
    durationScore:      derived.durationScore,
    erVsBenchmark:      derived.erVsBenchmark,

    // Qualitative (AI-generated, display only)
    hookAnalysis:        signals.ariaInsight,  // kept for legacy key compat
    improvedHook:        signals.improvedHook,
    titleAnalysis:       signals.benchmarkAnalysis,
    betterTitle:         signals.betterTitle,
    benchmarkAnalysis:   signals.benchmarkAnalysis,
    benchmarkStats:      signals.benchmarkStats,
    ariaInsight:         signals.ariaInsight,
    actionItems:         signals.actionItems,
    nextVideoSuggestion: signals.nextVideoSuggestion,
    nextVideoReason:     signals.nextVideoReason,
  };
};
