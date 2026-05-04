// src/workers/discovery.worker.ts
// ══════════════════════════════════════════════════════════════════════════════
// Unified Global Discovery Worker
//
// Scrapes all 5 sources in parallel every 3 hours:
//   1. Reddit    — /rising + /hot across 40 subreddits → discovery_reddit_raw
//   2. YouTube   — mostPopular India → live_trends directly (via youtubeTrending.service)
//   3. TikTok    — global hashtags via Apify → discovery_tiktok_raw
//   4. Pinterest — global queries via Apify → discovery_pinterest_raw
//   5. Google Trends — global keywords via Apify → discovery_google_trends_raw
//
// After scraping, normaliseIntoLiveTrends() pushes top signals from each raw
// table into live_trends, which the embedding + trajectory workers then process.
// ══════════════════════════════════════════════════════════════════════════════

import { Worker, type Job } from "bullmq";
import axios from "axios";
import { prisma } from "../config/database";
import { logger } from "../utils/logger";

let worker: Worker | null = null;

function getConnection() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  const parsed = new URL(url);
  return { host: parsed.hostname, port: parseInt(parsed.port || "6379") };
}

// ── Reddit: 40 subreddits — broad global coverage ────────────────────────────
const REDDIT_SUBREDDITS = [
  // India-specific
  "india", "AskIndia", "IndiaInvestments", "bollywood", "cricket",
  "IndiaSpeaks", "IndianFood", "delhi", "mumbai", "bangalore",
  // Creator & content
  "content_marketing", "socialmedia", "Entrepreneur", "startups",
  "marketing", "videography", "photography", "podcasting",
  // Lifestyle niches
  "malefashionadvice", "femalefashionadvice", "SkincareAddiction",
  "fitness", "bodyweightfitness", "running", "yoga",
  "food", "EatCheapAndHealthy", "MealPrepSunday",
  "travel", "solotravel", "backpacking",
  // Tech & finance
  "technology", "programming", "webdev", "datascience",
  "personalfinance", "investing", "cryptocurrency",
  // Entertainment & culture
  "movies", "Music", "books", "gaming",
  "comedy", "memes", "funny",
  // Global trending
  "worldnews", "todayilearned", "interestingasfuck",
];

// ── TikTok hashtags — global firehose ────────────────────────────────────────
const TIKTOK_HASHTAGS = [
  "fyp", "foryou", "foryoupage", "trending", "viral", "explore",
  "india", "indian", "indiancreator", "desi", "bharat",
  "fashion", "beauty", "fitness", "food", "travel", "comedy",
  "dance", "music", "art", "diy", "lifestyle", "motivation",
  "funny", "love", "life", "aesthetic", "vlog", "reels",
  "bollywood", "hindisongs", "desicreator", "hindicomedy",
  "streetfood", "cricket", "wedding", "skincare", "makeup",
  "gym", "yoga", "cooking", "entrepreneur", "startup",
];

// ── Pinterest queries — global coverage ───────────────────────────────────────
const PINTEREST_QUERIES = [
  "trending 2025", "viral content", "aesthetic", "home decor",
  "fashion outfits", "fitness motivation", "food recipes",
  "travel destinations", "beauty tips", "diy projects",
  "india trending", "bollywood style", "wedding india",
  "skincare routine", "minimalist", "boho style", "art ideas",
  "photography", "interior design", "healthy recipes",
];

// ── Google Trends keywords ────────────────────────────────────────────────────
const GOOGLE_TRENDS_KEYWORDS = [
  "trending india", "viral video", "instagram reels",
  "youtube trending", "tiktok trend", "fashion trend",
  "fitness trend", "food trend", "travel india",
  "bollywood", "cricket", "startup india", "beauty trend",
  "technology trend", "education india",
];

// ── Velocity calculator (consistent across all sources) ───────────────────────
function calcRedditVelocity(score: number, comments: number, ratio: number, ageHours: number): number {
  const recencyBoost = ageHours < 3 ? 20 : ageHours < 6 ? 15 : ageHours < 24 ? 8 : 0;
  return Math.min(95, Math.max(40, Math.round(
    ratio * 35 +
    Math.min(score, 1000) / 1000 * 30 +
    Math.min(comments, 300) / 300 * 15 +
    recencyBoost
  )));
}

function calcPinterestVelocity(saves: number): number {
  // Log-scaled so pins with 500 saves get velocity 60, 10K saves get 80
  return Math.min(90, Math.max(30, Math.round(Math.log10(saves + 1) * 30)));
}

function extractHashtags(text: string): string[] {
  return (text.match(/#[\w]+/g) || [])
    .map((h) => h.replace("#", "").toLowerCase())
    .slice(0, 20);
}

// ── Browser-like HTTP client (Reddit blocks axios default UA) ─────────────────
const HTTP = axios.create({
  timeout: 12000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
  },
});

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 1: Reddit
// ════════════════════════════════════════════════════════════════════════════

async function scrapeReddit(): Promise<number> {
  const nowSec = Date.now() / 1000;
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days
  let total = 0;

  // Process subreddits in batches of 5 to avoid rate limiting
  const BATCH_SIZE = 5;
  for (let i = 0; i < REDDIT_SUBREDDITS.length; i += BATCH_SIZE) {
    const batch = REDDIT_SUBREDDITS.slice(i, i + BATCH_SIZE);

    await Promise.allSettled(
      batch.flatMap((sub) =>
        ["rising", "hot"].map(async (feed) => {
          try {
            const { data } = await HTTP.get(
              `https://www.reddit.com/r/${sub}/${feed}.json?limit=25&raw_json=1`,
            );

            const posts: any[] = data?.data?.children ?? [];

            for (const { data: p } of posts) {
              const title = (p.title ?? "").trim();
              if (!title || title.length < 10) continue;

              const score    = p.score ?? 0;
              const comments = p.num_comments ?? 0;
              const ratio    = p.upvote_ratio ?? 0.5;
              const ageHours = (nowSec - (p.created_utc ?? 0)) / 3600;

              // Skip posts older than 72 hours
              if (ageHours > 72) continue;

              const velocity   = calcRedditVelocity(score, comments, ratio, ageHours);
              const isBreakout = score > 500 && ageHours < 6;

              try {
                await (prisma as any).discovery_reddit_raw.upsert({
                  where:  { post_id: String(p.id || p.name || `${sub}_${Date.now()}`) },
                  create: {
                    post_id:      String(p.id || p.name || ""),
                    subreddit:    sub,
                    title:        title.substring(0, 300),
                    score,
                    upvote_ratio: ratio,
                    num_comments: comments,
                    url:          p.url || p.permalink || "",
                    author:       p.author || "",
                    flair:        p.link_flair_text || "",
                    age_hours:    Math.round(ageHours * 10) / 10,
                    velocity,
                    is_breakout:  isBreakout,
                    feed,
                    expires_at:   expiresAt,
                    raw_data:     { id: p.id, subreddit_id: p.subreddit_id, score, comments },
                  },
                  update: {
                    score,
                    num_comments: comments,
                    upvote_ratio: ratio,
                    age_hours:    Math.round(ageHours * 10) / 10,
                    velocity,
                    is_breakout:  isBreakout,
                    scraped_at:   new Date(),
                  },
                });
                total++;
              } catch { /* skip individual upsert failures */ }
            }
          } catch (err: any) {
            logger.warn({ sub, feed, err: err.message }, "Reddit subreddit scrape failed");
          }
        }),
      ),
    );

    // Pause between batches to avoid Reddit rate limiting
    await new Promise((r) => setTimeout(r, 1500));
  }

  logger.info({ total }, "Reddit global scrape complete");
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 2: YouTube (via youtubeTrending.service.ts)
// ════════════════════════════════════════════════════════════════════════════

async function scrapeYouTube(): Promise<number> {
  try {
    const { fetchYouTubeTrending } = await import("../services/youtubeTrending.service");
    const trends = await fetchYouTubeTrending();

    if (!trends || trends.length === 0) {
      logger.warn("YouTube trending returned 0 results");
      return 0;
    }

    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h — YouTube trends change slower
    let upserted = 0;

    for (const trend of trends) {
      try {
        await (prisma as any).live_trends.upsert({
          where:  { title_source: { title: trend.title.substring(0, 200), source: "youtube" } },
          create: {
            title:          trend.title.substring(0, 200),
            source:         "youtube",
            search_volume:  trend.search_volume,
            velocity:       trend.velocity,
            badge:          trend.velocity >= 75 ? "HOT" : trend.velocity >= 55 ? "RISING" : "NEW",
            niche_tags:     trend.niche_tags,
            platform_tags:  ["youtube"],
            recommendation: `${Number(trend.raw_data.viewCount).toLocaleString("en-IN")} views on YouTube India · ${trend.raw_data.channelTitle}`,
            expires_at:     expiresAt,
            fetched_at:     new Date(),
            raw_data:       trend.raw_data,
          },
          update: {
            search_volume:  trend.search_volume,
            velocity:       trend.velocity,
            badge:          trend.velocity >= 75 ? "HOT" : trend.velocity >= 55 ? "RISING" : "NEW",
            niche_tags:     trend.niche_tags,
            recommendation: `${Number(trend.raw_data.viewCount).toLocaleString("en-IN")} views on YouTube India · ${trend.raw_data.channelTitle}`,
            expires_at:     expiresAt,
            fetched_at:     new Date(),
            raw_data:       trend.raw_data,
          },
        });
        upserted++;
      } catch { /* skip individual failures */ }
    }

    logger.info({ upserted, total: trends.length }, "YouTube trends upserted into live_trends");
    return upserted;
  } catch (err: any) {
    logger.warn({ err: err.message }, "YouTube scrape failed");
    return 0;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 3: TikTok (via Apify)
// ════════════════════════════════════════════════════════════════════════════

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
            hashtags:             [hashtag],
            numberOfVideos:       PER_TAG,
            downloadVideos:       false,
            downloadThumbnails:   false,
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
          const engagement = views > 0 ? (likes + comments + shares) / views : 0;

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
              saves:            BigInt(item.saveCount || item.bookmarkCount || 0),
              engagement_rate:  engagement,
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
              engagement_rate: engagement,
              scraped_at:      new Date(),
            },
          });
          total++;
        } catch { /* skip */ }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.info({ total }, "TikTok global scrape complete");
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 4: Pinterest (via Apify)
// ════════════════════════════════════════════════════════════════════════════

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
        } catch { /* skip */ }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.info({ total }, "Pinterest global scrape complete");
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 5: Google Trends (via Apify)
// ════════════════════════════════════════════════════════════════════════════

async function scrapeGoogleTrends(client: any): Promise<number> {
  let total = 0;
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const today = new Date().toISOString().split("T")[0];

  try {
    const run = await client.actor("apify/google-trends-scraper").call({
      searchTerms: GOOGLE_TRENDS_KEYWORDS,
      geo:         "",
      timeRange:   "now 1-d",
      category:    0,
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

// ════════════════════════════════════════════════════════════════════════════
// NORMALISATION: Push top signals from all raw tables into live_trends
// YouTube is already written directly to live_trends so not included here
// ════════════════════════════════════════════════════════════════════════════

async function normaliseIntoLiveTrends(): Promise<number> {
  let upserted = 0;
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12h — refreshed every 3h anyway
  const cutoff    = new Date(Date.now() - 3 * 60 * 60 * 1000);  // last 3h window

  // ── Reddit top posts → live_trends ─────────────────────────────────────────
  const topReddit = await (prisma as any).discovery_reddit_raw.findMany({
    where:   { scraped_at: { gt: cutoff }, velocity: { gte: 60 } },
    orderBy: { velocity: "desc" },
    take:    150,
  });

  for (const r of topReddit) {
    try {
      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title: r.title.substring(0, 200), source: "reddit" } },
        create: {
          title:          r.title.substring(0, 200),
          source:         "reddit",
          search_volume:  r.score,
          velocity:       r.velocity,
          badge:          r.is_breakout ? "HOT" : r.velocity >= 75 ? "HOT" : r.velocity >= 60 ? "RISING" : "NEW",
          niche_tags:     [],   // Groq will interpret at synthesis time
          platform_tags:  ["reddit"],
          recommendation: `${r.score} upvotes · ${r.num_comments} comments · r/${r.subreddit} ${r.feed}`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
          raw_data:       { post_id: r.post_id, subreddit: r.subreddit, age_hours: r.age_hours, flair: r.flair },
        },
        update: {
          search_volume:  r.score,
          velocity:       r.velocity,
          badge:          r.is_breakout ? "HOT" : r.velocity >= 75 ? "HOT" : r.velocity >= 60 ? "RISING" : "NEW",
          recommendation: `${r.score} upvotes · ${r.num_comments} comments · r/${r.subreddit} ${r.feed}`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
        },
      });
      upserted++;
    } catch { /* skip */ }
  }

  // ── TikTok top videos → live_trends ─────────────────────────────────────────
  const topTikTok = await (prisma as any).discovery_tiktok_raw.findMany({
    where:   { scraped_at: { gt: cutoff } },
    orderBy: { engagement_rate: "desc" },
    take:    200,
  });

  for (const v of topTikTok) {
    try {
      const velocity = Math.min(95, Math.max(50, Math.round(Number(v.engagement_rate) * 1000)));
      const title    = (v.description || "").substring(0, 200) || "TikTok Trending";

      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title, source: "tiktok_global" } },
        create: {
          title,
          source:         "tiktok_global",
          search_volume:  Number(v.views),
          velocity,
          badge:          velocity > 80 ? "HOT" : velocity > 60 ? "RISING" : "NEW",
          niche_tags:     v.hashtags?.slice(0, 5) || [],
          platform_tags:  ["tiktok"],
          recommendation: `${Number(v.views).toLocaleString("en-IN")} views · ${(Number(v.engagement_rate) * 100).toFixed(1)}% engagement`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
          raw_data:       { tiktok_id: v.tiktok_id, sound: v.sound_name },
        },
        update: {
          search_volume:  Number(v.views),
          velocity,
          badge:          velocity > 80 ? "HOT" : velocity > 60 ? "RISING" : "NEW",
          recommendation: `${Number(v.views).toLocaleString("en-IN")} views · ${(Number(v.engagement_rate) * 100).toFixed(1)}% engagement`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
        },
      });
      upserted++;
    } catch { /* skip */ }
  }

  // ── Pinterest top pins → live_trends ─────────────────────────────────────────
  const topPins = await (prisma as any).discovery_pinterest_raw.findMany({
    where:   { scraped_at: { gt: cutoff } },
    orderBy: { saves: "desc" },
    take:    100,
  });

  for (const p of topPins) {
    try {
      const saves    = Number(p.saves);
      const velocity = calcPinterestVelocity(saves);
      const title    = (p.title || p.description || "").substring(0, 200) || "Pinterest Trending";

      await (prisma as any).live_trends.upsert({
        where:  { title_source: { title, source: "pinterest_global" } },
        create: {
          title,
          source:         "pinterest_global",
          search_volume:  saves,
          velocity,
          badge:          velocity > 70 ? "HOT" : velocity > 50 ? "RISING" : "NEW",
          niche_tags:     p.hashtags?.slice(0, 5) || [],
          platform_tags:  ["pinterest"],
          recommendation: `${saves.toLocaleString("en-IN")} saves on Pinterest`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
          raw_data:       { pinterest_id: p.pinterest_id, board: p.board_name },
        },
        update: {
          search_volume:  saves,
          velocity,
          badge:          velocity > 70 ? "HOT" : velocity > 50 ? "RISING" : "NEW",
          recommendation: `${saves.toLocaleString("en-IN")} saves on Pinterest`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
        },
      });
      upserted++;
    } catch { /* skip */ }
  }

  // ── Google Trends breakouts → live_trends ────────────────────────────────────
  const breakouts = await (prisma as any).discovery_google_trends_raw.findMany({
    where: {
      scraped_at: { gt: cutoff },
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
          search_volume:  g.interest_score * 1000,
          velocity:       Math.min(95, g.interest_score),
          badge:          g.breakout ? "HOT" : g.interest_score > 80 ? "RISING" : "NEW",
          niche_tags:     g.related_topics?.slice(0, 5) || [],
          platform_tags:  ["google"],
          recommendation: `Google Trends score: ${g.interest_score}/100${g.breakout ? " — BREAKOUT" : ""}`,
          expires_at:     expiresAt,
          fetched_at:     new Date(),
          raw_data:       { related_queries: g.related_queries },
        },
        update: {
          search_volume:  g.interest_score * 1000,
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

  logger.info({ upserted }, "All sources normalised into live_trends");
  return upserted;
}

// ── Cleanup expired raw data ──────────────────────────────────────────────────
async function cleanupExpired(): Promise<void> {
  await Promise.allSettled([
    (prisma as any).discovery_reddit_raw.deleteMany({ where: { expires_at: { lt: new Date() } } }),
    (prisma as any).discovery_tiktok_raw.deleteMany({ where: { expires_at: { lt: new Date() } } }),
    (prisma as any).discovery_pinterest_raw.deleteMany({ where: { expires_at: { lt: new Date() } } }),
    (prisma as any).discovery_google_trends_raw.deleteMany({ where: { expires_at: { lt: new Date() } } }),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN JOB PROCESSOR
// ════════════════════════════════════════════════════════════════════════════

async function processJob(job: Job): Promise<{
  reddit:       number;
  youtube:      number;
  tiktok:       number;
  pinterest:    number;
  googleTrends: number;
  normalised:   number;
  diagnostics:  Record<string, string>;
}> {
  const token = process.env.APIFY_TOKEN?.trim();
  const diagnostics: Record<string, string> = {};

  logger.info({ jobId: job.id }, "Discovery worker started — all 5 sources");

  // ── Sources 1 & 2: Reddit and YouTube — no Apify token needed ──────────────
  const [redditResult, youtubeResult] = await Promise.allSettled([
    scrapeReddit(),
    scrapeYouTube(),
  ]);

  const reddit  = redditResult.status  === "fulfilled" ? redditResult.value  : 0;
  const youtube = youtubeResult.status === "fulfilled" ? youtubeResult.value : 0;

  diagnostics["reddit"]  = redditResult.status  === "fulfilled" ? `ok (${reddit})`  : `failed: ${(redditResult as any).reason?.message}`;
  diagnostics["youtube"] = youtubeResult.status === "fulfilled" ? `ok (${youtube})` : `failed: ${(youtubeResult as any).reason?.message}`;

  await job.updateProgress(30);

  // ── Sources 3, 4, 5: TikTok, Pinterest, Google Trends — require Apify ──────
  let tiktok = 0, pinterest = 0, googleTrends = 0;

  if (!token) {
    logger.warn("APIFY_TOKEN not set — skipping TikTok, Pinterest, Google Trends");
    diagnostics["tiktok"]       = "skipped: APIFY_TOKEN missing";
    diagnostics["pinterest"]    = "skipped: APIFY_TOKEN missing";
    diagnostics["googleTrends"] = "skipped: APIFY_TOKEN missing";
  } else {
    const { ApifyClient } = await import("apify-client");
    const client = new ApifyClient({ token });

    const [tiktokResult, pinterestResult, googleResult] = await Promise.allSettled([
      scrapeTikTok(client),
      scrapePinterest(client),
      scrapeGoogleTrends(client),
    ]);

    tiktok       = tiktokResult.status    === "fulfilled" ? tiktokResult.value    : 0;
    pinterest    = pinterestResult.status === "fulfilled" ? pinterestResult.value : 0;
    googleTrends = googleResult.status    === "fulfilled" ? googleResult.value    : 0;

    diagnostics["tiktok"]       = tiktokResult.status    === "fulfilled" ? `ok (${tiktok})`       : `failed: ${(tiktokResult as any).reason?.message}`;
    diagnostics["pinterest"]    = pinterestResult.status === "fulfilled" ? `ok (${pinterest})`    : `failed: ${(pinterestResult as any).reason?.message}`;
    diagnostics["googleTrends"] = googleResult.status    === "fulfilled" ? `ok (${googleTrends})` : `failed: ${(googleResult as any).reason?.message}`;
  }

  await job.updateProgress(70);

  // ── Normalise all raw tables into live_trends ─────────────────────────────
  const normalised = await normaliseIntoLiveTrends();
  diagnostics["normalised"] = `${normalised} signals in live_trends`;

  await job.updateProgress(90);

  // ── Cleanup expired ───────────────────────────────────────────────────────
  await cleanupExpired();

  await job.updateProgress(100);

  logger.info({ reddit, youtube, tiktok, pinterest, googleTrends, normalised, diagnostics }, "Discovery worker complete");
  return { reddit, youtube, tiktok, pinterest, googleTrends, normalised, diagnostics };
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
