// src/workers/discovery.worker.ts
// ══════════════════════════════════════════════════════════════════════════════
// Discovery Worker — TWO queues, five sources + Instagram
//
// Queue: discovery-slow (every 24h)
//   Reddit    → Apify fatihtahta/reddit-scraper-search-fast
//                → discovery_reddit_raw  → live_trends
//   TikTok    → Apify clockworks/tiktok-scraper
//                → discovery_tiktok_raw  → live_trends
//   Pinterest → Apify fatihtahta/pinterest-scraper-search
//                → discovery_pinterest_raw → live_trends
//   Instagram → Apify apify/instagram-hashtag-scraper
//                → discovery_tiktok_raw  → live_trends (shared table, source tagged)
//
// Queue: discovery-fast (every 12h)
//   YouTube       → YouTube Data API v3
//                   → discovery_youtube_raw → live_trends
//   Google Trends → Apify apify/google-trends-scraper
//                   → discovery_google_trends_raw → live_trends
//
// Normalisation cutoff: 26h (covers both 12h and 24h cycles safely)
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

// ════════════════════════════════════════════════════════════════════════════
// SCRAPE CONSTANTS — Tuned for Apify Starter ($49/month)
//
// Budget breakdown (monthly at stated frequencies):
//   Reddit     25 subs  × 15 posts  × 30 runs  =  11,250 results = $16.76
//   TikTok     20 tags  × 10 videos × 15 runs  =   3,000 results = $11.10
//   Pinterest  10 query × 20 pins   × 15 runs  =   3,000 results = $11.97
//   Instagram  15 tags  × 18 reels  × 15 runs  =   4,050 results = $10.94
//   Google     15 kw    × 60 runs              =     900 results =  $2.70
//   Total                                                         ~$53.47
//
// Signal split strategy:
//   Reddit     — 60% India intent + 40% global niche communities
//   TikTok     — 50% India-specific + 50% global trend early-warning
//   Pinterest  — 30% India-specific + 70% global aesthetic trends
//   Instagram  — 30% India-specific + 70% global creator trends
//   Google     — 50% India + 50% global creator demand signals
// ════════════════════════════════════════════════════════════════════════════

const REDDIT_PER_SUB = 8; // top 8 posts per subreddit — prioritizes freshness and relevance to trends over volume
const TIKTOK_PER_TAG = 5; // top 5 videos per hashtag — TikTok trends can be very volatile, so we focus on the cream of the crop
const PINTEREST_PER_QUERY = 8; // top 8 pins per query — Pinterest engagement is more stable, but we still want to focus on the most relevant content
const INSTAGRAM_PER_TAG = 8; // top 8 reels per hashtag — Instagram's algorithm favors recency and engagement, so we want to capture the most impactful content

// ── Reddit — 25 subreddits (60% India core + 40% global niche) ───────────────
const REDDIT_SUBREDDITS = [
  // India core — intent signals (15)
  //"india",
  "AskIndia",
  "BuyItForLife",
  //"IndianFood",
  //"IndiaInvestments",
  //"delhi",
  //"mumbai",
  //"bangalore",
  "bollywood",
  //"cricket",
  "Entrepreneur",
  //"startups",
  "NoStupidQuestions",
  "ExplainLikeImFive (ELI5)",
  //"socialmedia",
  "SkincareAddiction",
  //"IndianGaming",
  // Global niche communities — creators everywhere consume these (10)
  "marketing",
  //"content_marketing",
  "fitness",
  "food",
  //"travel",
  "technology",
  "gaming",
  "Music",
  "fashion",
  //"Frugal",
];

// ── TikTok — 20 hashtags (50% India + 50% global trend signals) ──────────────
// REMOVED: fyp, foryou, foryoupage, trending, viral, explore, reels, life,
//          love, aesthetic, vlog, art, diy, motivation, funny, music, dance
//          (all same traffic pool — FYP algorithm surface)
const TIKTOK_HASHTAGS = [
  // India-specific (10) — niche-separated, zero overlap
  //"indiancreator",
  //"desicreator",
  //"bollywood",
  //"indianfashion",
  //"indianfood",
  //"streetfoodindia",
  //"indiantraveller",
  //"indianfitness",
  //"ipl2025",
  "startupindia",
  // Global trend early-warning (10) — what hits India 60-90 days later
  "koreanbeauty",
  "grwm",
  //"thatgirl",
  "cleangirl",
  "quietluxury",
  "fitcheck",
  "studywithme",
  "smallbusiness",
  "sidehustle",
  "contentcreator",
];

// ── Pinterest — 10 queries (70% global aesthetic + 30% India-specific) ────────
const PINTEREST_QUERIES = [
  // Global aesthetic trends (7) — these hit India 3-6 months later
  // "quiet luxury aesthetic 2025",
  // "clean girl aesthetic outfit",
  // "korean skincare routine steps",
  // "coastal grandmother style",
  // "that girl morning routine",
  // "minimalist home office setup",
  // "y2k fashion aesthetic",
  // India-specific (3) — high intent, niche-separated
  // "indian wedding guest outfit 2025",
  // "bollywood makeup look",
  // "mehndi design 2025",
  "clean girl aesthetic outfit",
  "korean skincare routine steps",
  "that girl morning routine",
  "quiet luxury aesthetic 2025",
  "indian wedding guest outfit 2025",
  "bollywood makeup look",
];

// ── Instagram hashtags — 15 tags (70% global + 30% India) ─────────────────────
const INSTAGRAM_HASHTAGS = [
  // // Global creator trends (10)
  // "contentcreator",
  // "reelsinstagram",
  // "grwm",
  // "dayinmylife",
  // "thatgirl",
  // "cleangirl",
  // "ootd",
  // "skincareroutine",
  // "gymtok",
  // "smallbusiness",
  // // India-specific (5)
  // "indiancreator",
  // "reelsindia",
  // "bollywoodreels",
  // "indianfashionblogger",
  // "desifood",
   "contentcreator", "grwm", "ootd",
  "skincareroutine", "reelsinstagram",
  "indiancreator", "reelsindia",
  "bollywoodreels", "indianfashionblogger", "desifood",
];

// ── Google Trends — 15 keywords (50% India + 50% global creator signals) ─────
const GOOGLE_TRENDS_KEYWORDS = [
  // India-specific (8)
  "reels ideas india",
  "viral instagram india",
  "content creator india 2025",
  "trending audio instagram india",
  "youtube shorts ideas india",
  "bollywood trending",
  "cricket trending india",
  "startup india trend",
  // Global creator demand signals (7)
  "trending sounds instagram",
  "viral content ideas",
  "youtube shorts trending",
  "instagram reel ideas 2025",
  "content creation tips",
  "how to go viral",
  "trending hashtags 2025",
];

// ── YouTube category IDs for India — each call returns up to 50 videos ────────
const YT_TREND_CATEGORIES = [
  { id: "0", label: "All" },
  { id: "10", label: "Music" },
  { id: "17", label: "Sports" },
  { id: "20", label: "Gaming" },
  { id: "22", label: "PeopleBlogs" },
  { id: "23", label: "Comedy" },
  { id: "24", label: "Entertainment" },
  { id: "25", label: "NewsPolitics" },
  { id: "26", label: "HowtoStyle" },
  { id: "28", label: "SciTech" },
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

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function calcRedditVelocity(
  score: number,
  comments: number,
  ratio: number,
  ageHours: number,
): number {
  const recencyBoost =
    ageHours < 3 ? 20 : ageHours < 6 ? 15 : ageHours < 24 ? 8 : 0;
  return Math.min(
    95,
    Math.max(
      40,
      Math.round(
        ratio * 35 +
          (Math.min(score, 1000) / 1000) * 30 +
          (Math.min(comments, 300) / 300) * 15 +
          recencyBoost,
      ),
    ),
  );
}

function calcPinterestVelocity(saves: number): number {
  return Math.min(90, Math.max(30, Math.round(Math.log10(saves + 1) * 30)));
}

function calcYouTubeVelocity(
  views: number,
  likes: number,
  comments: number,
): number {
  if (views === 0) return 50;
  const viewScore = Math.min(50, Math.log10(views + 1) * 10);
  const engagementRate = ((likes + comments) / views) * 100;
  const engScore = Math.min(50, engagementRate * 10);
  return Math.round(viewScore + engScore);
}

function extractHashtags(text: string): string[] {
  return (text.match(/#[\w]+/g) || [])
    .map((h) => h.replace("#", "").toLowerCase())
    .slice(0, 20);
}

function toPinterestSearchUrl(query: string): string {
  return `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
}

function detectNichesFromTitle(title: string, categoryId = "0"): string[] {
  const t = title.toLowerCase();
  const niches: string[] = [];
  if (/fashion|outfit|ootd|style|makeup|beauty/.test(t)) niches.push("fashion");
  if (/fitness|gym|workout|yoga|diet/.test(t)) niches.push("fitness");
  if (/food|recipe|cooking|restaurant|biryani/.test(t)) niches.push("food");
  if (/cricket|ipl|virat|rohit|match/.test(t)) niches.push("sports");
  if (/bollywood|movie|actor|film|song|trailer/.test(t))
    niches.push("entertainment");
  if (/tech|smartphone|review|unboxing|ai|gadget/.test(t)) niches.push("tech");
  if (/travel|vlog|trip|tour|destination/.test(t)) niches.push("travel");
  if (/comedy|funny|meme|roast|prank/.test(t)) niches.push("comedy");
  if (/study|exam|upsc|jee|learn|tutorial/.test(t)) niches.push("education");
  if (/startup|business|entrepreneur|money/.test(t)) niches.push("startup");
  const fromCat = YT_CATEGORY_MAP[categoryId];
  if (fromCat) niches.push(fromCat);
  return niches.length > 0 ? [...new Set(niches)] : ["general"];
}

// Apify quota guard — returns false if > 98% of monthly compute used
async function checkApifyQuota(client: any): Promise<boolean> {
  try {
    const user = await client.user().get();
    const used = user?.monthlyUsage?.actorComputeUnits || 0;
    const limit = user?.plan?.monthlyActorComputeUnits || 0;
    if (limit > 0 && used >= limit * 0.98) {
      logger.warn({ used, limit }, "Apify monthly quota exhausted");
      return false;
    }
    return true;
  } catch {
    return true; // if the check itself fails, proceed
  }
}

function getApifyToken(): string | null {
  return (
    (process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || "").trim() ||
    null
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 1 — Reddit via Apify (fatihtahta/reddit-scraper-search-fast)
// ════════════════════════════════════════════════════════════════════════════

async function scrapeReddit(client: any): Promise<number> {
  const nowSec = Date.now() / 1000;
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days
  let total = 0;

  const BATCH = 5;

  for (let i = 0; i < REDDIT_SUBREDDITS.length; i += BATCH) {
    const batch = REDDIT_SUBREDDITS.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(async (subreddit) => {
        try {
          const run = await client
  .actor("fatihtahta/reddit-scraper-search-fast")
  .call({
    subredditName: subreddit,   // ✅ was: subreddits: [subreddit]
    sort: "hot",
    maxPostCount: REDDIT_PER_SUB, // ✅ was: maxItems
    // remove: skipComments, time — not supported
  });
          const dataset = await client
            .dataset(run.defaultDatasetId)
            .listItems({ limit: REDDIT_PER_SUB });
          return { subreddit, items: dataset.items as any[] };
        } catch (err: any) {
          logger.warn(
            { subreddit, err: err.message },
            "Reddit subreddit Apify run failed",
          );
          return { subreddit, items: [] };
        }
      }),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { subreddit, items } = r.value;

      for (const item of items) {
        try {
          const title = (item.title || "").trim();
          if (!title || title.length < 10) continue;

          const score = Number(item.score || item.ups || 0);
          const comments = Number(item.numComments || item.num_comments || 0);
          const ratio = Number(item.upvoteRatio || item.upvote_ratio || 0.5);
          const created = Number(item.createdAt || item.created_utc || 0);
          const ageHours = created > 0 ? (nowSec - created) / 3600 : 12;

          // Skip posts older than 48h
          if (ageHours > 48) continue;

          const velocity = calcRedditVelocity(score, comments, ratio, ageHours);
          const isBreakout = score > 500 && ageHours < 6;
          const postId = String(
            item.id ||
              item.postId ||
              `${subreddit}_${Date.now()}_${Math.random()}`,
          );

          await (prisma as any).discovery_reddit_raw.upsert({
            where: { post_id: postId },
            create: {
              post_id: postId,
              subreddit,
              title: title.substring(0, 300),
              score,
              upvote_ratio: ratio,
              num_comments: comments,
              url: item.url || item.permalink || "",
              author: item.author || item.authorName || "",
              flair: item.linkFlairText || item.flair || "",
              age_hours: Math.round(ageHours * 10) / 10,
              velocity,
              is_breakout: isBreakout,
              feed: "hot",
              expires_at: expiresAt,
              raw_data: { score, comments, ageHours, source: "apify" },
            },
            update: {
              score,
              num_comments: comments,
              upvote_ratio: ratio,
              age_hours: Math.round(ageHours * 10) / 10,
              velocity,
              is_breakout: isBreakout,
              scraped_at: new Date(),
            },
          });
          total++;
        } catch {
          /* skip individual record failures */
        }
      }
    }

    // Small pause between Apify batches
    await new Promise((r) => setTimeout(r, 1500));
  }

  logger.info({ total }, "Reddit Apify scrape complete");
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 2 — TikTok via Apify (clockworks/tiktok-scraper)
// ════════════════════════════════════════════════════════════════════════════

async function scrapeTikTok(client: any): Promise<number> {
  let total = 0;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const BATCH = 2;

  for (let i = 0; i < TIKTOK_HASHTAGS.length; i += BATCH) {
    const batch = TIKTOK_HASHTAGS.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(async (hashtag) => {
        try {
          const run = await client.actor("clockworks/tiktok-scraper").call({
            hashtags: [hashtag],
            numberOfVideos: TIKTOK_PER_TAG,
            downloadVideos: false,
            downloadThumbnails: false,
            shouldDownloadCovers: false,
          });
          const dataset = await client
            .dataset(run.defaultDatasetId)
            .listItems({ limit: TIKTOK_PER_TAG });
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
          const views = Number(item.playCount || 0);
          const likes = Number(item.diggCount || 0);
          const comments = Number(item.commentCount || 0);
          const shares = Number(item.shareCount || 0);
          const engagement =
            views > 0 ? (likes + comments + shares) / views : 0;

          await (prisma as any).discovery_tiktok_raw.upsert({
            where: {
              tiktok_id: String(
                item.id || item.videoId || `tt_${Math.random()}`,
              ),
            },
            create: {
              tiktok_id: String(item.id || item.videoId || ""),
              description: (item.description || "").substring(0, 500),
              creator_handle: item.authorMeta?.id || item.author || "",
              creator_name: item.authorMeta?.name || item.authorName || "",
              creator_followers: BigInt(item.authorMeta?.fans || 0),
              views: BigInt(views),
              likes: BigInt(likes),
              comments: BigInt(comments),
              shares: BigInt(shares),
              saves: BigInt(item.saveCount || item.bookmarkCount || 0),
              engagement_rate: engagement,
              sound_name: item.musicMeta?.musicName || "",
              sound_artist: item.musicMeta?.musicAuthor || "",
              hashtags: extractHashtags(item.description || ""),
              video_url: item.webVideoUrl || item.url || "",
              thumbnail_url: item.dynamicCover || item.thumbnail || "",
              duration: Number(item.videoMeta?.duration || 0),
              expires_at: expiresAt,
              raw_data: { source: "tiktok", scraped_at: new Date() },
            },
            update: {
              views: BigInt(views),
              likes: BigInt(likes),
              comments: BigInt(comments),
              shares: BigInt(shares),
              engagement_rate: engagement,
              scraped_at: new Date(),
            },
          });
          total++;
        } catch {
          /* skip */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.info({ total }, "TikTok global scrape complete");
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 3 — Pinterest via Apify (fatihtahta/pinterest-scraper-search)
// ════════════════════════════════════════════════════════════════════════════

async function scrapePinterest(client: any): Promise<number> {
  let total = 0;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const BATCH = 3;

  for (let i = 0; i < PINTEREST_QUERIES.length; i += BATCH) {
    const batch = PINTEREST_QUERIES.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(async (query) => {
        try {
          const run = await client
            .actor("fatihtahta/pinterest-scraper-search")
            .call({
              startUrls: [toPinterestSearchUrl(query)],
              maxItems: PINTEREST_PER_QUERY,
            });
          const dataset = await client
            .dataset(run.defaultDatasetId)
            .listItems({ limit: PINTEREST_PER_QUERY });
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
          const saves = Number(
            item.repinCount || item.saves || item.num_saves || 0,
          );
          const clicks = Number(item.clicks || item.num_clicks || 0);
          const impressions = Number(
            item.impressions || item.num_impressions || 1,
          );
          const engagement = (saves + clicks) / Math.max(impressions, 1);

          const imageUrl =
            item.images?.orig?.url ||
            item.images?.["736x"]?.url ||
            item.image_url ||
            item.imgSrc ||
            "";

          const pinId = String(item.id || item.pinId || `pin_${Math.random()}`);

          await (prisma as any).discovery_pinterest_raw.upsert({
            where: { pinterest_id: pinId },
            create: {
              pinterest_id: pinId,
              title: (item.title || "").substring(0, 300),
              description: (item.description || "").substring(0, 500),
              image_url: imageUrl,
              pin_url: item.url || item.link || "",
              board_name: item.board?.name || item.boardName || "",
              board_owner: item.pinner?.username || item.pinner?.fullName || "",
              saves: BigInt(saves),
              clicks: BigInt(clicks),
              engagement_rate: engagement,
              hashtags: extractHashtags(
                `${item.title || ""} ${item.description || ""}`,
              ),
              pin_type: item.pinType || "standard",
              expires_at: expiresAt,
              raw_data: { item, scraped_at: new Date() },
            },
            update: {
              saves: BigInt(saves),
              clicks: BigInt(clicks),
              engagement_rate: engagement,
              scraped_at: new Date(),
            },
          });
          total++;
        } catch {
          /* skip */
        }
      }
    }
  }

  logger.info({ total }, "Pinterest global scrape complete");
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 4 — Instagram via Apify (apify/instagram-hashtag-scraper)
// Stored in discovery_tiktok_raw — same shape, source field differentiates
// ════════════════════════════════════════════════════════════════════════════

async function scrapeInstagram(client: any): Promise<number> {
  let total = 0;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const BATCH = 3;

  for (let i = 0; i < INSTAGRAM_HASHTAGS.length; i += BATCH) {
    const batch = INSTAGRAM_HASHTAGS.slice(i, i + BATCH);

    const results = await Promise.allSettled(
      batch.map(async (hashtag) => {
        try {
          const run = await client
            .actor("apify/instagram-hashtag-scraper")
            .call({
              hashtags: [hashtag],
              resultsLimit: INSTAGRAM_PER_TAG,
              onlyPostsNewerThan: new Date(
                Date.now() - 7 * 24 * 60 * 60 * 1000,
              ).toISOString(),
            });
          const dataset = await client
            .dataset(run.defaultDatasetId)
            .listItems({ limit: INSTAGRAM_PER_TAG });
          return { hashtag, items: dataset.items as any[] };
        } catch (err: any) {
          logger.warn(
            { hashtag, err: err.message },
            "Instagram hashtag scrape failed",
          );
          return { hashtag, items: [] };
        }
      }),
    );

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const { hashtag, items } = r.value;

      for (const item of items) {
        try {
          const likes = Number(item.likesCount || 0);
          const comments = Number(item.commentsCount || 0);
          const views = Number(item.videoViewCount || item.videoPlayCount || 0);
          const caption = (item.caption || "").substring(0, 500);
          const hashtags = (caption.match(/#[\w\u0900-\u097F]+/g) || [])
            .map((h: string) => h.slice(1).toLowerCase())
            .slice(0, 20);

          const postId = `ig_${String(item.shortCode || item.id || Math.random())}`;

          await (prisma as any).discovery_tiktok_raw.upsert({
            where: { tiktok_id: postId },
            create: {
              tiktok_id: postId,
              description: caption,
              creator_handle: item.ownerUsername || "",
              creator_name: item.ownerFullName || "",
              creator_followers: BigInt(item.ownerFollowersCount || 0),
              views: BigInt(views || likes * 10),
              likes: BigInt(likes),
              comments: BigInt(comments),
              shares: BigInt(0),
              saves: BigInt(item.saveCount || 0),
              engagement_rate: views > 0 ? (likes + comments) / views : 0,
              sound_name: item.musicInfo?.songName || "",
              sound_artist: item.musicInfo?.artistName || "",
              hashtags,
              video_url: item.videoUrl || item.displayUrl || "",
              thumbnail_url: item.displayUrl || "",
              duration: Number(item.videoDuration || 0),
              expires_at: expiresAt,
              raw_data: {
                source: "instagram",
                hashtag,
                scraped_at: new Date(),
              },
            },
            update: {
              views: BigInt(views || likes * 10),
              likes: BigInt(likes),
              comments: BigInt(comments),
              engagement_rate: views > 0 ? (likes + comments) / views : 0,
              scraped_at: new Date(),
            },
          });
          total++;
        } catch {
          /* skip */
        }
      }
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  logger.info({ total }, "Instagram hashtag scrape complete");
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 5 — YouTube via Data API → discovery_youtube_raw
// ════════════════════════════════════════════════════════════════════════════

async function scrapeYouTube(): Promise<number> {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) {
    logger.warn("YOUTUBE_API_KEY not set — skipping YouTube scrape");
    return 0;
  }

  // expires_at = 14h — ensures records survive the 12h re-scrape cycle
  const expiresAt = new Date(Date.now() + 14 * 60 * 60 * 1000);
  let total = 0;

  const categoryResults = await Promise.allSettled(
    YT_TREND_CATEGORIES.map(async (cat) => {
      const params: Record<string, string> = {
        part: "snippet,statistics",
        chart: "mostPopular",
        regionCode: "IN",
        maxResults: "50",
        key: apiKey,
      };
      if (cat.id !== "0") params.videoCategoryId = cat.id;

      const { data } = await axios.get(
        "https://www.googleapis.com/youtube/v3/videos",
        { params, timeout: 15000 },
      );
      return data?.items || [];
    }),
  );

  // Deduplicate by videoId across all category calls
  const seen = new Set<string>();
  const videos: any[] = [];
  for (const r of categoryResults) {
    if (r.status !== "fulfilled") continue;
    for (const v of r.value) {
      if (v.id && !seen.has(v.id)) {
        seen.add(v.id);
        videos.push(v);
      }
    }
  }

  for (const video of videos) {
    try {
      const snippet = video.snippet || {};
      const stats = video.statistics || {};
      const title = (snippet.title || "").trim();
      if (!title) continue;

      const viewCount = Number(stats.viewCount || 0);
      const likeCount = Number(stats.likeCount || 0);
      const commentCount = Number(stats.commentCount || 0);
      const categoryId = snippet.categoryId || "0";
      const velocity = calcYouTubeVelocity(viewCount, likeCount, commentCount);
      const nicheTags = detectNichesFromTitle(title, categoryId);

      await (prisma as any).discovery_youtube_raw.upsert({
        where: { video_id: String(video.id) },
        create: {
          video_id: String(video.id),
          title: title.substring(0, 300),
          channel: snippet.channelTitle || "",
          view_count: BigInt(viewCount),
          like_count: BigInt(likeCount),
          comment_count: BigInt(commentCount),
          category_id: categoryId,
          velocity,
          niche_tags: nicheTags,
          thumbnail_url: snippet.thumbnails?.medium?.url || "",
          published_at: snippet.publishedAt
            ? new Date(snippet.publishedAt)
            : null,
          expires_at: expiresAt,
          raw_data: {
            videoId: video.id,
            channelId: snippet.channelId,
            categoryId,
            viewCount,
            likeCount,
            commentCount,
            publishedAt: snippet.publishedAt,
          },
        },
        update: {
          view_count: BigInt(viewCount),
          like_count: BigInt(likeCount),
          comment_count: BigInt(commentCount),
          velocity,
          niche_tags: nicheTags,
          scraped_at: new Date(),
        },
      });
      total++;
    } catch {
      /* skip individual record failures */
    }
  }

  logger.info(
    { total, categories: YT_TREND_CATEGORIES.length },
    "YouTube raw scrape complete",
  );
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 6 — Google Trends via Apify (apify/google-trends-scraper)
// ════════════════════════════════════════════════════════════════════════════

async function scrapeGoogleTrends(client: any): Promise<number> {
  let total = 0;
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const today = new Date().toISOString().split("T")[0];

  try {
    const run = await client.actor("apify/google-trends-scraper").call({
      searchTerms: GOOGLE_TRENDS_KEYWORDS,
      geo: "",
      timeRange: "now 1-d",
      category: "",
    });
    const dataset = await client.dataset(run.defaultDatasetId).listItems();

    for (const item of dataset.items) {
      try {
        const keyword = item.keyword || item.term || "";
        const interestScore = Number(item.value || item.interest || 0);
        const isBreakout =
          item.isBreakout || item.breakout || interestScore >= 90;
        const relatedQueries = (item.relatedQueries || [])
          .map((q: any) => q.query || q)
          .slice(0, 10);
        const relatedTopics = (item.relatedTopics || [])
          .map((t: any) => t.topic || t)
          .slice(0, 10);

        if (!keyword) continue;

        await (prisma as any).discovery_google_trends_raw.upsert({
          where: {
            keyword_geo_trend_date: {
              keyword,
              geo: "GLOBAL",
              trend_date: new Date(today),
            },
          },
          create: {
            keyword,
            geo: "GLOBAL",
            interest_score: interestScore,
            related_queries: relatedQueries,
            related_topics: relatedTopics,
            breakout: Boolean(isBreakout),
            trend_date: new Date(today),
            expires_at: expiresAt,
            raw_data: { item, scraped_at: new Date() },
          },
          update: {
            interest_score: interestScore,
            related_queries: relatedQueries,
            related_topics: relatedTopics,
            breakout: Boolean(isBreakout),
            scraped_at: new Date(),
          },
        });
        total++;
      } catch {
        /* skip */
      }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, "Google Trends scrape failed");
  }

  logger.info({ total }, "Google Trends scrape complete");
  return total;
}

// ════════════════════════════════════════════════════════════════════════════
// NORMALISATION — Push top signals from ALL raw tables into live_trends
// Cutoff = 26h to safely cover both 12h (fast) and 24h (slow) cycles
// ════════════════════════════════════════════════════════════════════════════

async function normaliseIntoLiveTrends(): Promise<number> {
  let upserted = 0;
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const cutoff = new Date(Date.now() - 26 * 60 * 60 * 1000); // 26h covers both cycles

  // ── Reddit ───────────────────────────────────────────────────────────────
  const topReddit = await (prisma as any).discovery_reddit_raw.findMany({
    where: { scraped_at: { gt: cutoff }, velocity: { gte: 60 } },
    orderBy: { velocity: "desc" },
    take: 150,
  });

  for (const r of topReddit) {
    try {
      await (prisma as any).live_trends.upsert({
        where: {
          title_source: { title: r.title.substring(0, 200), source: "reddit" },
        },
        create: {
          title: r.title.substring(0, 200),
          source: "reddit",
          search_volume: r.score,
          velocity: r.velocity,
          badge: r.is_breakout
            ? "HOT"
            : r.velocity >= 75
              ? "HOT"
              : r.velocity >= 60
                ? "RISING"
                : "NEW",
          niche_tags: [],
          platform_tags: ["reddit"],
          recommendation: `${r.score} upvotes · ${r.num_comments} comments · r/${r.subreddit}`,
          expires_at: expiresAt,
          fetched_at: new Date(),
          raw_data: {
            post_id: r.post_id,
            subreddit: r.subreddit,
            age_hours: r.age_hours,
            flair: r.flair,
          },
        },
        update: {
          search_volume: r.score,
          velocity: r.velocity,
          badge: r.is_breakout
            ? "HOT"
            : r.velocity >= 75
              ? "HOT"
              : r.velocity >= 60
                ? "RISING"
                : "NEW",
          expires_at: expiresAt,
          fetched_at: new Date(),
        },
      });
      upserted++;
    } catch {
      /* skip */
    }
  }

  // ── TikTok + Instagram (shared raw table, differentiated by raw_data.source) ─
  const topTikTok = await (prisma as any).discovery_tiktok_raw.findMany({
    where: { scraped_at: { gt: cutoff } },
    orderBy: { engagement_rate: "desc" },
    take: 200,
  });

  for (const v of topTikTok) {
    try {
      const velocity = Math.min(
        95,
        Math.max(50, Math.round(Number(v.engagement_rate) * 1000)),
      );
      const title =
        (v.description || "").substring(0, 200) || "Trending Content";
      const isInstagram = (v.raw_data as any)?.source === "instagram";
      const source = isInstagram ? "instagram_global" : "tiktok_global";
      const platform = isInstagram ? "instagram" : "tiktok";

      await (prisma as any).live_trends.upsert({
        where: { title_source: { title, source } },
        create: {
          title,
          source,
          search_volume: Number(v.views),
          velocity,
          badge: velocity > 80 ? "HOT" : velocity > 60 ? "RISING" : "NEW",
          niche_tags: v.hashtags?.slice(0, 5) || [],
          platform_tags: [platform],
          recommendation: `${Number(v.views).toLocaleString("en-IN")} views · ${(Number(v.engagement_rate) * 100).toFixed(1)}% engagement`,
          expires_at: expiresAt,
          fetched_at: new Date(),
          raw_data: {
            tiktok_id: v.tiktok_id,
            sound: v.sound_name,
            source: platform,
          },
        },
        update: {
          search_volume: Number(v.views),
          velocity,
          badge: velocity > 80 ? "HOT" : velocity > 60 ? "RISING" : "NEW",
          expires_at: expiresAt,
          fetched_at: new Date(),
        },
      });
      upserted++;
    } catch {
      /* skip */
    }
  }

  // ── Pinterest ─────────────────────────────────────────────────────────────
  const topPins = await (prisma as any).discovery_pinterest_raw.findMany({
    where: { scraped_at: { gt: cutoff } },
    orderBy: { saves: "desc" },
    take: 100,
  });

  for (const p of topPins) {
    try {
      const saves = Number(p.saves);
      const velocity = calcPinterestVelocity(saves);
      const title =
        (p.title || p.description || "").substring(0, 200) ||
        "Pinterest Trending";

      await (prisma as any).live_trends.upsert({
        where: { title_source: { title, source: "pinterest_global" } },
        create: {
          title,
          source: "pinterest_global",
          search_volume: saves,
          velocity,
          badge: velocity > 70 ? "HOT" : velocity > 50 ? "RISING" : "NEW",
          niche_tags: p.hashtags?.slice(0, 5) || [],
          platform_tags: ["pinterest"],
          recommendation: `${saves.toLocaleString("en-IN")} saves · Pinterest`,
          expires_at: expiresAt,
          fetched_at: new Date(),
          raw_data: { pinterest_id: p.pinterest_id, board: p.board_name },
        },
        update: {
          search_volume: saves,
          velocity,
          badge: velocity > 70 ? "HOT" : velocity > 50 ? "RISING" : "NEW",
          expires_at: expiresAt,
          fetched_at: new Date(),
        },
      });
      upserted++;
    } catch {
      /* skip */
    }
  }

  // ── YouTube (via raw staging table) ──────────────────────────────────────
  const topYouTube = await (prisma as any).discovery_youtube_raw.findMany({
    where: { scraped_at: { gt: cutoff }, velocity: { gte: 40 } },
    orderBy: { velocity: "desc" },
    take: 200,
  });

  for (const y of topYouTube) {
    try {
      const title = y.title.substring(0, 200);

      await (prisma as any).live_trends.upsert({
        where: { title_source: { title, source: "youtube" } },
        create: {
          title,
          source: "youtube",
          search_volume: Number(y.view_count),
          velocity: y.velocity,
          badge: y.velocity >= 75 ? "HOT" : y.velocity >= 55 ? "RISING" : "NEW",
          niche_tags: y.niche_tags || [],
          platform_tags: ["youtube"],
          recommendation: `${Number(y.view_count).toLocaleString("en-IN")} views on YouTube India · ${y.channel}`,
          expires_at: expiresAt,
          fetched_at: new Date(),
          raw_data: y.raw_data,
        },
        update: {
          search_volume: Number(y.view_count),
          velocity: y.velocity,
          badge: y.velocity >= 75 ? "HOT" : y.velocity >= 55 ? "RISING" : "NEW",
          niche_tags: y.niche_tags || [],
          recommendation: `${Number(y.view_count).toLocaleString("en-IN")} views on YouTube India · ${y.channel}`,
          expires_at: expiresAt,
          fetched_at: new Date(),
        },
      });
      upserted++;
    } catch {
      /* skip */
    }
  }

  // ── Google Trends ──────────────────────────────────────────────────────────
  const topGoogle = await (prisma as any).discovery_google_trends_raw.findMany({
    where: { scraped_at: { gt: cutoff }, interest_score: { gte: 50 } },
    orderBy: { interest_score: "desc" },
    take: 30,
  });

  for (const g of topGoogle) {
    try {
      await (prisma as any).live_trends.upsert({
        where: {
          title_source: {
            title: g.keyword.substring(0, 200),
            source: "google_trends",
          },
        },
        create: {
          title: g.keyword.substring(0, 200),
          source: "google_trends",
          search_volume: g.interest_score * 1000,
          velocity: Math.min(95, g.interest_score),
          badge: g.breakout ? "HOT" : g.interest_score > 80 ? "RISING" : "NEW",
          niche_tags: [],
          platform_tags: ["google"],
          recommendation: `Google Trends score: ${g.interest_score}/100${g.breakout ? " — BREAKOUT" : ""}`,
          expires_at: expiresAt,
          fetched_at: new Date(),
          raw_data: { related_queries: g.related_queries },
        },
        update: {
          search_volume: g.interest_score * 1000,
          velocity: Math.min(95, g.interest_score),
          badge: g.breakout ? "HOT" : g.interest_score > 80 ? "RISING" : "NEW",
          expires_at: expiresAt,
          fetched_at: new Date(),
        },
      });
      upserted++;
    } catch {
      /* skip */
    }
  }

  logger.info({ upserted }, "Normalisation into live_trends complete");
  return upserted;
}

// ════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════════════════════════════

async function cleanupExpired(): Promise<void> {
  await Promise.allSettled([
    (prisma as any).discovery_reddit_raw.deleteMany({
      where: { expires_at: { lt: new Date() } },
    }),
    (prisma as any).discovery_tiktok_raw.deleteMany({
      where: { expires_at: { lt: new Date() } },
    }),
    (prisma as any).discovery_pinterest_raw.deleteMany({
      where: { expires_at: { lt: new Date() } },
    }),
    (prisma as any).discovery_google_trends_raw.deleteMany({
      where: { expires_at: { lt: new Date() } },
    }),
    (prisma as any).discovery_youtube_raw.deleteMany({
      where: { expires_at: { lt: new Date() } },
    }),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════
// PRE-WARM hot windows after any discovery run
// ════════════════════════════════════════════════════════════════════════════

async function prewarmHotWindows(): Promise<void> {
  try {
    const { hybridRetrieve } =
      await import("../services/retrieval/hybrid-rag.service");
    const NICHES = [
      "lifestyle",
      "fashion",
      "fitness",
      "gaming",
      "tech",
      "food",
      "travel",
      "comedy",
      "education",
      "general",
    ];
    for (const niche of NICHES) {
      try {
        await hybridRetrieve({ niche, forceRefresh: true });
      } catch {
        /* non-fatal */
      }
    }
    logger.info("Trend hot windows pre-warmed");
  } catch (err: any) {
    logger.warn({ err: err.message }, "Hot window pre-warm failed — non-fatal");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// JOB PROCESSORS — one per queue
// ════════════════════════════════════════════════════════════════════════════

// discovery-slow: Reddit + TikTok + Pinterest + Instagram (every 24h, all Apify)
async function processSlowJob(job: Job): Promise<Record<string, any>> {
  const token = getApifyToken();
  const diagnostics: Record<string, string> = {};

  logger.info(
    { jobId: job.id },
    "discovery-slow started (Reddit + TikTok + Pinterest + Instagram)",
  );

  if (!token) {
    const msg = "APIFY_TOKEN / APIFY_API_TOKEN not set — aborting slow job";
    logger.error(msg);
    throw new Error(msg);
  }

  const { ApifyClient } = await import("apify-client");
  const client = new ApifyClient({ token });

  const quotaOk = await checkApifyQuota(client);
  if (!quotaOk) {
    throw new Error("Apify monthly quota exhausted — slow job skipped");
  }

  await job.updateProgress(5);

  const [redditResult, tiktokResult, pinterestResult, instagramResult] =
    await Promise.allSettled([
      scrapeReddit(client),
      scrapeTikTok(client),
      scrapePinterest(client),
      scrapeInstagram(client),
    ]);

  const reddit = redditResult.status === "fulfilled" ? redditResult.value : 0;
  const tiktok = tiktokResult.status === "fulfilled" ? tiktokResult.value : 0;
  const pinterest =
    pinterestResult.status === "fulfilled" ? pinterestResult.value : 0;
  const instagram =
    instagramResult.status === "fulfilled" ? instagramResult.value : 0;

  diagnostics["reddit"] =
    redditResult.status === "fulfilled"
      ? `ok (${reddit})`
      : `failed: ${(redditResult as any).reason?.message}`;
  diagnostics["tiktok"] =
    tiktokResult.status === "fulfilled"
      ? `ok (${tiktok})`
      : `failed: ${(tiktokResult as any).reason?.message}`;
  diagnostics["pinterest"] =
    pinterestResult.status === "fulfilled"
      ? `ok (${pinterest})`
      : `failed: ${(pinterestResult as any).reason?.message}`;
  diagnostics["instagram"] =
    instagramResult.status === "fulfilled"
      ? `ok (${instagram})`
      : `failed: ${(instagramResult as any).reason?.message}`;

  await job.updateProgress(70);

  const normalised = await normaliseIntoLiveTrends();
  diagnostics["normalised"] = `${normalised}`;

  await job.updateProgress(85);
  await prewarmHotWindows();
  await cleanupExpired();
  await job.updateProgress(100);

  logger.info(
    { reddit, tiktok, pinterest, instagram, normalised, diagnostics },
    "discovery-slow complete",
  );
  return { reddit, tiktok, pinterest, instagram, normalised, diagnostics };
}

// discovery-fast: YouTube + Google Trends (every 12h)
async function processFastJob(job: Job): Promise<Record<string, any>> {
  const token = getApifyToken();
  const diagnostics: Record<string, string> = {};

  logger.info(
    { jobId: job.id },
    "discovery-fast started (YouTube + Google Trends)",
  );

  await job.updateProgress(5);

  // YouTube never needs Apify
  const youtubeResult = await Promise.allSettled([scrapeYouTube()]);
  const youtube =
    youtubeResult[0].status === "fulfilled" ? youtubeResult[0].value : 0;
  diagnostics["youtube"] =
    youtubeResult[0].status === "fulfilled"
      ? `ok (${youtube})`
      : `failed: ${(youtubeResult[0] as any).reason?.message}`;

  await job.updateProgress(40);

  // Google Trends needs Apify
  let googleTrends = 0;
  if (!token) {
    diagnostics["googleTrends"] = "skipped: APIFY_TOKEN missing";
    logger.warn("APIFY_TOKEN not set — skipping Google Trends");
  } else {
    const { ApifyClient } = await import("apify-client");
    const client = new ApifyClient({ token });
    const quotaOk = await checkApifyQuota(client);

    if (!quotaOk) {
      diagnostics["googleTrends"] = "skipped: quota exhausted";
    } else {
      const gtResult = await Promise.allSettled([scrapeGoogleTrends(client)]);
      googleTrends = gtResult[0].status === "fulfilled" ? gtResult[0].value : 0;
      diagnostics["googleTrends"] =
        gtResult[0].status === "fulfilled"
          ? `ok (${googleTrends})`
          : `failed: ${(gtResult[0] as any).reason?.message}`;
    }
  }

  await job.updateProgress(70);

  const normalised = await normaliseIntoLiveTrends();
  diagnostics["normalised"] = `${normalised}`;

  await job.updateProgress(85);
  await prewarmHotWindows();
  await cleanupExpired();
  await job.updateProgress(100);

  logger.info(
    { youtube, googleTrends, normalised, diagnostics },
    "discovery-fast complete",
  );
  return { youtube, googleTrends, normalised, diagnostics };
}

// Route by job name
async function processJob(job: Job): Promise<Record<string, any>> {
  if (job.name === "discovery-fast") return processFastJob(job);
  if (job.name === "discovery-slow") return processSlowJob(job);
  // Legacy job name — run both (for manual triggers and backwards compat)
  logger.warn(
    { jobName: job.name },
    "Unknown job name — running full pipeline",
  );
  const [fast, slow] = await Promise.allSettled([
    processFastJob(job),
    processSlowJob(job),
  ]);
  return {
    fast:
      fast.status === "fulfilled" ? fast.value : (fast as any).reason?.message,
    slow:
      slow.status === "fulfilled" ? slow.value : (slow as any).reason?.message,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// WORKER LIFECYCLE
// ════════════════════════════════════════════════════════════════════════════

export async function startDiscoveryWorker(): Promise<Worker | null> {
  if (process.env.DISCOVERY_WORKER_ENABLED === "false") {
    logger.info("Discovery worker disabled via env");
    return null;
  }

  // Single worker listens on discovery-queue (fast jobs)
  worker = new Worker("discovery-queue", processJob, {
    connection: getConnection(),
    concurrency: 1,
  });

  worker.on("completed", (job, result) => {
    logger.info(
      { jobId: job.id, jobName: job.name, ...result },
      "Discovery job completed",
    );
  });

  worker.on("failed", (job, err) => {
    logger.error(
      { jobId: job?.id, jobName: job?.name, err: err.message },
      "Discovery job failed",
    );
  });

  worker.on("error", (err) => {
    logger.error({ err: err.message }, "Discovery worker error");
  });

  logger.info("Discovery worker started — listening on discovery-queue");
  return worker;
}

export async function stopDiscoveryWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info("Discovery worker stopped");
  }
}

// Export job processors so index.ts can spin up the slow worker separately
export { processSlowJob, processFastJob };
