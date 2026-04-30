import axios from "axios";
import { prisma } from "../config/database";
import { logger } from "../utils/logger";
import { fetchGoogleTrends } from "../services/googleTrends.service";
import { fetchYouTubeTrending } from "../services/youtubeTrending.service";

// ARIA Trend Worker — Real data pipeline
// Scheduling is handled by setInterval in src/config/queue.js

// ─── Niche keyword auto-tagger ─────────────────────────────────────────────
const NICHE_KEYWORDS: Record<string, string[]> = {
  fashion: [
    "fashion",
    "outfit",
    "ootd",
    "style",
    "clothing",
    "wear",
    "dress",
    "nykaa",
    "myntra",
  ],
  fitness: [
    "fitness",
    "gym",
    "workout",
    "health",
    "yoga",
    "diet",
    "weight",
    "muscle",
  ],
  food: [
    "food",
    "recipe",
    "cooking",
    "restaurant",
    "biryani",
    "chef",
    "eat",
    "zomato",
  ],
  cricket: ["cricket", "ipl", "bcci", "virat", "rohit", "match", "wicket"],
  bollywood: [
    "bollywood",
    "film",
    "movie",
    "actor",
    "actress",
    "song",
    "trailer",
  ],
  tech: ["tech", "ai", "startup", "app", "phone", "iphone", "gadget", "review"],
  finance: [
    "finance",
    "stock",
    "market",
    "investment",
    "mutual",
    "crypto",
    "money",
    "zerodha",
    "groww",
  ],
  travel: [
    "travel",
    "trip",
    "tour",
    "destination",
    "hotel",
    "flight",
    "vacation",
  ],
  education: [
    "study",
    "exam",
    "upsc",
    "jee",
    "neet",
    "college",
    "learn",
    "tutorial",
  ],
  comedy: ["funny", "meme", "joke", "comedy", "viral", "laugh", "roast"],
  hustle: [
    "startup",
    "business",
    "entrepreneur",
    "side hustle",
    "shark tank",
    "income",
  ],
};

const FALLBACK_TRENDS = [
  {
    title: "Instagram Reels Strategy 2025",
    search_volume: 450000,
    velocity: 92,
    niche_tags: ["general"],
  },
  {
    title: "YouTube Shorts Growth India",
    search_volume: 380000,
    velocity: 88,
    niche_tags: ["general", "education"],
  },
  {
    title: "IPL 2025 Content Ideas",
    search_volume: 520000,
    velocity: 95,
    niche_tags: ["cricket", "comedy"],
  },
  {
    title: "AI Tools for Creators",
    search_volume: 410000,
    velocity: 90,
    niche_tags: ["tech", "education"],
  },
  {
    title: "Faceless YouTube Channel",
    search_volume: 350000,
    velocity: 85,
    niche_tags: ["hustle", "general"],
  },
  {
    title: "Myntra Summer Collection",
    search_volume: 320000,
    velocity: 82,
    niche_tags: ["fashion"],
  },
  {
    title: "Zerodha Options Trading",
    search_volume: 290000,
    velocity: 80,
    niche_tags: ["finance"],
  },
  {
    title: "Street Food Hyderabad",
    search_volume: 280000,
    velocity: 78,
    niche_tags: ["food", "travel"],
  },
];

const detectNiches = (text: string = ""): string[] => {
  const lower = text.toLowerCase();
  const niches = [];
  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) niches.push(niche);
  }
  return niches.length > 0 ? niches : ["general"];
};

// ─── Reddit India fallback ─────────────────────────────────────────────────
const fetchRedditTrends = async (): Promise<any[] | null> => {
  try {
    await new Promise((r) => setTimeout(r, 2000));
    const response = await axios.get(
      "https://www.reddit.com/r/india/hot.json?limit=10",
      {
        headers: { "User-Agent": "ARIA-TrendAI/1.0" },
        timeout: 10000,
      },
    );
    const posts = response.data?.data?.children || [];
    const trends = posts
      .map((post: any, idx: number) => ({
        title: post.data.title?.slice(0, 120) || "",
        search_volume: post.data.ups || 0,
        velocity: Math.max(50, 90 - idx * 5),
        niche_tags: detectNiches(post.data.title),
        source: "reddit",
      }))
      .filter((t: any) => t.title.length > 5);
    logger.info({ count: trends.length }, "Reddit trends fetched");
    return trends.length > 0 ? trends : null;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Reddit fetch failed");
    return null;
  }
};

export interface TrendJob {
  id: string;
  data: any;
}

export interface TrendData {
  title: string;
  search_volume: number;
  velocity: number;
  niche_tags: string[];
  source: string;
  raw_data?: any;
  platform_tags?: string[];
}

/**
 * Main job processor
 */
export const processTrendJob = async (job: TrendJob) => {
  let allTrends: TrendData[] = [];
  const sourceLog: string[] = [];

  try {
    logger.info({ jobId: job.id }, "Trend refresh job started");

    const googleTrends = await fetchGoogleTrends();
    if (googleTrends && googleTrends.length > 0) {
      const mapped: TrendData[] = googleTrends.map((t) => ({
        title: t.title,
        search_volume: t.search_volume || 0,
        velocity: t.velocity || 75,
        niche_tags: t.niche_tags || detectNiches(t.title),
        source: "google",
        raw_data: t,
      }));
      allTrends = allTrends.concat(mapped);
      sourceLog.push(`google:${mapped.length}`);
      logger.info({ count: mapped.length }, "Google Trends added to pipeline");
    }

    const youtubeTrends = await fetchYouTubeTrending();
    if (youtubeTrends && youtubeTrends.length > 0) {
      const mappedYoutube: TrendData[] = youtubeTrends.map((t) => ({
        ...t,
        platform_tags: t.platform_tags
          ? Object.keys(t.platform_tags).filter(
              (k) => (t.platform_tags as any)[k],
            )
          : ["youtube"],
      }));
      allTrends = allTrends.concat(mappedYoutube);
      sourceLog.push(`youtube:${youtubeTrends.length}`);
      logger.info(
        { count: youtubeTrends.length },
        "YouTube trending added to pipeline",
      );
    }

    if (allTrends.length < 10) {
      const redditTrends = await fetchRedditTrends();
      if (redditTrends) {
        allTrends = allTrends.concat(redditTrends as TrendData[]);
        sourceLog.push(`reddit:${redditTrends.length}`);
      }
    }

    if (allTrends.length === 0) {
      allTrends = FALLBACK_TRENDS.map((t) => ({ ...t, source: "fallback" }));
      sourceLog.push("fallback");
      logger.warn("All real sources failed — using static fallback trends");
    }

    // Deduplicate by title prefix
    const seen = new Set();
    allTrends = allTrends.filter((t) => {
      const key = t.title.toLowerCase().slice(0, 40);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    await prisma.live_trends.deleteMany({
      where: {
        fetched_at: { lt: new Date(Date.now() - 7 * 60 * 60 * 1000) },
        source: { in: ["google", "youtube", "reddit", "fallback"] },
      },
    });

    const insertPromises = allTrends.slice(0, 80).map(async (trend) => {
      const niches = trend.niche_tags || detectNiches(trend.title);
      const velocity = trend.velocity || 75;

      try {
        await prisma.live_trends.create({
          data: {
            source: trend.source,
            title: trend.title.slice(0, 200),
            search_volume: trend.search_volume || 0,
            velocity,
            niche_tags: niches,
            platform_tags: trend.platform_tags || ["instagram", "youtube"],
            raw_data: trend.raw_data || {},
            fetched_at: new Date(),
            expires_at: new Date(Date.now() + 7 * 60 * 60 * 1000),
          },
        });
      } catch {
        // Keep old ON CONFLICT DO NOTHING behavior
      }
    });

    await Promise.all(insertPromises);

    logger.info(
      { total: allTrends.length, sources: sourceLog.join(", "), jobId: job.id },
      "Trend refresh completed",
    );

    return {
      success: true,
      trendsInserted: allTrends.length,
      sources: sourceLog,
    };
  } catch (err) {
    logger.error({ err, jobId: job.id }, "Trend job failed");
    throw err;
  }
};

/**
 * Worker startup
 */
export const startTrendWorker = async () => {
  const TRENDS_ENABLED = process.env.TRENDS_ENABLED !== "false";
  if (!TRENDS_ENABLED) {
    logger.info("Trend worker disabled via TRENDS_ENABLED=false");
    return null;
  }
  logger.info("Trend processor ready (scheduled via setInterval in queue.js)");
  return null;
};
