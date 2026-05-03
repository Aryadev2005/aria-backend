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

export interface UserNicheContext {
  niches: string[];
  archetype: string | null;
  archetypeLabel: string | null;
  instagramHandle: string | null;
  bio: string | null;
  topHashtags: string[];
  brandCategories: string[];
  contentPatterns: any;
}

// Browser User-Agent — Reddit blocks server User-Agents like "axios/1.x"
const HTTP = axios.create({
  timeout: 12000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
  },
});

// ── Source 1: Reddit Rising + Hot ────────────────────────────────────────────
async function fetchRedditSignals(subreddits: string[]): Promise<any[]> {
  const ideas: any[] = [];
  const seen = new Set<string>();
  const nowSec = Date.now() / 1000;

  for (const sub of subreddits.slice(0, 5)) {
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

          if (ageHours > 72) continue;

          const key = title.toLowerCase().slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);

          const recencyBoost = ageHours < 6 ? 15 : ageHours < 24 ? 8 : 0;
          const velocity = Math.min(95, Math.round(
            ratio * 35 +
            Math.min(score, 500) / 500 * 25 +
            Math.min(comments, 200) / 200 * 25 +
            recencyBoost
          ));

          ideas.push({
            title,
            source:       `reddit_r/${sub}_${feed}`,
            velocity:     Math.max(55, velocity),
            growthSignal: score > 0
              ? `${score} upvotes · ${comments} comments`
              : `${comments} comments · ${ageHours.toFixed(1)}h ago`,
            isBreakout:   score > 200 && ageHours < 6,
            ageHours:     Math.round(ageHours * 10) / 10,
            geo:          "GLOBAL",
          });
        }
      } catch (err: any) {
        logger.warn({ sub, feed, err: err.message }, "Reddit fetch failed");
      }
    }
  }

  ideas.sort((a, b) => b.velocity - a.velocity);
  logger.info({ count: ideas.length, subreddits }, "Reddit signals collected");
  return ideas.slice(0, 12);
}

// ── Source 2: YouTube mostPopular India ──────────────────────────────────────
async function fetchYouTubeSignals(niche: string): Promise<any[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  const YT_CATEGORY: Record<string, string> = {
    "fashion": "26", "mens fashion": "26", "womens fashion": "26",
    "beauty": "26",  "fitness": "17",      "food": "26",
    "tech": "28",    "gaming": "20",       "comedy": "23",
    "music": "10",   "education": "27",    "travel": "19",
    "cricket": "17", "bollywood": "24",    "hustle": "22",
    "wellness": "22","general": "22",      "books": "26",
    "edits": "24",   "dance": "17",        "lifestyle": "22",
    "startup": "22", "motivation": "22",   "finance": "22",
  };

  const categoryId = YT_CATEGORY[niche.toLowerCase()] ?? "22";

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
            part:       "snippet,statistics",
            chart:      "mostPopular",
            maxResults: 15,
            key:        apiKey,
            ...params,
          },
        }
      );

      const items: any[] = data?.items ?? [];
      if (items.length === 0) continue;

      logger.info({ count: items.length, niche }, "YouTube signals collected");
      return items.map((v: any) => ({
        title:   (v.snippet?.title ?? "").trim(),
        channel: v.snippet?.channelTitle ?? "",
        views:   parseInt(v.statistics?.viewCount ?? "0"),
        source:  "youtube_trending_IN",
      }));

    } catch (err: any) {
      if (err.response?.status === 403) {
        logger.warn("YouTube API 403 — key restricted, skipping");
        return [];
      }
      logger.warn({ err: err.message, params }, "YouTube attempt failed");
    }
  }
  return [];
}

// ── Single Groq call: resolves subreddits + synthesizes 10 ideas ─────────────
// Merging niche resolution + idea synthesis into ONE call to avoid rate limits
async function resolveAndSynthesize(
  redditSignals: any[],
  ytSignals:     any[],
  ctx:           UserNicheContext,
  platform:      string,
  followerRange: string,
): Promise<ViralIdea[]> {

  const redditCtx = redditSignals.length > 0
    ? `REDDIT SIGNALS (real posts trending right now):\n` +
      redditSignals.slice(0, 10).map(
        s => `- "${s.title}" | ${s.growthSignal} | ${s.ageHours}h ago`
      ).join("\n")
    : "No Reddit signals available";

  const ytCtx = ytSignals.length > 0
    ? `\nYOUTUBE TRENDING INDIA:\n` +
      ytSignals.slice(0, 8).map(
        v => `- "${v.title}" by ${v.channel} | ${v.views.toLocaleString("en-IN")} views`
      ).join("\n")
    : "";

  const prompt = `You are ARIA — India's creator intelligence engine.

CREATOR PROFILE:
- Instagram handle: ${ctx.instagramHandle || "unknown"}
- Detected niches: ${ctx.niches.join(", ") || "unknown"}
- Archetype: ${ctx.archetypeLabel || ctx.archetype || "Creator"}
- Bio: ${ctx.bio || "not available"}
- Top hashtags: ${ctx.topHashtags.length > 0 ? ctx.topHashtags.join(", ") : "not available"}
- Brand categories: ${ctx.brandCategories.length > 0 ? ctx.brandCategories.join(", ") : "not available"}
- Platform: ${platform}
- Followers: ${followerRange}

LIVE SIGNALS:
${redditCtx}${ytCtx}

YOUR TASK:
First understand what this creator ACTUALLY makes from their handle, bio, and hashtags.
Then generate 10 specific, actionable content IDEAS for them using the live signals above.

RULES:
1. Each idea must be inspired by the live signals (or current niche trends if signals unavailable)
2. Content angle must be SPECIFIC — exact video concept, not a vague topic
3. Use Indian context — ₹ prices, Indian brands (Myntra, Meesho, Nykaa, Zerodha), Indian culture
4. WhyNow must explain the 48-72h urgency tied to actual signals
5. HOT = breakout signal or <6h old. RISING = strong growth. NEW = emerging
6. MUST match what this creator actually makes — not generic content
7. Format: Reel for quick trends, Carousel for educational, Short for challenges, Video for deep dives

Respond ONLY with valid JSON:
{
  "resolvedNiche": "what this creator actually makes in 5 words",
  "ideas": [
    {
      "title": "Trend name max 8 words",
      "contentAngle": "Exact video concept",
      "whyNow": "One sentence urgency tied to actual signal",
      "formatSuggestion": "Reel|Carousel|Short|Video",
      "velocityScore": 88,
      "badge": "HOT|RISING|NEW",
      "growthSignal": "actual signal e.g. '2.4K upvotes in 3h on r/Entrepreneur'",
      "geo": "GLOBAL",
      "source": "reddit_rising",
      "niche": "resolved niche"
    }
  ]
}`;

  const result = await _callGroq(prompt, { useLlama: false, maxTokens: 2500 });

  if (!result?.ideas || !Array.isArray(result.ideas)) {
    logger.warn({ result }, "Groq returned invalid ideas structure");
    return [];
  }

  logger.info({ resolvedNiche: result.resolvedNiche }, "Niche resolved by Groq");

  return result.ideas.slice(0, 10).map((idea: any, idx: number) => ({
    ...idea,
    id: `idea_${Date.now()}_${idx}`,
  }));
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function generateViralIdeas(params: {
  platform:      string;
  followerRange: string;
  userContext:   UserNicheContext;
}): Promise<ViralIdea[]> {
  const { platform, followerRange, userContext } = params;

  logger.info({ niches: userContext.niches, handle: userContext.instagramHandle }, "Generating viral ideas");

  // Default subreddits — Groq will contextualize signals for the actual niche
  // No hardcoded niche→subreddit map — Groq does the interpretation
  const DEFAULT_SUBREDDITS = [
    "india", "Entrepreneur", "startups", "malefashionadvice",
    "SkincareAddiction", "fitness", "food", "technology",
    "bollywood", "cricket", "AskIndia", "IndiaInvestments",
  ];

  // Fetch signals in parallel — single Groq call handles everything after
  const [redditResult, ytResult] = await Promise.allSettled([
    fetchRedditSignals(DEFAULT_SUBREDDITS),
    fetchYouTubeSignals(userContext.niches[0] ?? "general"),
  ]);

  const reddit  = redditResult.status === "fulfilled" ? redditResult.value : [];
  const youtube = ytResult.status     === "fulfilled" ? ytResult.value     : [];

  logger.info({
    reddit:  reddit.length,
    youtube: youtube.length,
    total:   reddit.length + youtube.length,
  }, "Signals collected — single Groq synthesis");

  return resolveAndSynthesize(reddit, youtube, userContext, platform, followerRange);
}
