// src/workers/discovery.worker.ts// src/workers/discovery.worker.ts

// ══════════════════════════════════════════════════════════════════════════════// ══════════════════════════════════════════════════════════════════════════════

// Unified Discovery Worker — runs every 12 hours// Unified Discovery Worker — runs every 12 hours

////

// Sources:// Sources:

//   YouTube (Data API V3)  → live_trends directly  — 12h cycle//   YouTube (Data API V3)  → live_trends directly  — 12h cycle

//   Reddit  (Apify)        → discovery_reddit_raw  → live_trends — 24h cycle//   Reddit  (Apify)        → discovery_reddit_raw  → live_trends — 24h cycle

//   TikTok  (Apify)        → discovery_tiktok_raw  → live_trends — 24h cycle//   TikTok  (Apify)        → discovery_tiktok_raw  → live_trends — 24h cycle

//   Pinterest (Apify)      → discovery_pinterest_raw → live_trends — 24h cycle//   Pinterest (Apify)      → discovery_pinterest_raw → live_trends — 24h cycle

//   Google Trends (Apify)  → discovery_google_trends_raw → live_trends — 24h cycle//   Google Trends (Apify)  → discovery_google_trends_raw → live_trends — 24h cycle

////

// Architecture:// Architecture:

//   1. Scrape raw data//   1. Scrape raw data

//   2. Apply unified scoring (scoring.service.ts)//   2. Apply unified scoring (scoring.service.ts)

//   3. Apply velocity gate + override checks//   3. Apply velocity gate + override checks

//   4. Write only passing records to live_trends//   4. Write only passing records to live_trends

//   5. Update scrape_health per source//   5. Update scrape_health per source

//   6. Embed new live_trends records (Tier 2)//   6. Embed new live_trends records (Tier 2)

//   7. Pre-warm hot windows (Tier 1)//   7. Pre-warm hot windows (Tier 1)

// ══════════════════════════════════════════════════════════════════════════════// ══════════════════════════════════════════════════════════════════════════════



import { Worker, type Job } from 'bullmq';import { Worker, type Job } from 'bullmq';

import axios from 'axios';import axios from 'axios';

import { prisma } from '../config/database';import { prisma } from '../config/database';

import { logger } from '../utils/logger';import { logger } from '../utils/logger';

import {import {

  computeYouTubeVelocity,  computeYouTubeVelocity,

  computeRedditScore,  computeRedditScore,

  computeTikTokVelocity,  computeTikTokVelocity,

  computePinterestScore,  computePinterestScore,

  computeGoogleSlope,  computeGoogleSlope,

  makeVelocityDecision,  makeVelocityDecision,

  detectContentFormat,  detectContentFormat,

  normaliseScore,  normaliseScore,

} from '../services/discovery/scoring.service';} from '../services/discovery/scoring.service';

import {import {

  markScrapeRunning,  markScrapeRunning,

  markScrapeSuccess,  markScrapeSuccess,

  markScrapeFailed,  markScrapeFailed,

  isSourceHealthy,  isSourceHealthy,

  extendSourceData,  extendSourceData,

} from '../services/discovery/scrape-health.service';} from '../services/discovery/scrape-health.service';



let worker: Worker | null = null;let worker: Worker | null = null;



function getConnection() {function getConnection() {

  const url = process.env.REDIS_URL || 'redis://localhost:6379';  const url = process.env.REDIS_URL || "redis://localhost:6379";

  const parsed = new URL(url);  const parsed = new URL(url);

  return { host: parsed.hostname, port: parseInt(parsed.port || '6379') };  return { host: parsed.hostname, port: parseInt(parsed.port || "6379") };

}}



const YT_API_BASE   = 'https://www.googleapis.com/youtube/v3';// ── Reddit: 40 subreddits — broad global coverage ────────────────────────────

const APIFY_BASE    = 'https://api.apify.com/v2';const REDDIT_SUBREDDITS = [

const APIFY_TOKEN   = () => process.env.APIFY_TOKEN?.trim() || '';  // India-specific

  "india", "AskIndia", "IndiaInvestments", "bollywood", "cricket",

// 12h expiry + 1h buffer so data survives until next run  "IndiaSpeaks", "IndianFood", "delhi", "mumbai", "bangalore",

const TREND_EXPIRY_MS = 13 * 60 * 60 * 1000;  // Creator & content

  "content_marketing", "socialmedia", "Entrepreneur", "startups",

// How old the publishedAfter window is for YouTube search  "marketing", "videography", "photography", "podcasting",

const YT_SEARCH_WINDOW_MS = 12 * 60 * 60 * 1000;  // Lifestyle niches

  "malefashionadvice", "femalefashionadvice", "SkincareAddiction",

// ── YouTube category IDs ──────────────────────────────────────────────────────  "fitness", "bodyweightfitness", "running", "yoga",

const YT_TREND_CATEGORIES = [  "food", "EatCheapAndHealthy", "MealPrepSunday",

  { id: '0',  label: 'All'           },  "travel", "solotravel", "backpacking",

  { id: '10', label: 'Music'         },  // Tech & finance

  { id: '17', label: 'Sports'        },  "technology", "programming", "webdev", "datascience",

  { id: '20', label: 'Gaming'        },  "personalfinance", "investing", "cryptocurrency",

  { id: '22', label: 'PeopleBlogs'   },  // Entertainment & culture

  { id: '23', label: 'Comedy'        },  "movies", "Music", "books", "gaming",

  { id: '24', label: 'Entertainment' },  "comedy", "memes", "funny",

  { id: '25', label: 'NewsPolitics'  },  // Global trending

  { id: '26', label: 'HowtoStyle'    },  "worldnews", "todayilearned", "interestingasfuck",

  { id: '28', label: 'SciTech'       },];

];

// ── TikTok hashtags — global firehose ────────────────────────────────────────

// Niches that have NO category ID — must use search.list (costs 100 units each)const TIKTOK_HASHTAGS = [

const YT_SEARCH_NICHES = [  "fyp", "foryou", "foryoupage", "trending", "viral", "explore",

  { niche: 'finance',   query: 'finance investment India 2025'     },  "india", "indian", "indiancreator", "desi", "bharat",

  { niche: 'hustle',    query: 'startup entrepreneur India 2025'   },  "fashion", "beauty", "fitness", "food", "travel", "comedy",

  { niche: 'bollywood', query: 'bollywood trending India 2025'     },  "dance", "music", "art", "diy", "lifestyle", "motivation",

  { niche: 'cricket',   query: 'cricket IPL trending India 2025'   },  "funny", "love", "life", "aesthetic", "vlog", "reels",

  { niche: 'fashion',   query: 'fashion outfit India trending 2025' },  "bollywood", "hindisongs", "desicreator", "hindicomedy",

];  "streetfood", "cricket", "wedding", "skincare", "makeup",

  "gym", "yoga", "cooking", "entrepreneur", "startup",

const YT_CATEGORY_MAP: Record<string, string> = {];

  '10': 'music', '17': 'sports', '19': 'travel', '20': 'gaming',

  '22': 'general', '23': 'comedy', '24': 'entertainment',// ── Pinterest queries — global coverage

  '25': 'news', '26': 'education', '27': 'education', '28': 'tech',// fatihtahta/pinterest-scraper-search takes startUrls (Pinterest search URLs)

};const PINTEREST_QUERIES = [

  "trending", "viral content", "aesthetic", "home decor",

const NICHE_KEYWORDS: Record<string, string[]> = {  "fashion outfits", "fitness motivation", "food recipes",

  fashion:   ['fashion','outfit','ootd','style','clothes','makeup','beauty','nykaa','myntra'],  "travel destinations", "beauty tips", "diy projects",

  fitness:   ['fitness','gym','workout','yoga','diet','weight loss','muscle'],  "india trending", "bollywood style", "wedding india",

  food:      ['food','recipe','cooking','restaurant','biryani','street food','chef'],  "skincare routine", "minimalist", "boho style", "art ideas",

  cricket:   ['cricket','ipl','virat','rohit','match','wicket'],  "photography", "interior design", "healthy recipes",

  bollywood: ['bollywood','movie','actor','film','song','trailer'],];

  tech:      ['tech','smartphone','review','unboxing','ai','gadget','laptop'],

  finance:   ['finance','stock','investment','zerodha','groww','mutual fund','crypto'],// Converts query strings into Pinterest search URLs as required by the actor

  travel:    ['travel','vlog','trip','tour','destination','hotel'],function toPinterestSearchUrl(query: string): string {

  education: ['study','exam','upsc','jee','learn','tutorial','how to'],  return `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;

  comedy:    ['funny','comedy','meme','roast','prank'],}

  hustle:    ['startup','business','entrepreneur','shark tank','side hustle','money'],

};// ── Google Trends keywords ────────────────────────────────────────────────────

const GOOGLE_TRENDS_KEYWORDS = [

function detectNiches(text: string): string[] {  "trending india", "viral video", "instagram reels",

  const lower = text.toLowerCase();  "youtube trending", "tiktok trend", "fashion trend",

  const niches: string[] = [];  "fitness trend", "food trend", "travel india",

  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS)) {  "bollywood", "cricket", "startup india", "beauty trend",

    if (keywords.some(kw => lower.includes(kw))) niches.push(niche);  "technology trend", "education india",

  }];

  return niches.length > 0 ? niches : ['general'];

}// ── Velocity calculator (consistent across all sources) ───────────────────────

function calcRedditVelocity(score: number, comments: number, ratio: number, ageHours: number): number {

// ════════════════════════════════════════════════════════════════════════════  const recencyBoost = ageHours < 3 ? 20 : ageHours < 6 ? 15 : ageHours < 24 ? 8 : 0;

// UPSERT TO LIVE_TRENDS — single function used by all sources  return Math.min(95, Math.max(40, Math.round(

// ════════════════════════════════════════════════════════════════════════════    ratio * 35 +

    Math.min(score, 1000) / 1000 * 30 +

async function upsertToLiveTrends(params: {    Math.min(comments, 300) / 300 * 15 +

  title:            string;    recencyBoost

  source:           string;  )));

  velocity:         number;}

  platformRawScore: number;

  nicheTags:        string[];function calcPinterestVelocity(saves: number): number {

  platformTags:     string[];  // Log-scaled so pins with 500 saves get velocity 60, 10K saves get 80

  contentFormat:    string;  return Math.min(90, Math.max(30, Math.round(Math.log10(saves + 1) * 30)));

  badge:            string;}

  recommendation:   string;

  isOverride:       boolean;function extractHashtags(text: string): string[] {

  overrideReason:   string | null;  return (text.match(/#[\w]+/g) || [])

  rawData:          Record<string, any>;    .map((h) => h.replace("#", "").toLowerCase())

}): Promise<boolean> {    .slice(0, 20);

  const expiresAt = new Date(Date.now() + TREND_EXPIRY_MS);}

  const titleKey  = params.title.substring(0, 200);

// ── Browser-like HTTP client (Reddit blocks axios default UA) ─────────────────

  try {const HTTP = axios.create({

    await (prisma as any).live_trends.upsert({  timeout: 12000,

      where:  { title_source: { title: titleKey, source: params.source } },  headers: {

      create: {    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",

        title:              titleKey,    "Accept": "application/json, text/plain, */*",

        source:             params.source,    "Accept-Language": "en-US,en;q=0.9",

        velocity:           params.velocity,  },

        platform_raw_score: params.platformRawScore,});

        niche_tags:         params.nicheTags,

        platform_tags:      params.platformTags,// ── Apify quota check guard ───────────────────────────────────────────────────

        content_format:     params.contentFormat,// Prevents spam warnings when monthly quota is exhausted

        badge:              params.badge,async function checkApifyQuota(client: any): Promise<boolean> {

        recommendation:     params.recommendation.substring(0, 500),  try {

        is_override:        params.isOverride,    const user = await client.user().get();

        override_reason:    params.overrideReason,    const used  = user?.monthlyUsage?.actorComputeUnits || 0;

        expires_at:         expiresAt,    const limit = user?.plan?.monthlyActorComputeUnits || 0;

        fetched_at:         new Date(),    if (limit > 0 && used >= limit * 0.98) {

        raw_data:           params.rawData,      logger.warn({ used, limit }, "Apify monthly quota exhausted — skipping TikTok/Pinterest/Google Trends");

        search_volume:      params.rawData.viewCount || params.rawData.score || 0,      return false;

      },    }

      update: {    return true;

        velocity:           params.velocity,  } catch {

        platform_raw_score: params.platformRawScore,    return true; // if check fails, try anyway

        niche_tags:         params.nicheTags,  }

        badge:              params.badge,}

        recommendation:     params.recommendation.substring(0, 500),

        is_override:        params.isOverride,// ════════════════════════════════════════════════════════════════════════════

        override_reason:    params.overrideReason,// SOURCE 1: Reddit

        expires_at:         expiresAt,// ════════════════════════════════════════════════════════════════════════════

        fetched_at:         new Date(),

        raw_data:           params.rawData,async function scrapeReddit(): Promise<number> {

        search_volume:      params.rawData.viewCount || params.rawData.score || 0,  const nowSec = Date.now() / 1000;

      },  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days

    });  let total = 0;

    return true;

  } catch (err: any) {  // Process subreddits in batches of 3 to avoid rate limiting (reduced from 5)

    logger.warn({ err: err.message, title: titleKey, source: params.source }, 'upsertToLiveTrends failed');  const BATCH_SIZE = 3;

    return false;  for (let i = 0; i < REDDIT_SUBREDDITS.length; i += BATCH_SIZE) {

  }    const batch = REDDIT_SUBREDDITS.slice(i, i + BATCH_SIZE);

}

    await Promise.allSettled(

// ════════════════════════════════════════════════════════════════════════════      batch.flatMap((sub) =>

// SOURCE 1: YOUTUBE        ["rising", "hot"].map(async (feed) => {

// ════════════════════════════════════════════════════════════════════════════          try {

            // Add random jitter (0-1s) before each request to spread load

async function scrapeYouTube(): Promise<number> {            await new Promise((r) => setTimeout(r, Math.random() * 1000));

  const apiKey = process.env.YOUTUBE_API_KEY?.trim();            const { data } = await HTTP.get(

  if (!apiKey) { logger.warn('YOUTUBE_API_KEY not set — skipping YouTube'); return 0; }              `https://www.reddit.com/r/${sub}/${feed}.json?limit=25&raw_json=1`,

            );

  await markScrapeRunning('youtube');

  let stored = 0;            const posts: any[] = data?.data?.children ?? [];



  try {            for (const { data: p } of posts) {

    const publishedAfter = new Date(Date.now() - YT_SEARCH_WINDOW_MS).toISOString();              const title = (p.title ?? "").trim();

              if (!title || title.length < 10) continue;

    // ── STEP 1: mostPopular by category (cheap: 1 unit per call) ──────────────

    const categoryResults = await Promise.allSettled(              const score    = p.score ?? 0;

      YT_TREND_CATEGORIES.map(cat => {              const comments = p.num_comments ?? 0;

        const params: any = {              const ratio    = p.upvote_ratio ?? 0.5;

          part: 'snippet,statistics,contentDetails',              const ageHours = (nowSec - (p.created_utc ?? 0)) / 3600;

          chart: 'mostPopular',

          regionCode: 'IN',              // Skip posts older than 72 hours

          maxResults: 50,              if (ageHours > 72) continue;

          key: apiKey,

        };              const velocity   = calcRedditVelocity(score, comments, ratio, ageHours);

        if (cat.id !== '0') params.videoCategoryId = cat.id;              const isBreakout = score > 500 && ageHours < 6;

        return axios.get(`${YT_API_BASE}/videos`, { params, timeout: 15000 })

          .then(r => r.data?.items || []);              try {

      })                await (prisma as any).discovery_reddit_raw.upsert({

    );                  where:  { post_id: String(p.id || p.name || `${sub}_${Date.now()}`) },

                  create: {

    // ── STEP 2: niche-specific search (100 units per call) ────────────────────                    post_id:      String(p.id || p.name || ""),

    const searchResults = await Promise.allSettled(                    subreddit:    sub,

      YT_SEARCH_NICHES.map(n =>                    title:        title.substring(0, 300),

        axios.get(`${YT_API_BASE}/search`, {                    score,

          params: {                    upvote_ratio: ratio,

            part: 'snippet', q: n.query, type: 'video',                    num_comments: comments,

            order: 'viewCount', regionCode: 'IN',                    url:          p.url || p.permalink || "",

            publishedAfter,                    author:       p.author || "",

            maxResults: 30, key: apiKey,                    flair:        p.link_flair_text || "",

          },                    age_hours:    Math.round(ageHours * 10) / 10,

          timeout: 12000,                    velocity,

        }).then(async r => {                    is_breakout:  isBreakout,

          const items = r.data?.items || [];                    feed,

          if (items.length === 0) return [];                    expires_at:   expiresAt,

          // Enrich search results with statistics (videos.list = 1 unit)                    raw_data:     { id: p.id, subreddit_id: p.subreddit_id, score, comments },

          const ids = items.map((v: any) => v.id?.videoId).filter(Boolean).join(',');                  },

          if (!ids) return [];                  update: {

          const statsRes = await axios.get(`${YT_API_BASE}/videos`, {                    score,

            params: { part: 'snippet,statistics,contentDetails', id: ids, key: apiKey },                    num_comments: comments,

            timeout: 10000,                    upvote_ratio: ratio,

          });                    age_hours:    Math.round(ageHours * 10) / 10,

          return statsRes.data?.items || [];                    velocity,

        })                    is_breakout:  isBreakout,

      )                    scraped_at:   new Date(),

    );                  },

                });

    // ── Merge + deduplicate ────────────────────────────────────────────────────                total++;

    const seen = new Set<string>();              } catch { /* skip individual upsert failures */ }

    const allVideos: any[] = [];            }

          } catch (err: any) {

    for (const result of [...categoryResults, ...searchResults]) {            logger.warn({ sub, feed, err: err.message }, "Reddit subreddit scrape failed");

      if (result.status !== 'fulfilled') continue;          }

      for (const video of result.value) {        }),

        const id = video.id?.videoId || video.id;      ),

        if (id && !seen.has(id)) {    );

          seen.add(id);

          allVideos.push(video);    // Pause between batches to avoid Reddit rate limiting (increased from 1500ms to 3000ms)

        }    await new Promise((r) => setTimeout(r, 3000));

      }  }

    }

  logger.info({ total }, "Reddit global scrape complete");

    // ── Score + filter + store ─────────────────────────────────────────────────  return total;

    for (const video of allVideos) {}

      const snippet  = video.snippet     || {};

      const stats    = video.statistics  || {};// ════════════════════════════════════════════════════════════════════════════

      const details  = video.contentDetails || {};// SOURCE 2: YouTube (via youtubeTrending.service.ts)

// ════════════════════════════════════════════════════════════════════════════

      const title       = snippet.title || '';

      const viewCount   = parseInt(stats.viewCount   || '0');async function scrapeYouTube(): Promise<number> {

      const likeCount   = parseInt(stats.likeCount   || '0');  try {

      const commentCount= parseInt(stats.commentCount|| '0');    const { fetchYouTubeTrending } = await import("../services/youtubeTrending.service");

      const categoryId  = snippet.categoryId || '22';    const trends = await fetchYouTubeTrending();

      const duration    = details.duration || '';

    if (!trends || trends.length === 0) {

      const rawScore    = computeYouTubeVelocity(viewCount, likeCount, commentCount);      logger.warn("YouTube trending returned 0 results");

      const decision    = makeVelocityDecision({ source: 'youtube', rawScore });      return 0;

    }

      if (!decision.shouldStore) continue;

    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h — YouTube trends change slower

      const nicheFromCat  = YT_CATEGORY_MAP[categoryId] || 'general';    let upserted = 0;

      const nicheFromKw   = detectNiches(`${title} ${snippet.description || ''}`);

      const allNiches     = [...new Set([nicheFromCat, ...nicheFromKw])];    for (const trend of trends) {

      const contentFormat = detectContentFormat('youtube', duration);      try {

      const badge         = decision.unifiedScore >= 75 ? 'HOT' : decision.unifiedScore >= 50 ? 'RISING' : 'NEW';        await (prisma as any).live_trends.upsert({

          where:  { title_source: { title: trend.title.substring(0, 200), source: "youtube" } },

      await upsertToLiveTrends({          create: {

        title,            title:          trend.title.substring(0, 200),

        source:            'youtube',            source:         "youtube",

        velocity:          decision.unifiedScore,            search_volume:  trend.search_volume,

        platformRawScore:  rawScore,            velocity:       trend.velocity,

        nicheTags:         allNiches,            badge:          trend.velocity >= 75 ? "HOT" : trend.velocity >= 55 ? "RISING" : "NEW",

        platformTags:      ['youtube'],            niche_tags:     trend.niche_tags,

        contentFormat,            platform_tags:  ["youtube"],

        badge,            recommendation: `${Number(trend.raw_data.viewCount).toLocaleString("en-IN")} views on YouTube India · ${trend.raw_data.channelTitle}`,

        recommendation:    `${viewCount.toLocaleString('en-IN')} views · ${snippet.channelTitle || ''} · ${contentFormat === 'short_form' ? 'Short' : 'Video'}`,            expires_at:     expiresAt,

        isOverride:        decision.isOverride,            fetched_at:     new Date(),

        overrideReason:    decision.overrideReason,            raw_data:       trend.raw_data,

        rawData: {          },

          videoId:      video.id?.videoId || video.id,          update: {

          channelTitle: snippet.channelTitle,            search_volume:  trend.search_volume,

          viewCount,            velocity:       trend.velocity,

          likeCount,            badge:          trend.velocity >= 75 ? "HOT" : trend.velocity >= 55 ? "RISING" : "NEW",

          commentCount,            niche_tags:     trend.niche_tags,

          categoryId,            recommendation: `${Number(trend.raw_data.viewCount).toLocaleString("en-IN")} views on YouTube India · ${trend.raw_data.channelTitle}`,

          publishedAt:  snippet.publishedAt,            expires_at:     expiresAt,

          thumbnailUrl: snippet.thumbnails?.medium?.url,            fetched_at:     new Date(),

          duration,            raw_data:       trend.raw_data,

        },          },

      });        });

      stored++;        upserted++;

    }      } catch { /* skip individual failures */ }

    }

    const healthy = await markScrapeSuccess('youtube', stored);

    if (!healthy) await extendSourceData('youtube', 6);    logger.info({ upserted, total: trends.length }, "YouTube trends upserted into live_trends");

    return upserted;

    logger.info({ stored, total: allVideos.length }, 'YouTube scrape complete');  } catch (err: any) {

    return stored;    logger.warn({ err: err.message }, "YouTube scrape failed");

    return 0;

  } catch (err: any) {  }

    await markScrapeFailed('youtube', err.message);}

    await extendSourceData('youtube', 6);

    logger.error({ err: err.message }, 'YouTube scrape failed');// ════════════════════════════════════════════════════════════════════════════

    return 0;// SOURCE 3: TikTok (via Apify)

  }// ════════════════════════════════════════════════════════════════════════════

}

async function scrapeTikTok(client: any): Promise<number> {

// ════════════════════════════════════════════════════════════════════════════  let total = 0;

// SOURCE 2: REDDIT (via Apify)  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════════════  const BATCH = 2; // Run 2 hashtag scrapes in parallel to avoid Apify memory spikes

  const PER_TAG = 25; // Number of videos to fetch per hashtag (reduced from 100 to limit memory usage)

const REDDIT_SUBREDDITS = [

  'india','AskIndia','IndiaInvestments','bollywood','cricket',  for (let i = 0; i < TIKTOK_HASHTAGS.length; i += BATCH) {

  'IndiaSpeaks','IndianFood','delhi','mumbai','bangalore',    const batch = TIKTOK_HASHTAGS.slice(i, i + BATCH);

  'content_marketing','socialmedia','Entrepreneur','startups','marketing',

  'malefashionadvice','femalefashionadvice','SkincareAddiction',    const results = await Promise.allSettled(

  'fitness','bodyweightfitness','yoga','food','EatCheapAndHealthy',      batch.map(async (hashtag) => {

  'travel','solotravel','technology','programming','webdev',        try {

  'personalfinance','investing','cryptocurrency',          const run = await client.actor("clockworks/tiktok-scraper").call({

  'movies','Music','gaming','comedy','memes','worldnews','todayilearned',            hashtags:             [hashtag],

];            numberOfVideos:       PER_TAG,

            downloadVideos:       false,

async function scrapeReddit(): Promise<number> {            downloadThumbnails:   false,

  const token = APIFY_TOKEN();            shouldDownloadCovers: false,

  if (!token) { logger.warn('APIFY_TOKEN not set — skipping Reddit'); return 0; }          });

          const dataset = await client.dataset(run.defaultDatasetId).listItems({ limit: PER_TAG });

  await markScrapeRunning('reddit');          return dataset.items as any[];

        } catch (err: any) {

  try {          logger.warn({ hashtag, err: err.message }, "TikTok hashtag failed");

    // Use Apify Reddit Scraper actor: trudax/reddit-scraper          return [];

    const runRes = await axios.post(        }

      `${APIFY_BASE}/acts/trudax~reddit-scraper/runs?token=${token}`,      }),

      {    );

        subreddits:  REDDIT_SUBREDDITS,

        sort:        'hot',    for (const r of results) {

        maxItems:    200,      if (r.status !== "fulfilled") continue;

        proxy:       { useApifyProxy: true },      for (const item of r.value) {

      },        try {

      { timeout: 120000 }          const views    = Number(item.playCount    || 0);

    );          const likes    = Number(item.diggCount    || 0);

          const comments = Number(item.commentCount || 0);

    const runId = runRes.data?.data?.id;          const shares   = Number(item.shareCount   || 0);

    if (!runId) throw new Error('Reddit Apify: no run ID returned');          const engagement = views > 0 ? (likes + comments + shares) / views : 0;



    // Poll for completion (max 90s)          await (prisma as any).discovery_tiktok_raw.upsert({

    let items: any[] = [];            where:  { tiktok_id: String(item.id || item.videoId || `tt_${Math.random()}`) },

    for (let attempt = 0; attempt < 18; attempt++) {            create: {

      await new Promise(r => setTimeout(r, 5000));              tiktok_id:        String(item.id || item.videoId || ""),

      const statusRes = await axios.get(              description:      (item.description || "").substring(0, 500),

        `${APIFY_BASE}/actor-runs/${runId}?token=${token}`,              creator_handle:   item.authorMeta?.id || item.author || "",

        { timeout: 10000 }              creator_name:     item.authorMeta?.name || item.authorName || "",

      );              creator_followers: BigInt(item.authorMeta?.fans || 0),

      const status = statusRes.data?.data?.status;              views:            BigInt(views),

      if (status === 'SUCCEEDED') {              likes:            BigInt(likes),

        const dataRes = await axios.get(              comments:         BigInt(comments),

          `${APIFY_BASE}/actor-runs/${runId}/dataset/items?token=${token}&limit=300`,              shares:           BigInt(shares),

          { timeout: 15000 }              saves:            BigInt(item.saveCount || item.bookmarkCount || 0),

        );              engagement_rate:  engagement,

        items = dataRes.data || [];              sound_name:       item.musicMeta?.musicName || "",

        break;              sound_artist:     item.musicMeta?.musicAuthor || "",

      }              hashtags:         extractHashtags(item.description || ""),

      if (status === 'FAILED' || status === 'ABORTED') {              video_url:        item.webVideoUrl || item.url || "",

        throw new Error(`Reddit Apify run ${status}`);              thumbnail_url:    item.dynamicCover || item.thumbnail || "",

      }              duration:         Number(item.videoMeta?.duration || 0),

    }              expires_at:       expiresAt,

              raw_data:         { source: "tiktok", scraped_at: new Date() },

    if (items.length === 0) throw new Error('Reddit Apify returned 0 items');            },

            update: {

    let stored = 0;              views:           BigInt(views),

              likes:           BigInt(likes),

    // Store in raw table first              comments:        BigInt(comments),

    for (const post of items) {              shares:          BigInt(shares),

      if (!post.title) continue;              engagement_rate: engagement,

      try {              scraped_at:      new Date(),

        await (prisma as any).discovery_reddit_raw.upsert({            },

          where:  { post_id: post.id || post.postId || post.url },          });

          create: {          total++;

            post_id:      post.id || post.postId || post.url,        } catch { /* skip */ }

            subreddit:    post.subreddit || 'unknown',      }

            title:        post.title.substring(0, 300),    }

            score:        post.score || post.upvotes || 0,    await new Promise((r) => setTimeout(r, 2000));

            upvote_ratio: post.upvoteRatio || 0.5,  }

            num_comments: post.numComments || post.comments || 0,

            url:          post.url || null,  logger.info({ total }, "TikTok global scrape complete");

            author:       post.author || null,  return total;

            feed:         'hot',}

            age_hours:    post.createdAt

              ? Math.round((Date.now() - new Date(post.createdAt).getTime()) / 3600000)// ════════════════════════════════════════════════════════════════════════════

              : 0,// SOURCE 4: Pinterest (via Apify)

            velocity:     0,// ════════════════════════════════════════════════════════════════════════════

            is_breakout:  false,

            scraped_at:   new Date(),async function scrapePinterest(client: any): Promise<number> {

            expires_at:   new Date(Date.now() + 25 * 60 * 60 * 1000),  let total = 0;

          },  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

          update: {  // Run queries one at a time to avoid Apify memory spikes

            score:        post.score || post.upvotes || 0,  const BATCH = 3;

            num_comments: post.numComments || post.comments || 0,  const PER_QUERY = 50;

            scraped_at:   new Date(),

          },  for (let i = 0; i < PINTEREST_QUERIES.length; i += BATCH) {

        });    const batch = PINTEREST_QUERIES.slice(i, i + BATCH);

      } catch { /* skip individual row errors */ }

    }    const results = await Promise.allSettled(

      batch.map(async (query) => {

    // Now score + filter + push to live_trends        try {

    const raw = await (prisma as any).discovery_reddit_raw.findMany({          const run = await client.actor("fatihtahta/pinterest-scraper-search").call({

      where: { scraped_at: { gte: new Date(Date.now() - 3 * 60 * 60 * 1000) } },            startUrls: [toPinterestSearchUrl(query)],

      orderBy: { score: 'desc' },            maxItems:  PER_QUERY,

      take: 200,          });

    });          const dataset = await client.dataset(run.defaultDatasetId).listItems({ limit: PER_QUERY });

          return dataset.items as any[];

    for (const r of raw) {        } catch (err: any) {

      const createdAt = r.scraped_at || new Date();          logger.warn({ query, err: err.message }, "Pinterest query failed");

      const { rawScore, isHighFriction } = computeRedditScore(r.score, r.num_comments, createdAt);          return [];

      const decision = makeVelocityDecision({ source: 'reddit', rawScore, isHighFriction });        }

      }),

      if (!decision.shouldStore) continue;    );



      const nicheTags = detectNiches(r.title);    for (const r of results) {

      const badge     = decision.isOverride ? 'HOT' :      if (r.status !== "fulfilled") continue;

                        decision.unifiedScore >= 75 ? 'HOT' :      for (const item of r.value) {

                        decision.unifiedScore >= 50 ? 'RISING' : 'NEW';        try {

          // fatihtahta actor returns: id, title, description, images, url,

      await upsertToLiveTrends({          // saves (repinCount), pinType, pinner (username/fullName), board

        title:            r.title,          const saves       = Number(item.repinCount || item.saves || item.num_saves || 0);

        source:           'reddit',          const clicks      = Number(item.clicks || item.num_clicks || 0);

        velocity:         decision.unifiedScore,          const impressions = Number(item.impressions || item.num_impressions || 1);

        platformRawScore: rawScore,          const engagement  = (saves + clicks) / Math.max(impressions, 1);

        nicheTags,

        platformTags:     ['reddit'],          // Resolve image URL — actor returns images as object or string

        contentFormat:    'article',          const imageUrl =

        badge,            item.images?.orig?.url ||

        recommendation:   `${r.score} upvotes · ${r.num_comments} comments · r/${r.subreddit}${isHighFriction ? ' · HIGH FRICTION 🔥' : ''}`,            item.images?.["736x"]?.url ||

        isOverride:       decision.isOverride,            item.imageUrl ||

        overrideReason:   decision.overrideReason,            item.image ||

        rawData: {            "";

          post_id:   r.post_id,

          subreddit: r.subreddit,          // Resolve pin URL

          score:     r.score,          const pinUrl = item.url || item.link || item.pin_link || "";

          comments:  r.num_comments,

        },          // Resolve creator

      });          const boardOwner =

      stored++;            item.pinner?.username ||

    }            item.pinner?.fullName ||

            item.board_owner ||

    await markScrapeSuccess('reddit', stored);            "";

    logger.info({ stored }, 'Reddit scrape complete');          const boardName = item.board?.name || item.board_name || "";

    return stored;

          const pinId = String(item.id || item.pinId || `pin_${Math.random()}`);

  } catch (err: any) {

    await markScrapeFailed('reddit', err.message);          await (prisma as any).discovery_pinterest_raw.upsert({

    await extendSourceData('reddit', 12);            where:  { pinterest_id: pinId },

    logger.error({ err: err.message }, 'Reddit scrape failed');            create: {

    return 0;              pinterest_id:    pinId,

  }              title:           (item.title || item.description || "").substring(0, 300),

}              description:     (item.description || "").substring(0, 500),

              image_url:       imageUrl,

// Placeholder scrape functions for TikTok, Pinterest, Google              pin_url:         pinUrl,

async function scrapeTikTok(): Promise<number> { return 0; }              board_name:      boardName,

async function scrapePinterest(): Promise<number> { return 0; }              board_owner:     boardOwner,

async function scrapeGoogleTrends(): Promise<number> { return 0; }              saves:           BigInt(saves),

              clicks:          BigInt(clicks),

// ════════════════════════════════════════════════════════════════════════════              engagement_rate: engagement,

// CLEANUP + PRE-WARM              hashtags:        extractHashtags(item.description || ""),

// ════════════════════════════════════════════════════════════════════════════              pin_type:        item.pinType || item.type || "standard",

              expires_at:      expiresAt,

async function cleanupExpired(): Promise<void> {              raw_data:        { source: "pinterest", scraped_at: new Date() },

  await Promise.allSettled([            },

    (prisma as any).discovery_reddit_raw?.deleteMany({            update: {

      where: { expires_at: { lt: new Date() } },              saves:           BigInt(saves),

    }).catch(() => null),              clicks:          BigInt(clicks),

    (prisma as any).discovery_tiktok_raw?.deleteMany({              engagement_rate: engagement,

      where: { expires_at: { lt: new Date() } },              scraped_at:      new Date(),

    }).catch(() => null),            },

    (prisma as any).discovery_pinterest_raw?.deleteMany({          });

      where: { expires_at: { lt: new Date() } },          total++;

    }).catch(() => null),        } catch { /* skip individual pin failures */ }

    (prisma as any).discovery_google_trends_raw?.deleteMany({      }

      where: { expires_at: { lt: new Date() } },    }

    }).catch(() => null),    await new Promise((r) => setTimeout(r, 2000));

  ]);  }

}

  logger.info({ total }, "Pinterest global scrape complete");

async function preWarmHotWindows(): Promise<void> {  return total;

  try {}

    const { hybridRetrieve } = await import('../services/retrieval/hybrid-rag.service');

    const NICHES = [// ════════════════════════════════════════════════════════════════════════════

      'lifestyle','fashion','fitness','gaming','tech',// SOURCE 5: Google Trends (via Apify)

      'food','travel','comedy','education','finance',// ════════════════════════════════════════════════════════════════════════════

      'hustle','bollywood','cricket','beauty','general',

    ];async function scrapeGoogleTrends(client: any): Promise<number> {

    for (const niche of NICHES) {  let total = 0;

      try { await hybridRetrieve({ niche, forceRefresh: true }); } catch { /* non-fatal */ }  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    }  const today = new Date().toISOString().split("T")[0];

    logger.info({ niches: NICHES.length }, 'Hot windows pre-warmed');

  } catch (err: any) {  try {

    logger.warn({ err: err.message }, 'Hot window pre-warm failed — non-fatal');    const run = await client.actor("apify/google-trends-scraper").call({

  }      searchTerms: GOOGLE_TRENDS_KEYWORDS,

}      geo:         "",

      timeRange:   "now 1-d",

// ════════════════════════════════════════════════════════════════════════════      category:    "",   // must be string, not number

// MAIN JOB PROCESSOR    });

// ════════════════════════════════════════════════════════════════════════════

    const dataset = await client.dataset(run.defaultDatasetId).listItems();

async function processJob(job: Job): Promise<Record<string, any>> {

  const diagnostics: Record<string, string> = {};    for (const item of dataset.items) {

  logger.info({ jobId: job.id }, 'Discovery worker started');      try {

        const keyword       = item.keyword || item.term || "";

  await job.updateProgress(5);        const interestScore = Number(item.value || item.interest || 0);

        const isBreakout    = item.isBreakout || item.breakout || interestScore >= 90;

  // ── YouTube + Reddit: always run (no Apify token needed for YouTube) ────────        const relatedQueries = (item.relatedQueries || []).map((q: any) => q.query || q).slice(0, 10);

  const [ytResult, redditResult] = await Promise.allSettled([        const relatedTopics  = (item.relatedTopics  || []).map((t: any) => t.topic  || t).slice(0, 10);

    scrapeYouTube(),

    scrapeReddit(),        if (!keyword) continue;

  ]);

        await (prisma as any).discovery_google_trends_raw.upsert({

  const youtube = ytResult.status    === 'fulfilled' ? ytResult.value    : 0;          where:  { keyword_geo_trend_date: { keyword, geo: "GLOBAL", trend_date: new Date(today) } },

  const reddit  = redditResult.status=== 'fulfilled' ? redditResult.value: 0;          create: {

  diagnostics['youtube'] = ytResult.status    === 'fulfilled' ? `ok (${youtube})`    : `failed: ${(ytResult as any).reason?.message}`;            keyword,

  diagnostics['reddit']  = redditResult.status=== 'fulfilled' ? `ok (${reddit})`     : `failed: ${(redditResult as any).reason?.message}`;            geo:             "GLOBAL",

            interest_score:  interestScore,

  await job.updateProgress(40);            related_queries: relatedQueries,

            related_topics:  relatedTopics,

  // ── TikTok + Pinterest + Google: Apify sources ──────────────────────────────            breakout:        Boolean(isBreakout),

  const token = APIFY_TOKEN();            trend_date:      new Date(today),

  let tiktok = 0, pinterest = 0, google = 0;            expires_at:      expiresAt,

            raw_data:        { item, scraped_at: new Date() },

  if (!token) {          },

    diagnostics['tiktok']    = 'skipped (no APIFY_TOKEN)';          update: {

    diagnostics['pinterest'] = 'skipped (no APIFY_TOKEN)';            interest_score:  interestScore,

    diagnostics['google']    = 'skipped (no APIFY_TOKEN)';            related_queries: relatedQueries,

  } else {            related_topics:  relatedTopics,

    diagnostics['tiktok']    = 'not yet implemented';            breakout:        Boolean(isBreakout),

    diagnostics['pinterest'] = 'not yet implemented';            scraped_at:      new Date(),

    diagnostics['google']    = 'not yet implemented';          },

  }        });

        total++;

  await job.updateProgress(70);      } catch { /* skip */ }

    }

  // ── Embed new live_trends records ─────────────────────────────────────────  } catch (err: any) {

  try {    logger.warn({ err: err.message }, "Google Trends scrape failed");

    const { embedNewTrends } = await import('../services/vector/embedding.service');  }

    await embedNewTrends();

  } catch (err: any) {  logger.info({ total }, "Google Trends global scrape complete");

    logger.warn({ err: err.message }, 'Embedding step failed — non-fatal');  return total;

  }}



  await job.updateProgress(85);// ════════════════════════════════════════════════════════════════════════════

// NORMALISATION: Push top signals from all raw tables into live_trends

  // ── Pre-warm hot windows ───────────────────────────────────────────────────// YouTube is already written directly to live_trends so not included here

  await preWarmHotWindows();// ════════════════════════════════════════════════════════════════════════════



  // ── Cleanup expired raw data ───────────────────────────────────────────────async function normaliseIntoLiveTrends(): Promise<number> {

  await cleanupExpired();  let upserted = 0;

  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12h — refreshed every 3h anyway

  await job.updateProgress(100);  const cutoff    = new Date(Date.now() - 3 * 60 * 60 * 1000);  // last 3h window



  const summary = { youtube, reddit, tiktok, pinterest, google, diagnostics };  // ── Reddit top posts → live_trends ─────────────────────────────────────────

  logger.info(summary, 'Discovery worker complete');  const topReddit = await (prisma as any).discovery_reddit_raw.findMany({

  return summary;    where:   { scraped_at: { gt: cutoff }, velocity: { gte: 60 } },

}    orderBy: { velocity: "desc" },

    take:    150,

// ── Worker lifecycle ──────────────────────────────────────────────────────────  });



export async function startDiscoveryWorker(): Promise<Worker | null> {  for (const r of topReddit) {

  if (process.env.DISCOVERY_WORKER_ENABLED === 'false') {    try {

    logger.info('Discovery worker disabled');      await (prisma as any).live_trends.upsert({

    return null;        where:  { title_source: { title: r.title.substring(0, 200), source: "reddit" } },

  }        create: {

          title:          r.title.substring(0, 200),

  worker = new Worker('discovery-queue', processJob, {          source:         "reddit",

    connection:  getConnection(),          search_volume:  r.score,

    concurrency: 1,          velocity:       r.velocity,

  });          badge:          r.is_breakout ? "HOT" : r.velocity >= 75 ? "HOT" : r.velocity >= 60 ? "RISING" : "NEW",

          niche_tags:     [],   // Groq will interpret at synthesis time

  worker.on('completed', (job, result) => {          platform_tags:  ["reddit"],

    logger.info({ jobId: job.id, ...result }, 'Discovery job completed');          recommendation: `${r.score} upvotes · ${r.num_comments} comments · r/${r.subreddit} ${r.feed}`,

  });          expires_at:     expiresAt,

  worker.on('failed', (job, err) => {          fetched_at:     new Date(),

    logger.error({ jobId: job?.id, err: err.message }, 'Discovery job failed');          raw_data:       { post_id: r.post_id, subreddit: r.subreddit, age_hours: r.age_hours, flair: r.flair },

  });        },

  worker.on('error', err => {        update: {

    logger.error({ err: err.message }, 'Discovery worker error');          search_volume:  r.score,

  });          velocity:       r.velocity,

          badge:          r.is_breakout ? "HOT" : r.velocity >= 75 ? "HOT" : r.velocity >= 60 ? "RISING" : "NEW",

  logger.info('Discovery worker started');          recommendation: `${r.score} upvotes · ${r.num_comments} comments · r/${r.subreddit} ${r.feed}`,

  return worker;          expires_at:     expiresAt,

}          fetched_at:     new Date(),

        },

export async function stopDiscoveryWorker(): Promise<void> {      });

  if (worker) {      upserted++;

    await worker.close();    } catch { /* skip */ }

    worker = null;  }

    logger.info('Discovery worker stopped');

  }  // ── TikTok top videos → live_trends ─────────────────────────────────────────

}  const topTikTok = await (prisma as any).discovery_tiktok_raw.findMany({

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

    // Check Apify quota before attempting scrapes
    const quotaOk = await checkApifyQuota(client);
    if (!quotaOk) {
      diagnostics["tiktok"]       = "skipped: monthly quota exhausted";
      diagnostics["pinterest"]    = "skipped: monthly quota exhausted";
      diagnostics["googleTrends"] = "skipped: monthly quota exhausted";
    } else {
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
  }

  await job.updateProgress(70);

  // ── Normalise all raw tables into live_trends ─────────────────────────────
  const normalised = await normaliseIntoLiveTrends();
  diagnostics["normalised"] = `${normalised} signals in live_trends`;

  await job.updateProgress(90);

  // ── Pre-warm trend hot windows for all niches ─────────────────────────────
  // This ensures the first request after a discovery run hits Redis in <5ms
  try {
    const { hybridRetrieve } = await import("../services/retrieval/hybrid-rag.service");
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
        /* non-fatal — continue with next niche */
      }
    }
    logger.info({ niches: NICHES.length }, "Trend hot windows pre-warmed");
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Trend hot window pre-warm failed — non-fatal",
    );
  }

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
