// src/services/creator_analytics.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Creator Analytics Engine
// Pulls Apify-scraped data → computes scores → runs ARIA diagnosis → persists
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import { scrapeInstagramWithApify, ApifyScrapedResult } from "./apify.service";
import { _callGroq } from "./ai/groq.service";
import {
  getBenchmark,
  getAllBenchmarks,
  FALLBACK_BENCHMARKS,
} from "./benchmarks.service";

const CACHE_TTL = 60 * 60 * 6;

// ── Score computation helpers (pure functions — use passed benchmark param) ────

function computeEngagementScore(
  er: number,
  bench: { avgER: number; topER: number },
): number {
  if (er >= bench.topER) return 95;
  if (er >= bench.avgER * 1.5) return 80;
  if (er >= bench.avgER) return 65;
  if (er >= bench.avgER * 0.5) return 45;
  return 25;
}

function computeConsistencyScore(postsPerWeek: number): number {
  if (postsPerWeek >= 5) return 95;
  if (postsPerWeek >= 3) return 80;
  if (postsPerWeek >= 2) return 65;
  if (postsPerWeek >= 1) return 45;
  if (postsPerWeek >= 0.5) return 30;
  return 15;
}

function computeGrowthScore(followers: number, engagementRate: number): number {
  let base = 0;
  if (followers >= 500000) base = 90;
  else if (followers >= 100000) base = 75;
  else if (followers >= 50000) base = 65;
  else if (followers >= 10000) base = 50;
  else if (followers >= 5000) base = 40;
  else if (followers >= 1000) base = 28;
  else base = 15;

  const erBonus = Math.min(engagementRate * 2, 15);
  return Math.min(Math.round(base + erBonus), 100);
}

function computeMonetisationScore(
  followers: number,
  er: number,
  bench: { avgER: number; topER: number; cpm: number },
  niche: string,
): number {
  let score = 0;
  if (followers >= 100000) score += 40;
  else if (followers >= 50000) score += 32;
  else if (followers >= 10000) score += 22;
  else if (followers >= 5000) score += 14;
  else if (followers >= 1000) score += 8;

  if (er >= bench.topER) score += 40;
  else if (er >= bench.avgER) score += 28;
  else if (er >= bench.avgER * 0.5) score += 16;
  else score += 6;

  const nichePremium: Record<string, number> = {
    finance: 20,
    tech: 18,
    education: 16,
    fitness: 14,
    fashion: 12,
  };
  score += nichePremium[niche] || 8;

  return Math.min(score, 100);
}

function computeHealthScore(
  engScore: number,
  consistencyScore: number,
  growthScore: number,
  monetisationScore: number,
): number {
  return Math.round(
    engScore * 0.35 +
      consistencyScore * 0.25 +
      growthScore * 0.25 +
      monetisationScore * 0.15,
  );
}

function estimateBrandDealValue(
  followers: number,
  er: number,
  bench: { avgER: number; topER: number; cpm: number },
): { min: number; max: number } {
  const erMultiplier = er >= bench.topER ? 1.8 : er >= bench.avgER ? 1.2 : 0.8;
  const base =
    followers >= 500000
      ? 80000
      : followers >= 100000
        ? 25000
        : followers >= 50000
          ? 12000
          : followers >= 10000
            ? 4000
            : followers >= 5000
              ? 1500
              : followers >= 1000
                ? 500
                : 150;

  return {
    min: Math.round((base * erMultiplier * 0.8) / 500) * 500,
    max: Math.round((base * erMultiplier * 1.4) / 500) * 500,
  };
}

/**
 * Estimates days to next follower milestone using tiered growth rates.
 *
 * Why tiered instead of flat 2%:
 *   - Under 10K:  Early accounts grow fast (algorithm discovery, niche freshness).
 *                 Observed Indian Instagram median: ~4-6% weekly for active accounts.
 *                 We use 5% as a conservative estimate.
 *
 *   - 10K–100K:   Growth normalises. Algorithm discovery slows.
 *                 Competition for feed slots increases.
 *                 Indian observed median: ~1.5-2.5% weekly.
 *                 We use 2% — same as before, but now scoped correctly.
 *
 *   - 100K–1M:    Large accounts face algorithmic saturation.
 *                 New followers come primarily from shares and viral events.
 *                 Indian observed median: ~0.5-1% weekly.
 *                 We use 0.8%.
 *
 *   - 1M+:        Mega accounts. Follower growth is driven by PR events.
 *                 Organic weekly growth is ~0.3-0.5%.
 *                 We use 0.4%.
 *
 * Note: these are MEDIAN rates for ACTIVE accounts (posting 3+x/week).
 * Inactive accounts should use 0% — but we don't penalise here since this
 * is a motivational projection, not a guarantee.
 */
function estimateDaysToNextMilestone(followers: number): {
  milestone: number;
  days: number;
  weeklyGrowthRate: number;
  weeklyGainEstimate: number;
} {
  const milestones = [1_000, 5_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000];
  const next = milestones.find(m => m > followers) ?? Math.round(followers * 2);

  // Tiered weekly growth rate — scoped by current follower count
  const weeklyGrowthRate =
    followers < 10_000    ? 0.050  // 5.0% — early growth
    : followers < 100_000 ? 0.020  // 2.0% — mid growth
    : followers < 1_000_000 ? 0.008 // 0.8% — established
    : 0.004;                        // 0.4% — mega

  const weeklyGain = Math.round(followers * weeklyGrowthRate);
  const gap        = next - followers;
  const weeks      = weeklyGain > 0 ? gap / weeklyGain : 999;
  const days       = Math.round(weeks * 7);

  return {
    milestone:         next,
    days,
    weeklyGrowthRate,
    weeklyGainEstimate: weeklyGain,
  };
}

function computeFormatBreakdown(scraped: ApifyScrapedResult) {
  const total = scraped.totalPostsAnalyzed || 1;
  const reelPct = Math.round((scraped.reelCount / total) * 100);
  const photoPct = Math.round((scraped.photoCount / total) * 100);
  const carouselPct = Math.max(0, 100 - reelPct - photoPct);

  // Determine which format carries best engagement
  const posts = scraped.posts || [];
  const reelPosts = posts.filter((p) => p.isVideo);
  const photoPosts = posts.filter((p) => !p.isVideo);
  const avgReelER = reelPosts.length
    ? reelPosts.reduce((s, p) => s + p.likesCount, 0) / reelPosts.length
    : 0;
  const avgPhotoER = photoPosts.length
    ? photoPosts.reduce((s, p) => s + p.likesCount, 0) / photoPosts.length
    : 0;
  const bestFormat = avgReelER >= avgPhotoER ? "reels" : "photos";

  return {
    reels: {
      count: scraped.reelCount,
      pct: reelPct,
      avgLikes: Math.round(avgReelER),
    },
    photos: {
      count: scraped.photoCount,
      pct: photoPct,
      avgLikes: Math.round(avgPhotoER),
    },
    carousels: { count: 0, pct: carouselPct, avgLikes: 0 },
    bestFormat,
    insight:
      bestFormat === "reels"
        ? `Your Reels drive ${reelPct}% of content but likely most of your reach. Double down.`
        : `Your photos are outperforming Reels. Lean into carousel and static posts.`,
  };
}

function computeTopPosts(scraped: ApifyScrapedResult) {
  return (scraped.posts || [])
    .sort(
      (a, b) =>
        b.likesCount +
        b.commentsCount * 3 -
        (a.likesCount + a.commentsCount * 3),
    )
    .slice(0, 6)
    .map((p) => ({
      shortCode: p.shortCode,
      type: p.type,
      likes: p.likesCount,
      comments: p.commentsCount,
      views: p.videoViewCount || 0,
      caption: p.caption?.slice(0, 80) || "",
      hashtags: p.hashtags?.slice(0, 5) || [],
      timestamp: p.timestamp,
      engagementScore: p.likesCount + p.commentsCount * 3,
      url: `https://instagram.com/p/${p.shortCode}`,
    }));
}

function computeBestPostingTimes(posts: ApifyScrapedResult["posts"]) {
  // Count posts by day and hour
  const dayCount: Record<number, number[]> = {};
  for (const p of posts) {
    const d = new Date(p.timestamp);
    const day = d.getDay(); // 0 = Sunday
    const hour = d.getHours(); // UTC — approximate
    if (!dayCount[day]) dayCount[day] = [];
    dayCount[day].push(p.likesCount);
  }

  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const scored = Object.entries(dayCount)
    .map(([day, likes]) => ({
      day: dayNames[Number(day)],
      avgLikes: Math.round(likes.reduce((s, l) => s + l, 0) / likes.length),
      postCount: likes.length,
    }))
    .sort((a, b) => b.avgLikes - a.avgLikes);

  return scored.slice(0, 3).map((d) => ({
    day: d.day,
    timeWindow: "7:00 PM – 9:00 PM IST", // default prime time; refine later with Graph API
    avgLikes: d.avgLikes,
    confidence: d.postCount >= 3 ? "high" : "medium",
  }));
}

// ── ARIA Diagnosis ────────────────────────────────────────────────────────────

async function generateARIADiagnosis(params: {
  handle: string;
  followers: number;
  er: number;
  niche: string;
  healthScore: number;
  formatBreakdown: any;
  topPosts: any[];
  topHashtags: string[];
  postsPerWeek: number;
  bestTimes: any[];
  benchmarks: { avgER: number; topER: number; cpm: number; label: string };
  monetisation: any;
}): Promise<{
  diagnosis: string;
  insights: string[];
  actionItems: string[];
  contentGaps: string[];
}> {
  const {
    handle,
    followers,
    er,
    niche,
    healthScore,
    formatBreakdown,
    topPosts,
    topHashtags,
    postsPerWeek,
    bestTimes,
    benchmarks,
    monetisation,
  } = params;

  const prompt = `You are ARIA, India's top creator intelligence engine. Analyse this Instagram account and produce a brutal, specific, actionable diagnosis. No generic advice. Everything must be specific to THIS creator's data.

ACCOUNT DATA:
- Handle: @${handle}
- Followers: ${followers.toLocaleString("en-IN")}
- Engagement Rate: ${er}%
- Niche: ${niche}
- Health Score: ${healthScore}/100
- Posts per week: ${postsPerWeek}
- Content mix: ${formatBreakdown.reels.pct}% Reels, ${formatBreakdown.photos.pct}% Photos
- Best format: ${formatBreakdown.bestFormat}
- Top hashtags: ${topHashtags.slice(0, 8).join(", ")}
- Best posting days: ${bestTimes.map((t) => t.day).join(", ")}
- Niche average ER: ${benchmarks.avgER}%
- Niche top-performer ER: ${benchmarks.topER}%
- Top post likes: ${topPosts[0]?.likes || 0}
- Brand deal value range: ₹${monetisation.brandDeal?.min?.toLocaleString("en-IN")} – ₹${monetisation.brandDeal?.max?.toLocaleString("en-IN")}

RESPOND ONLY IN THIS EXACT JSON FORMAT (no markdown, no backticks):
{
  "diagnosis": "3-4 sentence paragraph. Brutally honest, specific to this account's numbers. Mention what is actually working, what is holding them back, and the single biggest lever they have right now. Reference actual numbers from the data.",
  "insights": [
    "Insight 1 — specific to their data",
    "Insight 2 — specific",
    "Insight 3 — specific",
    "Insight 4 — specific",
    "Insight 5 — specific"
  ],
  "actionItems": [
    "Action 1 — concrete, do-it-today specific",
    "Action 2 — concrete",
    "Action 3 — concrete"
  ],
  "contentGaps": [
    "Gap 1 — what this creator is missing",
    "Gap 2",
    "Gap 3"
  ]
}`;

  try {
    const raw = await _callGroq(prompt, { maxTokens: 1200, useLlama: true });
    const clean =
      typeof raw === "string"
        ? raw.replace(/```json|```/g, "").trim()
        : JSON.stringify(raw);
    return typeof raw === "object" ? (raw as any) : JSON.parse(clean);
  } catch (err) {
    logger.warn({ err }, "ARIA diagnosis parse failed — using fallback");
    return {
      diagnosis: `@${handle} has a health score of ${healthScore}/100. Your engagement rate of ${er}% is ${er >= benchmarks.avgER ? "above" : "below"} the ${niche} niche average of ${benchmarks.avgER}%. ${formatBreakdown.bestFormat === "reels" ? "Reels are your strongest format" : "Photos are outperforming your Reels"}. Focus on consistency — posting ${postsPerWeek < 3 ? "more regularly (aim for 3–4x/week)" : "is solid, now optimise for saves"}.`,
      insights: [
        `Your ER of ${er}% vs niche average of ${benchmarks.avgER}%`,
        `${formatBreakdown.bestFormat} is your best performing content format`,
        `${postsPerWeek} posts/week — ${postsPerWeek >= 3 ? "consistent" : "needs more regularity"}`,
        `Top hashtag: #${topHashtags[0] || "not yet tracked"}`,
        `Brand deal value: ₹${monetisation.brandDeal?.min?.toLocaleString("en-IN")} – ₹${monetisation.brandDeal?.max?.toLocaleString("en-IN")}`,
      ],
      actionItems: [
        `Post a ${formatBreakdown.bestFormat === "reels" ? "Reel" : "Carousel"} on ${bestTimes[0]?.day || "Tuesday"} between 7–9 PM IST`,
        `Cut hashtags getting zero reach — audit your top 5`,
        `Add a save-worthy element (checklist, tip list) to your next post`,
      ],
      contentGaps: [
        "Behind-the-scenes content showing your process",
        "Direct-to-camera talking head content builds trust",
        "Collaboration posts to expand reach",
      ],
    };
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function buildAndSaveCreatorAnalytics(
  userId: string,
  handle: string,
  niche: string,
  forceRefresh = false,
): Promise<any> {
  const cacheKey = `creator_analytics:${userId}`;

  if (!forceRefresh) {
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
  }

  logger.info(
    { userId, handle, niche },
    "creator_analytics: starting full analysis",
  );

  // ── 1. Scrape via Apify ──────────────────────────────────────────────────────
  const scraped: ApifyScrapedResult = await scrapeInstagramWithApify(
    handle,
    50,
  );

  // ── 2. Load benchmark dynamically ────────────────────────────────────────────
  const bench = await getBenchmark(niche);

  // ── 3. Compute all scores ────────────────────────────────────────────────────
  const erFloat = parseFloat(scraped.engagementRate) || 0;

  const engScore = computeEngagementScore(erFloat, bench);
  const conScore = computeConsistencyScore(scraped.postsPerWeek);
  const growScore = computeGrowthScore(scraped.followers, erFloat);
  const monScore = computeMonetisationScore(
    scraped.followers,
    erFloat,
    bench,
    niche,
  );
  const healthScore = computeHealthScore(
    engScore,
    conScore,
    growScore,
    monScore,
  );

  // ── 4. Derived analytics ─────────────────────────────────────────────────────
  const formatBreakdown = computeFormatBreakdown(scraped);
  const topPosts = computeTopPosts(scraped);
  const bestTimes = computeBestPostingTimes(scraped.posts);
  const brandDeal = estimateBrandDealValue(scraped.followers, erFloat, bench);
  const nextMilestone = estimateDaysToNextMilestone(scraped.followers);

  const followerRange =
    scraped.followers >= 500000
      ? "500K+"
      : scraped.followers >= 100000
        ? "100K–500K"
        : scraped.followers >= 50000
          ? "50K–100K"
          : scraped.followers >= 10000
            ? "10K–50K"
            : scraped.followers >= 1000
              ? "1K–10K"
              : "Under 1K";

  const nichePercentile =
    erFloat >= bench.topER
      ? 90
      : erFloat >= bench.avgER * 1.5
        ? 75
        : erFloat >= bench.avgER
          ? 55
          : 30;

  const niche_benchmarks = {
    ...bench,
    userER: erFloat,
    percentile: nichePercentile,
    label: `You're in the top ${100 - nichePercentile}% of ${bench.label} creators at your follower tier`,
  };

  const growthProjection = {
    conservative: `${Math.round(scraped.followers * 1.08).toLocaleString("en-IN")} in 30 days`,
    optimistic: `${Math.round(scraped.followers * (1 + nextMilestone.weeklyGrowthRate * 4)).toLocaleString("en-IN")} in 30 days`,
    milestone: nextMilestone.milestone.toLocaleString("en-IN"),
    daysToMilestone: nextMilestone.days,
    weeklyGainEstimate: nextMilestone.weeklyGainEstimate.toLocaleString("en-IN"),
    growthRateUsed: `${(nextMilestone.weeklyGrowthRate * 100).toFixed(1)}% per week (active account estimate)`,
  };

  const monetisation = {
    brandDeal,
    estimatedMonthlyRevenue: {
      min: Math.round(brandDeal.min * 0.8),
      max: Math.round(brandDeal.max * 2.2),
    },
    cpm: `₹${bench.cpm}–₹${bench.cpm + 40}`,
    readinessScore: monScore,
    isReadyForBrands: scraped.followers >= 5000 && erFloat >= bench.avgER * 0.7,
    unlockAt:
      scraped.followers < 5000
        ? "5,000 followers"
        : scraped.followers < 10000
          ? "10,000 followers"
          : null,
  };

  // ── 5. Run ARIA diagnosis ────────────────────────────────────────────────────
  const ariaResult = await generateARIADiagnosis({
    handle,
    followers: scraped.followers,
    er: erFloat,
    niche,
    healthScore,
    formatBreakdown,
    topPosts,
    topHashtags: scraped.topHashtags,
    postsPerWeek: scraped.postsPerWeek,
    bestTimes,
    benchmarks: bench,
    monetisation,
  });

  // ── 6. Persist to DB ─────────────────────────────────────────────────────────
  const row = await (prisma as any).creator_analytics.upsert({
    where: { user_id_platform: { user_id: userId, platform: "instagram" } },
    create: {
      user_id: userId,
      platform: "instagram",
      handle,
      followers: scraped.followers,
      following: scraped.following,
      total_posts: scraped.totalPosts,
      avg_likes: scraped.avgLikes,
      avg_comments: scraped.avgComments,
      avg_views: scraped.avgViews,
      engagement_rate: erFloat,
      posts_per_week: scraped.postsPerWeek,
      reel_count: scraped.reelCount,
      photo_count: scraped.photoCount,
      carousel_count: 0,
      health_score: healthScore,
      engagement_score: engScore,
      consistency_score: conScore,
      growth_score: growScore,
      monetisation_score: monScore,
      top_posts: topPosts,
      top_hashtags: scraped.topHashtags,
      format_breakdown: formatBreakdown,
      best_posting_times: bestTimes,
      niche_benchmarks: niche_benchmarks,
      growth_projection: growthProjection,
      monetisation: monetisation,
      aria_diagnosis: ariaResult.diagnosis,
      aria_top_insights: ariaResult.insights,
      aria_action_items: ariaResult.actionItems,
      aria_content_gaps: ariaResult.contentGaps,
      scraped_at: new Date(),
      analysis_version: 1,
    },
    update: {
      handle,
      followers: scraped.followers,
      following: scraped.following,
      total_posts: scraped.totalPosts,
      avg_likes: scraped.avgLikes,
      avg_comments: scraped.avgComments,
      avg_views: scraped.avgViews,
      engagement_rate: erFloat,
      posts_per_week: scraped.postsPerWeek,
      reel_count: scraped.reelCount,
      photo_count: scraped.photoCount,
      health_score: healthScore,
      engagement_score: engScore,
      consistency_score: conScore,
      growth_score: growScore,
      monetisation_score: monScore,
      top_posts: topPosts,
      top_hashtags: scraped.topHashtags,
      format_breakdown: formatBreakdown,
      best_posting_times: bestTimes,
      niche_benchmarks: niche_benchmarks,
      growth_projection: growthProjection,
      monetisation: monetisation,
      aria_diagnosis: ariaResult.diagnosis,
      aria_top_insights: ariaResult.insights,
      aria_action_items: ariaResult.actionItems,
      aria_content_gaps: ariaResult.contentGaps,
      scraped_at: new Date(),
      updated_at: new Date(),
    },
  });

  // Build the response shape
  const result = {
    platform: "instagram",
    handle,
    followerRange,
    // Raw numbers
    followers: scraped.followers,
    following: scraped.following,
    totalPosts: scraped.totalPosts,
    avgLikes: scraped.avgLikes,
    avgComments: scraped.avgComments,
    avgViews: scraped.avgViews,
    engagementRate: erFloat,
    postsPerWeek: scraped.postsPerWeek,
    // Scores
    healthScore,
    engagementScore: engScore,
    consistencyScore: conScore,
    growthScore: growScore,
    monetisationScore: monScore,
    // Rich data
    topPosts,
    topHashtags: scraped.topHashtags,
    formatBreakdown,
    bestPostingTimes: bestTimes,
    nicheBenchmarks: niche_benchmarks,
    growthProjection,
    monetisation,
    // ARIA
    ariaDiagnosis: ariaResult.diagnosis,
    ariaInsights: ariaResult.insights,
    ariaActionItems: ariaResult.actionItems,
    ariaContentGaps: ariaResult.contentGaps,
    // Meta
    scrapedAt: new Date().toISOString(),
    isFromCache: false,
  };

  // Cache for 6 hours
  await cache.set(cacheKey, result, CACHE_TTL);

  logger.info(
    { userId, healthScore, er: erFloat },
    "creator_analytics: analysis complete",
  );
  return result;
}

export async function getStoredCreatorAnalytics(
  userId: string,
): Promise<any | null> {
  try {
    const row = await (prisma as any).creator_analytics.findFirst({
      where: { user_id: userId, platform: "instagram" },
    });
    if (!row) return null;

    return {
      ...row,
      followers: Number(row.followers),
      avgLikes: Number(row.avg_likes),
      avgComments: Number(row.avg_comments),
      avgViews: Number(row.avg_views),
      engagementRate: Number(row.engagement_rate),
      postsPerWeek: Number(row.posts_per_week),
      healthScore: row.health_score,
      engagementScore: row.engagement_score,
      consistencyScore: row.consistency_score,
      growthScore: row.growth_score,
      monetisationScore: row.monetisation_score,
      topPosts: row.top_posts,
      topHashtags: row.top_hashtags,
      formatBreakdown: row.format_breakdown,
      bestPostingTimes: row.best_posting_times,
      nicheBenchmarks: row.niche_benchmarks,
      growthProjection: row.growth_projection,
      monetisation: row.monetisation,
      ariaDiagnosis: row.aria_diagnosis,
      ariaInsights: row.aria_top_insights,
      ariaActionItems: row.aria_action_items,
      ariaContentGaps: row.aria_content_gaps,
      scrapedAt: row.scraped_at?.toISOString(),
      isFromCache: true,
    };
  } catch (err) {
    logger.warn({ err, userId }, "getStoredCreatorAnalytics failed");
    return null;
  }
}
