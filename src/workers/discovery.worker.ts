// src/workers/discovery.worker.ts
// ══════════════════════════════════════════════════════════════════════════════
// Discovery Worker — TWO queues, five sources + Instagram
//
// Queue: discovery-slow (every 24h)
//   Reddit    → aira-scrapers (snoowrap-based)
//   TikTok    → aira-scrapers (Creative Center API)
//   Pinterest → aira-scrapers (Playwright-based)
//   Instagram → Apify apify/instagram-hashtag-scraper (KEPT FOR NOW)
//
// Queue: discovery-fast (every 12h)
//   YouTube       → YouTube Data API v3
//   Google Trends → Apify apify/google-trends-scraper
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

// ── Google Trends keywords ───────────────────────────────────────────────────
const GOOGLE_TRENDS_KEYWORDS = [
  "reels ideas india",
  "viral instagram india",
  "content creator india 2025",
  "trending audio instagram india",
  "youtube shorts ideas india",
  "bollywood trending",
  "cricket trending india",
  "startup india trend",
  "trending sounds instagram",
  "viral content ideas",
  "youtube shorts trending",
  "instagram reel ideas 2025",
  "content creation tips",
  "how to go viral",
  "trending hashtags 2025",
];

// ── Instagram hashtags ───────────────────────────────────────────────────────
const INSTAGRAM_HASHTAGS = [
  "contentcreator",
  "grwm",
  "ootd",
  "skincareroutine",
  "reelsinstagram",
  "indiancreator",
  "reelsindia",
  "bollywoodreels",
  "indianfashionblogger",
  "desifood",
];

// ── scrapeYouTube ─────────────────────────────────────────────────────────────
// Fetch YouTube trending via Data API v3 and upsert into discovery_youtube_raw.

async function scrapeYouTube(): Promise<number> {
  const { fetchYouTubeTrending } = await import("../services/youtubeTrending.service");
  const trends = await fetchYouTubeTrending();
  if (!trends || !trends.length) return 0;

  const expiresAt = new Date(Date.now() + 26 * 60 * 60 * 1000);
  let upserted = 0;

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
          scraped_at:    new Date(),
        },
      });
      upserted++;
    } catch (err: any) {
      logger.warn({ err: err.message, videoId: t.raw_data.videoId }, "YouTube raw upsert failed");
    }
  }

  return upserted;
}

// ── scrapeInstagram ───────────────────────────────────────────────────────────
// Apify apify/instagram-hashtag-scraper — kept until native replacement is built.

async function scrapeInstagram(client: any): Promise<number> {
  const run = await client.actor("apify/instagram-hashtag-scraper").call({
    hashtags:     INSTAGRAM_HASHTAGS,
    resultsLimit: 20,
    proxy:        { useApifyProxy: true },
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  if (!items?.length) return 0;

  const expiresAt = new Date(Date.now() + 26 * 60 * 60 * 1000);
  let upserted = 0;

  for (const item of items) {
    try {
      const raw   = (item.caption || item.hashtag || "") as string;
      const title = raw.slice(0, 255).trim();
      if (!title) continue;

      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title, source: "instagram" } },
        create: {
          source:             "instagram",
          title,
          search_volume:      item.likesCount  || 0,
          velocity:           Math.min(100, Math.round((item.likesCount || 0) / 1000)),
          niche_tags:         ["lifestyle"],
          platform_tags:      ["instagram"],
          content_format:     item.type === "Video" ? "short_form" : "post",
          platform_raw_score: item.likesCount  || 0,
          expires_at:         expiresAt,
          raw_data:           {
            source_hashtag: item.hashtag,
            likes:          item.likesCount,
            comments:       item.commentsCount,
            id:             item.id,
          },
        },
        update: {
          search_volume:      item.likesCount  || 0,
          velocity:           Math.min(100, Math.round((item.likesCount || 0) / 1000)),
          platform_raw_score: item.likesCount  || 0,
          expires_at:         expiresAt,
          fetched_at:         new Date(),
        },
      });
      upserted++;
    } catch (err: any) {
      logger.warn({ err: err.message }, "Instagram live_trends upsert failed");
    }
  }

  return upserted;
}

// ── scrapeGoogleTrends ────────────────────────────────────────────────────────
// Apify apify/google-trends-scraper — part of the fast (12h) job.

async function scrapeGoogleTrends(client: any): Promise<number> {
  const run = await client.actor("apify/google-trends-scraper").call({
    searchTerms: GOOGLE_TRENDS_KEYWORDS,
    geo:         "IN",
    timeRange:   "now 1-d",
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  if (!items?.length) return 0;

  const trendDate = new Date().toISOString().slice(0, 10);

  const results = (items as any[])
    .map((item) => {
      const keyword = ((item.keyword || item.query || "") as string).trim();
      if (!keyword) return null;
      const interestScore = Number(item.interestScore ?? item.value ?? item.averageInterest ?? 0);
      return {
        keyword,
        geo:            "IN",
        interestScore,
        relatedQueries: item.relatedQueries || [],
        relatedTopics:  item.relatedTopics  || [],
        breakout:       interestScore >= 90,
        trendDate,
        peakScore:      interestScore,
        timelineData:   item.timelineData   || [],
      };
    })
    .filter(Boolean);

  if (!results.length) return 0;

  const res = await upsertGoogleTrends(results as any);
  return res.inserted + res.updated;
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
          niche_tags:         ["general"],
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
          title:              pin.title || pin.description || pin.pinterest_id,
          search_volume:      saves,
          velocity:           dec.unifiedScore,
          niche_tags:         ["lifestyle"],
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

  await job.updateProgress(65);

  // ── Instagram (still via Apify — no replacement yet) ───────────────────────
  let instagram = 0;
  const apifyToken = (process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || "").trim();
  if (apifyToken) {
    try {
      const { ApifyClient } = await import("apify-client");
      const client = new ApifyClient({ token: apifyToken });
      instagram = await scrapeInstagram(client);
      diagnostics["instagram"] = `ok (${instagram})`;
    } catch (err: any) {
      diagnostics["instagram"] = `failed: ${err.message}`;
      logger.warn({ err: err.message }, "Instagram Apify scrape failed — continuing");
    }
  } else {
    diagnostics["instagram"] = "skipped (APIFY_TOKEN not set)";
    logger.info("Instagram scrape skipped — no Apify token");
  }

  await job.updateProgress(70);

  const normalised = await normaliseIntoLiveTrends();
  diagnostics["normalised"] = `${normalised}`;

  await job.updateProgress(85);
  await prewarmHotWindows();
  await cleanupExpired();
  await job.updateProgress(100);

  logger.info({ reddit, tiktok, pinterest, instagram, normalised, diagnostics }, "discovery-slow complete");
  return { reddit, tiktok, pinterest, instagram, normalised, diagnostics };
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

  await job.updateProgress(35);

  // ── Google Trends (Apify) ─────────────────────────────────────────────────────
  let googleTrends = 0;
  const apifyToken = (process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || "").trim();
  if (apifyToken) {
    try {
      const { ApifyClient } = await import("apify-client");
      const client = new ApifyClient({ token: apifyToken });
      googleTrends = await scrapeGoogleTrends(client);
      diagnostics["googleTrends"] = `ok (${googleTrends} upserted)`;
      logger.info({ googleTrends }, "Google Trends scrape complete");
    } catch (err: any) {
      diagnostics["googleTrends"] = `failed: ${err.message}`;
      logger.warn({ err: err.message }, "Google Trends scrape failed — continuing");
    }
  } else {
    diagnostics["googleTrends"] = "skipped (APIFY_TOKEN not set)";
    logger.info("Google Trends scrape skipped — no Apify token");
  }

  await job.updateProgress(65);

  const normalised = await normaliseIntoLiveTrends();
  diagnostics["normalised"] = `${normalised}`;

  await job.updateProgress(80);
  await prewarmHotWindows();
  await cleanupExpired();
  await job.updateProgress(100);

  logger.info({ youtube, googleTrends, normalised, diagnostics }, "discovery-fast complete");
  return { youtube, googleTrends, normalised, diagnostics };
}

// ── processJob (dispatcher) ───────────────────────────────────────────────────

async function processJob(job: Job): Promise<Record<string, any>> {
  switch (job.name) {
    case "discovery-fast": return processFastJob(job);
    case "discovery-slow": return processSlowJob(job);
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
