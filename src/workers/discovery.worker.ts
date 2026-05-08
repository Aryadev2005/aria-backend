// src/workers/discovery.worker.ts
// ══════════════════════════════════════════════════════════════════════════════
// Global Discovery Worker — scrapes TikTok, Pinterest, Google Trends via Apify
// Stores raw data, normalises top signals into live_trends for 3-tier RAG
// ══════════════════════════════════════════════════════════════════════════════

import { Worker, type Job } from "bullmq";
import { prisma } from "../config/database";
import { logger } from "../utils/logger";

let worker: Worker | null = null;

function getConnection() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  return { host: parsed.hostname, port: parseInt(parsed.port || "6379") };
}

// ── Global TikTok hashtags — maximum coverage, no niche filter ────────────────
const TIKTOK_HASHTAGS = [
  "fyp","foryou","foryoupage","trending","viral","explore",
  "india","indian","indiancreator","desi","bharat",
  "fashion","beauty","fitness","food","travel","comedy",
  "dance","music","art","diy","lifestyle","motivation",
  "funny","love","life","aesthetic","vlog","reels",
  "bollywood","hindisongs","desicreator","hindicomedy",
  "streetfood","cricket","wedding","skincare","makeup",
  "gym","yoga","cooking","entrepreneur","startup",
];

// ── Global Pinterest search queries ───────────────────────────────────────────
const PINTEREST_QUERIES = [
  "trending 2025","viral content","aesthetic","home decor",
  "fashion outfits","fitness motivation","food recipes",
  "travel destinations","beauty tips","diy projects",
  "india trending","bollywood style","wedding india",
  "skincare routine","minimalist","boho style","art ideas",
  "photography","interior design","healthy recipes",
];

// ── Google Trends keywords — broad topics that pull related breakouts ─────────
const GOOGLE_TRENDS_KEYWORDS = [
  "trending india","viral video","instagram reels",
  "youtube trending","tiktok trend","fashion trend",
  "fitness trend","food trend","travel india",
  "bollywood","cricket","startup india","beauty trend",
  "technology trend","education india",
];

// ── Helper ─────────────────────────────────────────────────────────────────────
function calcEngagement(views: number, likes: number, comments: number, shares: number): number {
  if (views <= 0) return 0;
  return (likes + comments + shares) / views;
}

function extractHashtags(text: string): string[] {
  return (text.match(/#[\w]+/g) || [])
    .map((h) => h.replace("#", "").toLowerCase())
    .slice(0, 20);
}

// ── Step 1: Scrape TikTok globally ────────────────────────────────────────────
async function scrapeTikTok(client: any): Promise<number> {
  let total = 0;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const BATCH = 5;
  const PER_TAG = 100;

  for (let i = 0; i < TIKTOK_HASHTAGS.length; i += BATCH) {
    const batch = TIKTOK_HASHTAGS.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(async (hashtag) => {
        try {
          const run = await client.actor("clockworks/tiktok-scraper").call({
            hashtags:            [hashtag],
            numberOfVideos:      PER_TAG,
            downloadVideos:      false,
            downloadThumbnails:  false,
            shouldDownloadCovers: false,
          });
          const dataset = await client.dataset(run.defaultDatasetId).listItems({ limit: PER_TAG });
          return dataset.items as any[];
        } catch (err: any) {
          logger.warn({ hashtag, err: err.message }, "TikTok hashtag failed");
          return [];
        }
      }),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of r.value) {
        try {
          const views    = Number(item.playCount    || 0);
          const likes    = Number(item.diggCount    || 0);
          const comments = Number(item.commentCount || 0);
          const shares   = Number(item.shareCount   || 0);
          const saves    = Number(item.saveCount || item.bookmarkCount || 0);

          await (prisma as any).discovery_tiktok_raw.upsert({
            where:  { tiktok_id: String(item.id || item.videoId || `tt_${Math.random()}`) },
            create: {
              tiktok_id:        String(item.id || item.videoId || ""),
              description:      (item.description || "").substring(0, 500),
              creator_handle:   item.authorMeta?.id || item.author || "",
              creator_name:     item.authorMeta?.name || item.authorName || "",
              creator_followers: BigInt(item.authorMeta?.fans || 0),
              views:            BigInt(views),
              likes:            BigInt(likes),
              comments:         BigInt(comments),
              shares:           BigInt(shares),
              saves:            BigInt(saves),
              engagement_rate:  calcEngagement(views, likes, comments, shares),
              sound_name:       item.musicMeta?.musicName || "",
              sound_artist:     item.musicMeta?.musicAuthor || "",
              hashtags:         extractHashtags(item.description || ""),
              video_url:        item.webVideoUrl || item.url || "",
              thumbnail_url:    item.dynamicCover || item.thumbnail || "",
              duration:         Number(item.videoMeta?.duration || 0),
              expires_at:       expiresAt,
              raw_data:         { source: "tiktok", scraped_at: new Date() },
            },
            update: {
              views:           BigInt(views),
              likes:           BigInt(likes),
              comments:        BigInt(comments),
              shares:          BigInt(shares),
              engagement_rate: calcEngagement(views, likes, comments, shares),
              scraped_at:      new Date(),
            },
          });
          total++;
        } catch { /* skip individual failures */ }
      }
    }

    // Brief pause between batches to avoid Apify rate limits
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.info({ total }, "TikTok global scrape complete");
  return total;
}

// ── Step 2: Scrape Pinterest globally ─────────────────────────────────────────
async function scrapePinterest(client: any): Promise<number> {
  let total = 0;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const BATCH = 5;
  const PER_QUERY = 100;

  for (let i = 0; i < PINTEREST_QUERIES.length; i += BATCH) {
    const batch = PINTEREST_QUERIES.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(async (query) => {
        try {
          const run = await client.actor("joshuakane/pinterest-scraper").call({
            searchQuery: query,
            maxItems:    PER_QUERY,
          });
          const dataset = await client.dataset(run.defaultDatasetId).listItems({ limit: PER_QUERY });
          return dataset.items as any[];
        } catch (err: any) {
          logger.warn({ query, err: err.message }, "Pinterest query failed");
          return [];
        }
      }),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of r.value) {
        try {
          const saves      = Number(item.saves || item.num_saves || 0);
          const clicks     = Number(item.clicks || item.num_clicks || 0);
          const impressions = Number(item.impressions || item.num_impressions || 1);
          const engagement = (saves + clicks) / Math.max(impressions, 1);

          await (prisma as any).discovery_pinterest_raw.upsert({
            where:  { pinterest_id: String(item.id || item.pinId || `pin_${Math.random()}`) },
            create: {
              pinterest_id:    String(item.id || item.pinId || ""),
              title:           (item.title || item.description || "").substring(0, 300),
              description:     (item.description || "").substring(0, 500),
              image_url:       item.image || item.imageUrl || "",
              pin_url:         item.pin_link || item.url || "",
              board_name:      item.board_name || "",
              board_owner:     item.board_owner || "",
              saves:           BigInt(saves),
              clicks:          BigInt(clicks),
              engagement_rate: engagement,
              hashtags:        extractHashtags(item.description || ""),
              pin_type:        item.pinType || "standard",
              expires_at:      expiresAt,
              raw_data:        { source: "pinterest", scraped_at: new Date() },
            },
            update: {
              saves:           BigInt(saves),
              clicks:          BigInt(clicks),
              engagement_rate: engagement,
              scraped_at:      new Date(),
            },
          });
          total++;
        } catch { /* skip individual failures */ }
      }
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.info({ total }, "Pinterest global scrape complete");
  return total;
}

// ── Step 3: Scrape Google Trends globally ─────────────────────────────────────
async function scrapeGoogleTrends(client: any): Promise<number> {
  let total = 0;
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const today     = new Date().toISOString().split("T")[0];

  try {
    const run = await client.actor("apify/google-trends-scraper").call({
      searchTerms: GOOGLE_TRENDS_KEYWORDS,
      geo:         "",         // empty = global
      timeRange:   "now 1-d", // last 24 hours
      category:    0,          // all categories
    });

    const dataset = await client.dataset(run.defaultDatasetId).listItems();

    for (const item of dataset.items) {
      try {
        const keyword       = item.keyword || item.term || "";
        const interestScore = Number(item.value || item.interest || 0);
        const isBreakout    = item.isBreakout || item.breakout || interestScore >= 90;
        const relatedQueries = (item.relatedQueries || []).map((q: any) => q.query || q).slice(0, 10);
        const relatedTopics  = (item.relatedTopics  || []).map((t: any) => t.topic  || t).slice(0, 10);

        if (!keyword) continue;

        await (prisma as any).discovery_google_trends_raw.upsert({
          where:  { keyword_geo_trend_date: { keyword, geo: "GLOBAL", trend_date: new Date(today) } },
          create: {
            keyword,
            geo:             "GLOBAL",
            interest_score:  interestScore,
            related_queries: relatedQueries,
            related_topics:  relatedTopics,
            breakout:        Boolean(isBreakout),
            trend_date:      new Date(today),
            expires_at:      expiresAt,
            raw_data:        { item, scraped_at: new Date() },
          },
          update: {
            interest_score:  interestScore,
            related_queries: relatedQueries,
            related_topics:  relatedTopics,
            breakout:        Boolean(isBreakout),
            scraped_at:      new Date(),
          },
        });
        total++;
      } catch { /* skip */ }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Google Trends scrape failed");
  }

  logger.info({ total }, "Google Trends global scrape complete");
  return total;
}

// ── Step 4: Normalise raw data into live_trends ────────────────────────────────
// Top signals from TikTok, Pinterest, Google Trends get written into live_trends
// so the existing 3-tier RAG picks them up automatically. No changes to RAG needed.
async function normaliseIntoLiveTrends(): Promise<number> {
  let upserted = 0;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  // Top TikTok videos → live_trends
  const topTikTok = await (prisma as any).discovery_tiktok_raw.findMany({
    where:   { scraped_at: { gt: new Date(Date.now() - 6 * 60 * 60 * 1000) } },
    orderBy: { engagement_rate: "desc" },
    take:    200,
  });

  for (const v of topTikTok) {
    try {
      const velocity = Math.min(95, Math.round(Number(v.engagement_rate) * 1000));
      const title    = (v.description || "").substring(0, 120) || "TikTok Trending";

      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title, source: "tiktok_global" } },
        create: {
          title,
          source:         "tiktok_global",
          velocity:       Math.max(50, velocity),
          badge:          velocity > 80 ? "HOT" : velocity > 60 ? "RISING" : "NEW",
          niche_tags:     v.hashtags?.slice(0, 5) || [],
          platform_tags:  [],
          recommendation: `${Number(v.views).toLocaleString("en-IN")} views · ${(Number(v.engagement_rate) * 100).toFixed(1)}% engagement`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
          raw_data:       { tiktok_id: v.tiktok_id, sound: v.sound_name },
        },
        update: {
          velocity:       Math.max(50, velocity),
          badge:          velocity > 80 ? "HOT" : velocity > 60 ? "RISING" : "NEW",
          recommendation: `${Number(v.views).toLocaleString("en-IN")} views · ${(Number(v.engagement_rate) * 100).toFixed(1)}% engagement`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
        },
      });
      upserted++;
    } catch { /* skip */ }
  }

  // Top Pinterest pins → live_trends
  const topPins = await (prisma as any).discovery_pinterest_raw.findMany({
    where:   { scraped_at: { gt: new Date(Date.now() - 6 * 60 * 60 * 1000) } },
    orderBy: { saves: "desc" },
    take:    100,
  });

  for (const p of topPins) {
    try {
      const saves    = Number(p.saves);
      const velocity = Math.min(90, Math.round((saves / 10000) * 80));
      const title    = (p.title || p.description || "").substring(0, 120) || "Pinterest Trending";

      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title, source: "pinterest_global" } },
        create: {
          title,
          source:         "pinterest_global",
          velocity:       Math.max(40, velocity),
          badge:          velocity > 70 ? "HOT" : velocity > 50 ? "RISING" : "NEW",
          niche_tags:     p.hashtags?.slice(0, 5) || [],
          platform_tags:  [],
          recommendation: `${saves.toLocaleString("en-IN")} saves on Pinterest`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
          raw_data:       { pinterest_id: p.pinterest_id, board: p.board_name },
        },
        update: {
          velocity:       Math.max(40, velocity),
          recommendation: `${saves.toLocaleString("en-IN")} saves on Pinterest`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
        },
      });
      upserted++;
    } catch { /* skip */ }
  }

  // Google Trends breakouts → live_trends
  const breakouts = await (prisma as any).discovery_google_trends_raw.findMany({
    where: {
      scraped_at: { gt: new Date(Date.now() - 6 * 60 * 60 * 1000) },
      OR: [{ breakout: true }, { interest_score: { gte: 70 } }],
    },
    orderBy: { interest_score: "desc" },
    take: 50,
  });

  for (const g of breakouts) {
    try {
      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title: g.keyword, source: "google_trends_global" } },
        create: {
          title:          g.keyword,
          source:         "google_trends_global",
          velocity:       Math.min(95, g.interest_score),
          badge:          g.breakout ? "HOT" : g.interest_score > 80 ? "RISING" : "NEW",
          niche_tags:     g.related_topics?.slice(0, 5) || [],
          platform_tags:  [],
          recommendation: `Google Trends score: ${g.interest_score}/100${g.breakout ? " — BREAKOUT" : ""}`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
          raw_data:       { related_queries: g.related_queries },
        },
        update: {
          velocity:       Math.min(95, g.interest_score),
          badge:          g.breakout ? "HOT" : g.interest_score > 80 ? "RISING" : "NEW",
          recommendation: `Google Trends score: ${g.interest_score}/100${g.breakout ? " — BREAKOUT" : ""}`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
        },
      });
      upserted++;
    } catch { /* skip */ }
  }

  logger.info({ upserted }, "Raw data normalised into live_trends");
  return upserted;
}

// ── Step 5: Cleanup expired raw data ─────────────────────────────────────────
async function cleanupExpired(): Promise<void> {
  await Promise.allSettled([
    (prisma as any).discovery_tiktok_raw.deleteMany({ where: { expires_at: { lt: new Date() } } }),
    (prisma as any).discovery_pinterest_raw.deleteMany({ where: { expires_at: { lt: new Date() } } }),
    (prisma as any).discovery_google_trends_raw.deleteMany({ where: { expires_at: { lt: new Date() } } }),
  ]);
}

// ── Main job processor ─────────────────────────────────────────────────────────
async function processJob(job: Job): Promise<{
  tiktok:       number;
  pinterest:    number;
  googleTrends: number;
  normalised:   number;
  diagnostics:  Record<string, string>;
}> {
  const token = (process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN)?.trim();
  if (!token) {
    logger.warn("APIFY_TOKEN not set — discovery worker skipping scrape");
    return { tiktok: 0, pinterest: 0, googleTrends: 0, normalised: 0, diagnostics: { error: "APIFY_TOKEN missing" } };
  }

  const { ApifyClient } = await import("apify-client");
  const client = new ApifyClient({ token });
  const diagnostics: Record<string, string> = {};

  logger.info({ jobId: job.id }, "Discovery worker started — global scrape");

  // All 3 scrapers run in parallel
  const [tiktokResult, pinterestResult, googleResult] = await Promise.allSettled([
    scrapeTikTok(client),
    scrapePinterest(client),
    scrapeGoogleTrends(client),
  ]);

  const tiktok    = tiktokResult.status    === "fulfilled" ? tiktokResult.value    : 0;
  const pinterest = pinterestResult.status === "fulfilled" ? pinterestResult.value : 0;
  const googleTrends = googleResult.status === "fulfilled" ? googleResult.value    : 0;

  diagnostics["tiktok"]       = tiktokResult.status    === "fulfilled" ? `ok (${tiktok})` : `failed: ${(tiktokResult as any).reason?.message}`;
  diagnostics["pinterest"]    = pinterestResult.status === "fulfilled" ? `ok (${pinterest})` : `failed: ${(pinterestResult as any).reason?.message}`;
  diagnostics["googleTrends"] = googleResult.status    === "fulfilled" ? `ok (${googleTrends})` : `failed: ${(googleResult as any).reason?.message}`;

  await job.updateProgress(70);

  // Normalise top signals into live_trends (feeds existing RAG automatically)
  const normalised = await normaliseIntoLiveTrends();
  diagnostics["normalised"] = `${normalised} signals pushed to live_trends`;

  await job.updateProgress(90);

  // Cleanup expired
  await cleanupExpired();

  await job.updateProgress(100);

  logger.info({ tiktok, pinterest, googleTrends, normalised, diagnostics }, "Discovery worker complete");

  return { tiktok, pinterest, googleTrends, normalised, diagnostics };
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────
export async function startDiscoveryWorker(): Promise<Worker | null> {
  if (process.env.DISCOVERY_WORKER_ENABLED === "false") {
    logger.info("Discovery worker disabled");
    return null;
  }

  worker = new Worker("discovery-queue", processJob, {
    connection:  getConnection(),
    concurrency: 1,
  });

  worker.on("completed", (job, result) => {
    logger.info({ jobId: job.id, ...result }, "Discovery job completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "Discovery job failed");
  });

  worker.on("error", (err) => {
    logger.error({ err: err.message }, "Discovery worker error");
  });

  logger.info("Discovery worker started");
  return worker;
}

export async function stopDiscoveryWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("Discovery worker stopped");
  }
}
