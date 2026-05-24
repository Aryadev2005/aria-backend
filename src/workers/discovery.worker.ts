// src/workers/discovery.worker.ts
// ══════════════════════════════════════════════════════════════════════════════
// Discovery Worker — TWO queues, five sources
//
// Queue: discovery-slow (every 24h)
//   Reddit    → aira-scrapers (snoowrap-based)
//   TikTok    → aira-scrapers (Creative Center API)
//   Pinterest → aira-scrapers (Playwright-based)
//   NewsData  → NewsData.io free API (10 categories, multi-country)
//   Finnhub   → Finnhub free API (finance/business niche)
//
// Queue: discovery-fast (every 12h)
//   YouTube       → YouTube Data API v3 (10 global regions)
//   Google Trends → native free endpoints (20 countries, no Apify)
//   Wikipedia     → Wikimedia Analytics API (global top articles)
//
// Normalisation cutoff: 26h (covers both 12h and 24h cycles safely)
// ══════════════════════════════════════════════════════════════════════════════

import { Worker, type Job } from "bullmq";
import axios from "axios";
import { prisma } from "../config/database";
import { logger } from "../utils/logger";

// ── aira-scrapers imports — direct scraper functions ────────────────────────
import { scrapeReddit }         from "aira-scrapers/scrapers/reddit";
import { scrapeTikTokTrending } from "aira-scrapers/scrapers/tiktok";
import { scrapeSearch, scrapeTrending } from "aira-scrapers/scrapers/pinterest";
import { PinterestSession }     from "aira-scrapers/core/session";
import {
  connectDB as connectScrapersDB,
  upsertRedditPosts,
  upsertTikTokVideos,
  upsertPinterestPins,
  upsertGoogleTrends,
} from "aira-scrapers/core/db";
import {
  getSubredditsByTier,
  PINTEREST_QUERIES,
  SCRAPE_CONFIG as SCRAPER_CFG,
} from "aira-scrapers/config/index";
import type { SubredditEntry } from "aira-scrapers/types/index";
import { scrapeAllGeos, type DailyTrend, type RealtimeTrend } from '../scrapers/googleTrendsFree.service';
import { TIER_A_GEOS, ALL_GEOS } from '../config/geo.config';
import { scrapeWikipediaTrending } from '../scrapers/wikipedia.service';
import { scrapeNewsData } from '../scrapers/newsdata.service';
import { scrapeFinnhubMarketNews } from '../scrapers/finnhub.service';
import { deriveNicheTags } from '../utils/nicheTagger';

// Initialize aira-scrapers pg pool (idempotent — safe to call at module load)
connectScrapersDB();

let worker: Worker | null = null;

function getConnection() {
  const url    = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  return { host: parsed.hostname, port: parseInt(parsed.port || "6379") };
}

// ── YouTube configuration ────────────────────────────────────────────────────

const YT_TREND_CATEGORIES = [
  { id: "0",  label: "All"           },
  { id: "10", label: "Music"         },
  { id: "17", label: "Sports"        },
  { id: "20", label: "Gaming"        },
  { id: "22", label: "PeopleBlogs"   },
  { id: "23", label: "Comedy"        },
  { id: "24", label: "Entertainment" },
  { id: "25", label: "NewsPolitics"  },
  { id: "26", label: "HowtoStyle"    },
  { id: "28", label: "SciTech"       },
];

const YT_CATEGORY_MAP: Record<string, string> = {
  "10": "music",
  "17": "sports",
  "19": "travel",
  "20": "gaming",
  "22": "lifestyle",
  "23": "comedy",
  "24": "entertainment",
  "25": "news",
  "26": "education",
  "28": "tech",
};

const YT_REGIONS = ['IN', 'US', 'GB', 'BR', 'ID', 'NG', 'PH', 'AU', 'CA', 'KR'];

// ── runGoogleTrendsFree ───────────────────────────────────────────────────────

async function runGoogleTrendsFree(useTierA = true): Promise<number> {
  const geos = useTierA ? TIER_A_GEOS : ALL_GEOS;
  const { trends, realtime } = await scrapeAllGeos(geos);

  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4h TTL for fast trends
  let upserted = 0;

  // Upsert daily trends
  for (const t of trends) {
    if (!t.query) continue;
    try {
      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title: t.query.slice(0, 255), source: 'google_trends' } },
        create: {
          source:             'google_trends',
          title:              t.query.slice(0, 255),
          search_volume:      t.trafficNum,
          velocity:           Math.min(100, Math.round(Math.log10(Math.max(1, t.trafficNum)) * 12)),
          niche_tags:         deriveNicheTags(t.query + ' ' + t.relatedQueries.join(' ')),
          platform_tags:      ['google'],
          geo_tags:           [t.geo],
          badge:              t.trafficNum > 500_000 ? 'HOT' : t.trafficNum > 100_000 ? 'RISING' : 'NEW',
          content_format:     'unknown',
          platform_raw_score: t.trafficNum,
          is_override:        false,
          override_reason:    null,
          expires_at:         expiresAt,
          raw_data:           {
            trafficRaw:     t.trafficRaw,
            geo:            t.geo,
            geoName:        t.geoName,
            relatedQueries: t.relatedQueries,
            articles:       t.articles,
          },
        },
        update: {
          search_volume:      t.trafficNum,
          velocity:           Math.min(100, Math.round(Math.log10(Math.max(1, t.trafficNum)) * 12)),
          geo_tags:           [t.geo],
          platform_raw_score: t.trafficNum,
          badge:              t.trafficNum > 500_000 ? 'HOT' : t.trafficNum > 100_000 ? 'RISING' : 'NEW',
          expires_at:         expiresAt,
          fetched_at:         new Date(),
          raw_data:           {
            trafficRaw:     t.trafficRaw,
            geo:            t.geo,
            geoName:        t.geoName,
            relatedQueries: t.relatedQueries,
            articles:       t.articles,
          },
        },
      });
      upserted++;
    } catch (err: any) {
      logger.warn({ err: err.message, query: t.query }, 'google trends upsert failed');
    }
  }

  // Upsert realtime trends
  for (const rt of realtime) {
    if (!rt.title) continue;
    try {
      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title: rt.title.slice(0, 255), source: 'google_realtime' } },
        create: {
          source:             'google_realtime',
          title:              rt.title.slice(0, 255),
          search_volume:      0,
          velocity:           60,
          niche_tags:         deriveNicheTags(rt.title + ' ' + rt.entityNames.join(' ')),
          platform_tags:      ['google'],
          geo_tags:           ['US', 'GLOBAL'],
          badge:              'RISING',
          content_format:     'unknown',
          platform_raw_score: 0,
          is_override:        false,
          override_reason:    null,
          expires_at:         expiresAt,
          raw_data:           { entityNames: rt.entityNames, articles: rt.articles },
        },
        update: {
          velocity:   60,
          badge:      'RISING',
          expires_at: expiresAt,
          fetched_at: new Date(),
        },
      });
      upserted++;
    } catch { /* non-fatal */ }
  }

  return upserted;
}

// ── scrapeYouTube ─────────────────────────────────────────────────────────────
// Fetch YouTube trending via Data API v3 across 10 global regions.

async function scrapeYouTube(): Promise<number> {
  const { fetchYouTubeTrending } = await import("../services/youtubeTrending.service");
  const expiresAt = new Date(Date.now() + 26 * 60 * 60 * 1000);
  let upserted = 0;

  for (const regionCode of YT_REGIONS) {
    const trends = await fetchYouTubeTrending(regionCode);
    if (!trends || !trends.length) {
      await new Promise(r => setTimeout(r, 300));
      continue;
    }

    for (const t of trends) {
      try {
        await (prisma as any).discovery_youtube_raw.upsert({
          where:  { video_id: t.raw_data.videoId },
          create: {
            video_id:      t.raw_data.videoId,
            title:         t.title.slice(0, 300),
            channel:       t.raw_data.channelTitle || "",
            view_count:    BigInt(t.raw_data.viewCount    || 0),
            like_count:    BigInt(t.raw_data.likeCount    || 0),
            comment_count: BigInt(t.raw_data.commentCount || 0),
            category_id:   t.raw_data.categoryId  || "0",
            velocity:      t.velocity,
            niche_tags:    t.niche_tags,
            geo_tags:      [regionCode],
            thumbnail_url: t.raw_data.thumbnailUrl || null,
            published_at:  t.raw_data.publishedAt ? new Date(t.raw_data.publishedAt) : null,
            expires_at:    expiresAt,
            raw_data:      t.raw_data as any,
          },
          update: {
            view_count:    BigInt(t.raw_data.viewCount    || 0),
            like_count:    BigInt(t.raw_data.likeCount    || 0),
            comment_count: BigInt(t.raw_data.commentCount || 0),
            velocity:      t.velocity,
            niche_tags:    t.niche_tags,
            geo_tags:      [regionCode],
            scraped_at:    new Date(),
          },
        });
        upserted++;
      } catch (err: any) {
        logger.warn({ err: err.message, videoId: t.raw_data.videoId }, "YouTube raw upsert failed");
      }
    }

    await new Promise(r => setTimeout(r, 300)); // polite delay between regions
  }

  return upserted;
}

// ── Niche derivation helpers ──────────────────────────────────────────────────

const NICHE_MAP: Record<string, string[]> = {
  fashion:    ["fashion", "ootd", "style", "outfit", "clothing", "wear", "trend", "aesthetic"],
  beauty:     ["beauty", "makeup", "skincare", "glow", "cosmetic", "lipstick", "foundation"],
  fitness:    ["fitness", "workout", "gym", "yoga", "exercise", "health", "training", "muscle"],
  food:       ["food", "recipe", "cooking", "baking", "meal", "cuisine", "restaurant", "eat"],
  travel:     ["travel", "trip", "vacation", "destination", "wanderlust", "explore", "adventure"],
  tech:       ["tech", "technology", "gadget", "iphone", "coding", "programming", "ai", "software"],
  home:       ["home", "decor", "interior", "room", "diy", "furniture", "design", "house"],
  finance:    ["finance", "money", "invest", "wealth", "budget", "saving", "crypto"],
  education:  ["education", "study", "learn", "school", "college", "tips", "knowledge"],
  motivation: ["motivation", "mindset", "hustle", "success", "inspire", "goals", "quote"],
  bollywood:  ["bollywood", "hindi", "india", "desi", "indian", "movie", "film", "actor"],
  gaming:     ["gaming", "game", "esport", "stream", "playstation", "xbox", "nintendo"],
  comedy:     ["comedy", "funny", "meme", "humor", "laugh", "joke"],
  lifestyle:  ["lifestyle", "life", "daily", "routine", "vlog", "day", "morning"],
};

function derivePinterestNiches(
  hashtags: string[],
  boardName: string,
  title: string,
  description: string,
): string[] {
  const text = [...(hashtags || []), boardName || "", title || "", description || ""]
    .join(" ").toLowerCase();

  const matched = new Set<string>();
  for (const [niche, keywords] of Object.entries(NICHE_MAP)) {
    if (keywords.some(kw => text.includes(kw))) matched.add(niche);
  }

  const result = [...matched];
  return result.length > 0 ? result.slice(0, 3) : ["lifestyle", "general"];
}

function deriveTikTokNiches(hashtags: string[], description: string): string[] {
  return derivePinterestNiches(hashtags, "", "", description || "");
}

// ── normaliseIntoLiveTrends ───────────────────────────────────────────────────
// Read from all raw discovery tables and upsert qualifying records into live_trends.

async function normaliseIntoLiveTrends(): Promise<number> {
  const {
    computeRedditScore,
    computeTikTokVelocity,
    computePinterestScore,
    makeVelocityDecision,
    detectContentFormat,
  } = await import("../services/discovery/scoring.service");

  const since     = new Date(Date.now() - 26 * 60 * 60 * 1000);
  const expiresAt = new Date(Date.now() + 26 * 60 * 60 * 1000);
  let count = 0;

  async function upsertTrend(data: {
    source:             string;
    title:              string;
    search_volume:      number;
    velocity:           number;
    niche_tags:         string[];
    platform_tags:      string[];
    badge:              string | null;
    content_format:     string;
    platform_raw_score: number;
    is_override:        boolean;
    override_reason:    string | null;
    raw_data:           any;
    geo_tags?:          string[];
  }): Promise<void> {
    const key = data.title.slice(0, 255);
    await (prisma as any).live_trends.upsert({
      where:  { title_source: { title: key, source: data.source } },
      create: { ...data, title: key, expires_at: expiresAt },
      update: {
        search_volume:      data.search_volume,
        velocity:           data.velocity,
        niche_tags:         data.niche_tags,
        platform_tags:      data.platform_tags,
        badge:              data.badge,
        content_format:     data.content_format,
        platform_raw_score: data.platform_raw_score,
        is_override:        data.is_override,
        override_reason:    data.override_reason,
        raw_data:           data.raw_data,
        geo_tags:           data.geo_tags ?? [],
        expires_at:         expiresAt,
        fetched_at:         new Date(),
      },
    });
    count++;
  }

  // ── Reddit ────────────────────────────────────────────────────────────────
  try {
    const posts = await (prisma as any).discovery_reddit_raw.findMany({
      where:   { expires_at: { gt: new Date() }, scraped_at: { gt: since } },
      orderBy: { velocity: "desc" },
      take:    300,
    });
    for (const p of posts) {
      try {
        const { rawScore, isHighFriction } = computeRedditScore(p.score, p.num_comments, p.scraped_at);
        const dec = makeVelocityDecision({ source: "reddit", rawScore, isHighFriction });
        if (!dec.shouldStore) continue;
        await upsertTrend({
          source:             "reddit",
          title:              p.title,
          search_volume:      p.score,
          velocity:           dec.unifiedScore,
          niche_tags:         [(p.raw_data as any)?.niche || "general"],
          platform_tags:      ["reddit"],
          geo_tags:           ['GLOBAL'],
          badge:              p.is_breakout ? "breakout" : null,
          content_format:     "article",
          platform_raw_score: p.score,
          is_override:        dec.isOverride,
          override_reason:    dec.overrideReason,
          raw_data:           { post_id: p.post_id, subreddit: p.subreddit, ...(p.raw_data as any) },
        });
      } catch { /* skip malformed record */ }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Reddit normalisation failed");
  }

  // ── TikTok ────────────────────────────────────────────────────────────────
  try {
    const videos = await (prisma as any).discovery_tiktok_raw.findMany({
      where:   { expires_at: { gt: new Date() }, scraped_at: { gt: since } },
      orderBy: { views: "desc" },
      take:    200,
    });
    for (const v of videos) {
      try {
        const views    = Number(v.views);
        const likes    = Number(v.likes);
        const comments = Number(v.comments);
        const shares   = Number(v.shares);
        const { rawScore, isShareBreakout } = computeTikTokVelocity(views, likes, comments, shares);
        const dec = makeVelocityDecision({ source: "tiktok", rawScore, isShareBreakout });
        if (!dec.shouldStore) continue;
        await upsertTrend({
          source:             "tiktok",
          title:              v.description || v.sound_name || v.tiktok_id,
          search_volume:      views,
          velocity:           dec.unifiedScore,
          niche_tags:         deriveTikTokNiches(v.hashtags, v.description || v.sound_name || v.tiktok_id),
          platform_tags:      ["tiktok"],
          badge:              dec.isOverride ? "viral" : null,
          content_format:     "short_form",
          platform_raw_score: views,
          is_override:        dec.isOverride,
          override_reason:    dec.overrideReason,
          raw_data:           { tiktok_id: v.tiktok_id, creator_handle: v.creator_handle, hashtags: v.hashtags, source: "tiktok_cc" },
        });
      } catch { /* skip malformed record */ }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "TikTok normalisation failed");
  }

  // ── Pinterest ─────────────────────────────────────────────────────────────
  try {
    const pins = await (prisma as any).discovery_pinterest_raw.findMany({
      where:   { expires_at: { gt: new Date() }, scraped_at: { gt: since } },
      orderBy: { saves: "desc" },
      take:    200,
    });
    for (const pin of pins) {
      try {
        const saves       = Number(pin.saves);
        const clicks      = Number(pin.clicks);
        const impressions = Math.max(saves + clicks, 1);
        const { rawScore, isHighIntent } = computePinterestScore(saves, clicks, impressions);
        const dec = makeVelocityDecision({ source: "pinterest", rawScore, isHighIntent });
        if (!dec.shouldStore) continue;
        await upsertTrend({
          source:             "pinterest",
          title:              (pin.title || (pin.description || "").slice(0, 100) || `Pin ${pin.pinterest_id}`).trim(),
          search_volume:      saves,
          velocity:           dec.unifiedScore,
          niche_tags:         derivePinterestNiches(pin.hashtags, pin.board_name, pin.title, pin.description),
          platform_tags:      ["pinterest"],
          badge:              dec.isOverride ? "high_intent" : null,
          content_format:     "pin",
          platform_raw_score: saves,
          is_override:        dec.isOverride,
          override_reason:    dec.overrideReason,
          raw_data:           { pinterest_id: pin.pinterest_id, board_name: pin.board_name, hashtags: pin.hashtags },
        });
      } catch { /* skip malformed record */ }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Pinterest normalisation failed");
  }

  // ── YouTube ───────────────────────────────────────────────────────────────
  try {
    const videos = await (prisma as any).discovery_youtube_raw.findMany({
      where:   { expires_at: { gt: new Date() }, scraped_at: { gt: since } },
      orderBy: { velocity: "desc" },
      take:    300,
    });
    for (const v of videos) {
      try {
        if ((v.velocity as number) < 1) continue;
        await upsertTrend({
          source:             "youtube",
          title:              v.title,
          search_volume:      Number(v.view_count),
          velocity:           v.velocity,
          niche_tags:         v.niche_tags,
          platform_tags:      ["youtube"],
          badge:              null,
          content_format:     detectContentFormat("youtube", (v.raw_data as any)?.duration),
          platform_raw_score: Number(v.view_count),
          is_override:        false,
          override_reason:    null,
          raw_data:           v.raw_data,
        });
      } catch { /* skip malformed record */ }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "YouTube normalisation failed");
  }

  // ── Google Trends ─────────────────────────────────────────────────────────
  try {
    const trends = await (prisma as any).discovery_google_trends_raw.findMany({
      where:   { expires_at: { gt: new Date() }, scraped_at: { gt: since } },
      orderBy: { interest_score: "desc" },
      take:    100,
    });
    for (const t of trends) {
      try {
        const score = t.interest_score as number;
        if (score < 10) continue;
        await upsertTrend({
          source:             "google",
          title:              t.keyword,
          search_volume:      score * 10,
          velocity:           score,
          niche_tags:         ["general"],
          platform_tags:      ["google"],
          badge:              t.breakout ? "breakout" : null,
          content_format:     "article",
          platform_raw_score: score,
          is_override:        false,
          override_reason:    null,
          raw_data:           t.raw_data,
        });
      } catch { /* skip malformed record */ }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Google Trends normalisation failed");
  }

  return count;
}

// ── prewarmHotWindows ─────────────────────────────────────────────────────────
// Rebuild hot window cache entries for the top niche buckets.

async function prewarmHotWindows(): Promise<void> {
  const NICHES = [
    "general", "fashion", "fitness", "beauty", "food",
    "tech", "finance", "gaming", "entertainment", "travel",
  ];
  const expiresAt = new Date(Date.now() + 26 * 60 * 60 * 1000);

  for (const niche of NICHES) {
    try {
      const trends = await (prisma as any).live_trends.findMany({
        where:   { niche_tags: { has: niche }, expires_at: { gt: new Date() } },
        orderBy: { velocity: "desc" },
        take:    10,
      });
      if (!trends.length) continue;

      const cacheKey = `discovery:hot:${niche}`;
      const narrative = (trends as any[])
        .map((t) => `[${(t.source as string).toUpperCase()}] ${t.title} (vel=${t.velocity})`)
        .join("\n");

      await (prisma as any).hot_window_cache.upsert({
        where:  { cache_key: cacheKey },
        create: { cache_key: cacheKey, narrative, metadata: { niche, count: trends.length }, expires_at: expiresAt },
        update: { narrative, metadata: { niche, count: trends.length }, expires_at: expiresAt },
      });
    } catch (err: any) {
      logger.warn({ err: err.message, niche }, "Hot window prewarm failed");
    }
  }
}

// ── cleanupExpired ────────────────────────────────────────────────────────────
// Delete expired rows from all raw discovery tables and live_trends.

async function cleanupExpired(): Promise<void> {
  const now = new Date();
  await Promise.allSettled([
    (prisma as any).discovery_reddit_raw.deleteMany({ where: { expires_at: { lt: now } } }),
    (prisma as any).discovery_tiktok_raw.deleteMany({ where: { expires_at: { lt: now } } }),
    (prisma as any).discovery_pinterest_raw.deleteMany({ where: { expires_at: { lt: now } } }),
    (prisma as any).discovery_youtube_raw.deleteMany({ where: { expires_at: { lt: now } } }),
    (prisma as any).discovery_google_trends_raw.deleteMany({ where: { expires_at: { lt: now } } }),
    (prisma as any).live_trends.deleteMany({ where: { expires_at: { lt: now } } }),
    (prisma as any).hot_window_cache.deleteMany({ where: { expires_at: { lt: now } } }),
  ]);
  logger.info("Discovery cleanup complete");
}

// ── runNewsData ───────────────────────────────────────────────────────────────

async function runNewsData(): Promise<number> {
  const items = await scrapeNewsData();
  if (!items.length) return 0;
  const expiresAt = new Date(Date.now() + 26 * 60 * 60 * 1000);
  let upserted = 0;
  for (const item of items) {
    try {
      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title: item.title.slice(0, 255), source: 'newsdata' } },
        create: {
          source:             'newsdata',
          title:              item.title.slice(0, 255),
          search_volume:      0,
          velocity:           50,
          niche_tags:         item.nicheTags,
          platform_tags:      ['news', 'web'],
          geo_tags:           item.country,
          badge:              'NEW',
          content_format:     'article',
          platform_raw_score: 0,
          is_override:        false,
          override_reason:    null,
          expires_at:         expiresAt,
          raw_data:           { source: item.source, url: item.url, category: item.category, publishedAt: item.publishedAt },
        },
        update: {
          expires_at: expiresAt,
          fetched_at: new Date(),
          geo_tags:   item.country,
        },
      });
      upserted++;
    } catch { /* non-fatal */ }
  }
  return upserted;
}

// ── runFinnhub ────────────────────────────────────────────────────────────────

async function runFinnhub(): Promise<number> {
  const items = await scrapeFinnhubMarketNews();
  if (!items.length) return 0;
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  let upserted = 0;
  for (const item of items) {
    try {
      const velocity = item.sentiment != null
        ? Math.min(100, Math.round(55 + (item.sentiment * 20)))
        : 55;
      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title: item.headline.slice(0, 255), source: 'finnhub' } },
        create: {
          source:             'finnhub',
          title:              item.headline.slice(0, 255),
          search_volume:      0,
          velocity,
          niche_tags:         ['finance', 'business'],
          platform_tags:      ['news', 'finance'],
          geo_tags:           ['GLOBAL'],
          badge:              velocity >= 70 ? 'HOT' : 'RISING',
          content_format:     'article',
          platform_raw_score: item.sentiment ?? 0,
          is_override:        false,
          override_reason:    null,
          expires_at:         expiresAt,
          raw_data:           { source: item.source, url: item.url, category: item.category, sentiment: item.sentiment, summary: item.summary.slice(0, 300) },
        },
        update: {
          velocity,
          badge:      velocity >= 70 ? 'HOT' : 'RISING',
          expires_at: expiresAt,
          fetched_at: new Date(),
        },
      });
      upserted++;
    } catch { /* non-fatal */ }
  }
  return upserted;
}

// ── processSlowJob ────────────────────────────────────────────────────────────
// Runs every 24h via the discovery-slow BullMQ queue.

export async function processSlowJob(job: Job): Promise<Record<string, any>> {
  const diagnostics: Record<string, string> = {};

  logger.info({ jobId: job.id }, "discovery-slow started (Reddit + TikTok + Pinterest via aira-scrapers)");

  await job.updateProgress(5);

  // ── Reddit ──────────────────────────────────────────────────────────────────
  let reddit = 0;
  try {
    const entries = getSubredditsByTier("A").concat(getSubredditsByTier("B"));
    const { posts, ok, failed } = await scrapeReddit(entries);
    if (posts.length > 0) {
      const result = await upsertRedditPosts(posts);
      reddit = result.inserted + result.updated;
    }
    diagnostics["reddit"] = `ok (${reddit} upserted, ${ok} subs ok, ${failed} failed)`;
    logger.info({ reddit, entries: entries.length }, "Reddit scrape complete");
  } catch (err: any) {
    diagnostics["reddit"] = `failed: ${err.message}`;
    logger.warn({ err: err.message }, "Reddit scrape failed — continuing");
  }

  await job.updateProgress(25);

  // ── TikTok ──────────────────────────────────────────────────────────────────
  let tiktok = 0;
  try {
    const videos = await scrapeTikTokTrending();
    if (videos.length > 0) {
      const result = await upsertTikTokVideos(videos);
      tiktok = result.inserted + result.updated;
    }
    diagnostics["tiktok"] = `ok (${tiktok} upserted)`;
    logger.info({ tiktok }, "TikTok scrape complete");
  } catch (err: any) {
    diagnostics["tiktok"] = `failed: ${err.message}`;
    logger.warn({ err: err.message }, "TikTok scrape failed — continuing");
  }

  await job.updateProgress(45);

  // ── Pinterest ───────────────────────────────────────────────────────────────
  let pinterest = 0;
  try {
    const session = new PinterestSession();
    await session.init();

    const queries = PINTEREST_QUERIES;
    const maxPins = SCRAPER_CFG.pinterest.maxPinsPerQuery;

    for (const query of queries) {
      try {
        const pins = await scrapeSearch(session, query, maxPins);
        if (pins.length > 0) {
          const result = await upsertPinterestPins(pins);
          pinterest += result.inserted + result.updated;
        }
        await new Promise(r => setTimeout(r, SCRAPER_CFG.pinterest.delayBetweenQueries));
      } catch (err: any) {
        logger.warn({ query, err: err.message }, "Pinterest query failed — skipping");
      }
    }

    // Also scrape trending feed
    try {
      const trending = await scrapeTrending(session, 50);
      if (trending.length > 0) {
        const result = await upsertPinterestPins(trending);
        pinterest += result.inserted + result.updated;
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, "Pinterest trending feed failed — continuing");
    }

    diagnostics["pinterest"] = `ok (${pinterest} upserted)`;
    logger.info({ pinterest }, "Pinterest scrape complete");
  } catch (err: any) {
    diagnostics["pinterest"] = `failed: ${err.message}`;
    logger.warn({ err: err.message }, "Pinterest scrape failed — continuing");
  }

  await job.updateProgress(55);

  // ── NewsData.io (global multi-niche news) ────────────────────────────────
  let newsdata = 0;
  try {
    newsdata = await runNewsData();
    diagnostics['newsdata'] = `ok (${newsdata} upserted)`;
    logger.info({ newsdata }, 'NewsData scrape complete');
  } catch (err: any) {
    diagnostics['newsdata'] = `failed: ${err.message}`;
    logger.warn({ err: err.message }, 'NewsData scrape failed — continuing');
  }

  await job.updateProgress(65);

  // ── Finnhub (finance/business niche) ─────────────────────────────────────
  let finnhub = 0;
  try {
    finnhub = await runFinnhub();
    diagnostics['finnhub'] = `ok (${finnhub} upserted)`;
    logger.info({ finnhub }, 'Finnhub scrape complete');
  } catch (err: any) {
    finnhub = 0;
    diagnostics['finnhub'] = `failed: ${err.message}`;
    logger.warn({ err: err.message }, 'Finnhub scrape failed — continuing');
  }

  await job.updateProgress(75);

  const normalised = await normaliseIntoLiveTrends();
  diagnostics["normalised"] = `${normalised}`;

  await job.updateProgress(90);
  await prewarmHotWindows();
  await cleanupExpired();
  await job.updateProgress(100);

  logger.info({ reddit, tiktok, pinterest, newsdata, finnhub, normalised, diagnostics }, "discovery-slow complete");
  return { reddit, tiktok, pinterest, newsdata, finnhub, normalised, diagnostics };
}

// ── runWikipedia ──────────────────────────────────────────────────────────────

async function runWikipedia(): Promise<number> {
  const articles = await scrapeWikipediaTrending();
  if (!articles.length) return 0;

  const expiresAt = new Date(Date.now() + 26 * 60 * 60 * 1000);
  let upserted = 0;

  for (const a of articles) {
    try {
      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title: a.title.slice(0, 255), source: 'wikipedia' } },
        create: {
          source:             'wikipedia',
          title:              a.title.slice(0, 255),
          search_volume:      a.views,
          velocity:           Math.max(10, Math.min(100, Math.round((51 - a.rank) * 2))),
          niche_tags:         deriveNicheTags(a.title),
          platform_tags:      ['wikipedia', 'web'],
          geo_tags:           ['GLOBAL'],
          badge:              a.rank <= 10 ? 'HOT' : a.rank <= 25 ? 'RISING' : 'NEW',
          content_format:     'unknown',
          platform_raw_score: a.views,
          is_override:        false,
          override_reason:    null,
          expires_at:         expiresAt,
          raw_data:           { rank: a.rank, views: a.views },
        },
        update: {
          search_volume:      a.views,
          velocity:           Math.max(10, Math.min(100, Math.round((51 - a.rank) * 2))),
          badge:              a.rank <= 10 ? 'HOT' : a.rank <= 25 ? 'RISING' : 'NEW',
          platform_raw_score: a.views,
          expires_at:         expiresAt,
          fetched_at:         new Date(),
        },
      });
      upserted++;
    } catch (err: any) {
      logger.warn({ err: err.message, title: a.title }, 'wikipedia upsert failed');
    }
  }

  return upserted;
}

// ── processFastJob ────────────────────────────────────────────────────────────
// Runs every 12h via the discovery-queue BullMQ queue.

async function processFastJob(job: Job): Promise<Record<string, any>> {
  const diagnostics: Record<string, string> = {};

  logger.info({ jobId: job.id }, "discovery-fast started (YouTube + Google Trends)");
  await job.updateProgress(5);

  // ── YouTube ──────────────────────────────────────────────────────────────────
  let youtube = 0;
  try {
    youtube = await scrapeYouTube();
    diagnostics["youtube"] = `ok (${youtube} upserted)`;
    logger.info({ youtube }, "YouTube scrape complete");
  } catch (err: any) {
    diagnostics["youtube"] = `failed: ${err.message}`;
    logger.warn({ err: err.message }, "YouTube scrape failed — continuing");
  }

  await job.updateProgress(30);

  // ── Google Trends (native, free, multi-country) ─────────────────────────
  let googleTrends = 0;
  try {
    googleTrends = await runGoogleTrendsFree(true); // Tier A geos every fast cycle
    diagnostics['googleTrends'] = `ok (${googleTrends} upserted, ${TIER_A_GEOS.length} geos)`;
    logger.info({ googleTrends }, 'Google Trends free scrape complete');
  } catch (err: any) {
    diagnostics['googleTrends'] = `failed: ${err.message}`;
    logger.warn({ err: err.message }, 'Google Trends free scrape failed — continuing');
  }

  await job.updateProgress(55);

  // ── Wikipedia global trending ─────────────────────────────────────────────
  let wikipedia = 0;
  try {
    wikipedia = await runWikipedia();
    diagnostics['wikipedia'] = `ok (${wikipedia} upserted)`;
    logger.info({ wikipedia }, 'Wikipedia scrape complete');
  } catch (err: any) {
    diagnostics['wikipedia'] = `failed: ${err.message}`;
    logger.warn({ err: err.message }, 'Wikipedia scrape failed — continuing');
  }

  await job.updateProgress(65);

  const normalised = await normaliseIntoLiveTrends();
  diagnostics["normalised"] = `${normalised}`;

  await job.updateProgress(80);
  await prewarmHotWindows();
  await cleanupExpired();
  await job.updateProgress(100);

  logger.info({ youtube, googleTrends, wikipedia, normalised, diagnostics }, "discovery-fast complete");
  return { youtube, googleTrends, wikipedia, normalised, diagnostics };
}

// ── processRealtimeJob ────────────────────────────────────────────────────────

async function processRealtimeJob(job: Job): Promise<Record<string, any>> {
  const diagnostics: Record<string, string> = {};

  logger.info({ jobId: job.id }, 'discovery-realtime started (Google realtime trends only)');
  await job.updateProgress(10);

  let realtimeTrends = 0;
  try {
    const { scrapeRealtimeTrends } = await import('../scrapers/googleTrendsFree.service');
    const stories = await scrapeRealtimeTrends();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h TTL — realtime data is very fresh

    for (const rt of stories) {
      if (!rt.title) continue;
      try {
        await (prisma as any).live_trends.upsert({
          where:  { title_source: { title: rt.title.slice(0, 255), source: 'google_realtime' } },
          create: {
            source:             'google_realtime',
            title:              rt.title.slice(0, 255),
            search_volume:      0,
            velocity:           65,
            niche_tags:         deriveNicheTags(rt.title + ' ' + rt.entityNames.join(' ')),
            platform_tags:      ['google'],
            geo_tags:           ['US', 'GLOBAL'],
            badge:              'RISING',
            content_format:     'unknown',
            platform_raw_score: 0,
            is_override:        false,
            override_reason:    null,
            expires_at:         expiresAt,
            raw_data:           { entityNames: rt.entityNames, articles: rt.articles },
          },
          update: {
            velocity:   65,
            badge:      'RISING',
            expires_at: expiresAt,
            fetched_at: new Date(),
          },
        });
        realtimeTrends++;
      } catch { /* non-fatal */ }
    }

    diagnostics['realtimeTrends'] = `ok (${realtimeTrends} upserted)`;
    logger.info({ realtimeTrends }, 'Google realtime trends upserted');
  } catch (err: any) {
    diagnostics['realtimeTrends'] = `failed: ${err.message}`;
    logger.warn({ err: err.message }, 'discovery-realtime failed — continuing');
  }

  await job.updateProgress(100);
  logger.info({ realtimeTrends, diagnostics }, 'discovery-realtime complete');
  return { realtimeTrends, diagnostics };
}

// ── processJob (dispatcher) ───────────────────────────────────────────────────

async function processJob(job: Job): Promise<Record<string, any>> {
  switch (job.name) {
    case "discovery-fast":     return processFastJob(job);
    case "discovery-slow":     return processSlowJob(job);
    case "discovery-realtime": return processRealtimeJob(job);
    default: {
      logger.warn({ jobName: job.name }, "Unknown discovery job name — skipping");
      return { error: `Unknown job: ${job.name}` };
    }
  }
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

export async function startDiscoveryWorker(): Promise<Worker | null> {
  const enabled = process.env.DISCOVERY_WORKER_ENABLED !== "false";
  if (!enabled) {
    logger.info("Discovery worker disabled via DISCOVERY_WORKER_ENABLED=false");
    return null;
  }

  worker = new Worker("discovery-queue", processJob, {
    connection:      getConnection(),
    concurrency:     1,
    lockDuration:    600_000,    // 10 min — fast job spans multiple API calls
    stalledInterval: 60_000,
    maxStalledCount: 2,
  });

  worker.on("completed", (job, result) => {
    logger.info({ jobId: job.id, jobName: job.name, ...result }, "Discovery fast job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, jobName: job?.name, err: err.message }, "Discovery fast job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err: err.message }, "Discovery worker error");
  });

  logger.info("Discovery worker (fast queue) started");
  return worker;
}

export async function stopDiscoveryWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("Discovery worker stopped");
  }
}
