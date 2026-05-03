import axios from "axios";
import { logger } from "../utils/logger";
import { _callGroq } from "./ai/groq.service";

export interface ViralIdea {
  id: string;
  title: string;
  contentAngle: string;
  whyNow: string;
  formatSuggestion: string;
  velocityScore: number;
  badge: "HOT" | "RISING" | "NEW";
  growthSignal: string;
  geo: string;
  source: string;
  niche: string;
}

// ── Niche → subreddits ────────────────────────────────────────────────────────
const NICHE_SUBREDDITS: Record<string, string[]> = {
  "mens fashion":   ["malefashionadvice", "streetwear", "mensfashion", "frugalmalefashion"],
  "womens fashion": ["femalefashionadvice", "streetwear", "fashionadvice"],
  "fashion":        ["malefashionadvice", "femalefashionadvice", "streetwear"],
  "beauty":         ["SkincareAddiction", "MakeupAddiction", "IndianSkincareAddicts"],
  "fitness":        ["fitness", "bodyweightfitness", "GYM"],
  "food":           ["IndianFood", "food", "Cooking", "EatCheapAndHealthy"],
  "tech":           ["technology", "gadgets", "artificial", "ChatGPT"],
  "finance":        ["IndiaInvestments", "personalfinance", "StockMarket"],
  "travel":         ["travel", "solotravel", "india"],
  "gaming":         ["gaming", "pcgaming", "mobilegaming", "IndianGaming"],
  "education":      ["GetStudying", "learnprogramming", "india"],
  "comedy":         ["funny", "memes", "india"],
  "cricket":        ["cricket", "IPL", "IndianCricket"],
  "wellness":       ["mentalhealth", "meditation", "selfimprovement"],
  "hustle":         ["Entrepreneur", "startups", "india", "digitalnomad"],
  "general":        ["india", "worldnews", "InternetIsBeautiful"],
};

// ── YouTube category IDs ──────────────────────────────────────────────────────
const YT_CATEGORY: Record<string, string> = {
  "fashion": "26", "mens fashion": "26", "womens fashion": "26",
  "beauty": "26",  "fitness": "17",      "food": "26",
  "tech": "28",    "gaming": "20",       "comedy": "23",
  "music": "10",   "education": "27",    "travel": "19",
  "cricket": "17", "bollywood": "24",    "hustle": "22",
  "wellness": "22","general": "22",
};

const HTTP = axios.create({
  timeout: 12000,
  headers: { "User-Agent": "AriaBot/1.0 (content intelligence)" },
});

// ── Source 1: Reddit Rising + Hot ─────────────────────────────────────────────
async function fetchRedditSignals(niche: string): Promise<any[]> {
  const subs = NICHE_SUBREDDITS[niche] ?? NICHE_SUBREDDITS["general"];
  const ideas: any[] = [];
  const seen = new Set<string>();
  const nowSec = Date.now() / 1000;

  for (const sub of subs.slice(0, 3)) {
    // Hit both rising and hot — rising first (fresher signals)
    for (const feed of ["rising", "hot"]) {
      try {
        const { data } = await HTTP.get(
          `https://www.reddit.com/r/${sub}/${feed}.json?limit=15&raw_json=1`
        );

        const posts: any[] = data?.data?.children ?? [];

        for (const { data: p } of posts) {
          const title: string = (p.title ?? "").trim();
          if (!title) continue;

          const score: number    = p.score ?? 0;
          const comments: number = p.num_comments ?? 0;
          const ratio: number    = p.upvote_ratio ?? 0.5;
          const ageHours: number = (nowSec - (p.created_utc ?? 0)) / 3600;

          // Only filter out very old posts — no score filter
          // Rising feed already means Reddit's algorithm flagged it
          if (ageHours > 72) continue;

          const key = title.toLowerCase().slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);

          // Velocity formula — weighted by recency + engagement quality
          const recencyBoost = ageHours < 6 ? 15 : ageHours < 24 ? 8 : 0;
          const velocity = Math.min(95, Math.round(
            ratio * 35 +
            Math.min(score, 500) / 500 * 25 +
            Math.min(comments, 200) / 200 * 25 +
            recencyBoost
          ));

          ideas.push({
            title,
            source:      `reddit_r/${sub}_${feed}`,
            niche,
            velocity:    Math.max(55, velocity),
            growthSignal: score > 0
              ? `${score} upvotes · ${comments} comments`
              : `${comments} comments · ${ageHours.toFixed(1)}h ago`,
            isBreakout:  score > 200 && ageHours < 6,
            ageHours:    Math.round(ageHours * 10) / 10,
            geo:         "GLOBAL",
          });
        }
      } catch (err: any) {
        logger.warn({ sub, feed, err: err.message }, "Reddit fetch failed");
      }
    }
  }

  // Sort by velocity desc, take top 12
  ideas.sort((a, b) => b.velocity - a.velocity);
  logger.info({ count: ideas.length, niche }, "Reddit signals collected");
  return ideas.slice(0, 12);
}

// ── Source 2: YouTube mostPopular India ───────────────────────────────────────
async function fetchYouTubeTrending(niche: string): Promise<any[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    logger.warn("YOUTUBE_API_KEY not set — skipping YouTube source");
    return [];
  }

  const categoryId = YT_CATEGORY[niche] ?? "22";

  // Attempt 1: with niche category
  // Attempt 2: without category (broader, always works if key is valid)
  const attempts = [
    { videoCategoryId: categoryId, regionCode: "IN" },
    { regionCode: "IN" },
  ];

  for (const params of attempts) {
    try {
      const { data } = await HTTP.get(
        "https://www.googleapis.com/youtube/v3/videos",
        {
          params: {
            part:      "snippet,statistics",
            chart:     "mostPopular",
            maxResults: 15,
            key:       apiKey,
            ...params,
          },
        }
      );

      const items: any[] = data?.items ?? [];
      if (items.length === 0) continue;

      logger.info({ count: items.length, niche, params }, "YouTube signals collected");

      return items.map((v: any) => ({
        title:   (v.snippet?.title ?? "").trim(),
        channel: v.snippet?.channelTitle ?? "",
        views:   parseInt(v.statistics?.viewCount ?? "0"),
        likes:   parseInt(v.statistics?.likeCount ?? "0"),
        source:  "youtube_trending_IN",
        niche,
      }));

    } catch (err: any) {
      const status = err.response?.status;

      if (status === 403) {
        // Key is restricted — no point retrying, log and exit
        logger.warn(
          "YouTube API key does not have YouTube Data API v3 access. " +
          "Enable it at console.cloud.google.com → APIs & Services → Enable APIs."
        );
        return [];
      }

      if (status === 400 && params.videoCategoryId) {
        // Category not valid for this region — try next attempt without category
        logger.warn({ categoryId, niche }, "YouTube category invalid — retrying without category");
        continue;
      }

      logger.warn({ err: err.message, status, niche }, "YouTube attempt failed");
    }
  }

  return [];
}

// ── Groq synthesis ────────────────────────────────────────────────────────────
async function synthesizeIdeas(
  redditSignals: any[],
  ytSignals:     any[],
  niche:         string,
  platform:      string,
  archetype:     string | null,
  followerRange: string,
): Promise<ViralIdea[]> {

  const redditCtx = redditSignals.length > 0
    ? `REDDIT SIGNALS (real posts trending right now):\n` +
      redditSignals.slice(0, 10).map(
        (s) => `- "${s.title}" | ${s.growthSignal} | ${s.ageHours}h ago | source: ${s.source}`
      ).join("\n")
    : "";

  const ytCtx = ytSignals.length > 0
    ? `\nYOUTUBE TRENDING INDIA RIGHT NOW:\n` +
      ytSignals.slice(0, 8).map(
        (v) => `- "${v.title}" by ${v.channel} | ${v.views.toLocaleString("en-IN")} views`
      ).join("\n")
    : "";

  const hasSignals = redditCtx || ytCtx;

  const signalContext = hasSignals
    ? [redditCtx, ytCtx].filter(Boolean).join("\n")
    : `No live signals available right now. Use your knowledge of what's currently trending in ${niche} globally.`;

  const prompt = `You are ARIA — India's creator intelligence engine.

You have REAL live data showing what people are actively talking about RIGHT NOW.
Turn these into 10 specific, actionable content IDEAS for this Indian creator.

CREATOR PROFILE:
- Niche: ${niche}
- Platform: ${platform}
- Followers: ${followerRange}
- Archetype: ${archetype || "Creator"}

LIVE SIGNALS:
${signalContext}

RULES:
1. Each idea must be directly inspired by a signal above
2. Content angle must be SPECIFIC — exact video concept, not a vague topic
3. Use Indian context — ₹ prices, Indian brands (Myntra, Meesho, Nykaa, Zerodha), Indian culture
4. WhyNow must explain the 48-72h urgency — reference the actual signal
5. HOT = breakout/top signal or <6h old. RISING = strong growth. NEW = emerging
6. Format: Reel for quick trends, Carousel for educational, Short for challenges

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "ideas": [
    {
      "title": "Trend name max 8 words",
      "contentAngle": "Exact video concept e.g. 'POV: Styling 3 fits under ₹999 from Meesho — people thought it was Zara'",
      "whyNow": "One sentence urgency tied to the actual signal",
      "formatSuggestion": "Reel|Carousel|Short|Video",
      "velocityScore": 88,
      "badge": "HOT|RISING|NEW",
      "growthSignal": "2.4K upvotes in 3h on r/malefashionadvice",
      "geo": "GLOBAL",
      "source": "reddit_rising",
      "niche": "${niche}"
    }
  ]
}`;

  const result = await _callGroq(prompt, { useLlama: true, maxTokens: 2000 });

  if (!result?.ideas || !Array.isArray(result.ideas)) {
    logger.warn({ result }, "Groq returned invalid ideas structure");
    return [];
  }

  return result.ideas.slice(0, 10).map((idea: any, idx: number) => ({
    ...idea,
    id: `idea_${niche.replace(/\s+/g, "_")}_${Date.now()}_${idx}`,
  }));
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function generateViralIdeas(params: {
  niche:         string;
  platform:      string;
  archetype:     string | null;
  followerRange: string;
}): Promise<ViralIdea[]> {
  const { niche, platform, archetype, followerRange } = params;

  logger.info({ niche }, "Fetching viral idea signals");

  // Run both sources in parallel
  const [redditResult, ytResult] = await Promise.allSettled([
    fetchRedditSignals(niche),
    fetchYouTubeTrending(niche),
  ]);

  const reddit  = redditResult.status === "fulfilled" ? redditResult.value : [];
  const youtube = ytResult.status     === "fulfilled" ? ytResult.value     : [];

  logger.info({
    reddit:  reddit.length,
    youtube: youtube.length,
    total:   reddit.length + youtube.length,
    niche,
  }, "Signals collected — sending to Groq");

  // Always proceed to Groq — even with 0 signals it uses its own knowledge
  return synthesizeIdeas(reddit, youtube, niche, platform, archetype, followerRange);
}
