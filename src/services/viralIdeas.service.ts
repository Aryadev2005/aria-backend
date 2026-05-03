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

export interface ResolvedNicheTargets {
  subreddits: string[];
  youtubeQueries: string[];
  resolvedNicheLabel: string;
}

export interface UserNicheContext {
  niches: string[];
  archetype: string | null;
  archetypeLabel: string | null;
  instagramHandle: string | null;
  bio: string | null;
  topHashtags: string[];
  brandCategories: string[];
  archetypeEmoji: string | null;
  contentPatterns: any;
}

const HTTP = axios.create({
  timeout: 12000,
  headers: { "User-Agent": "AriaBot/1.0 (content intelligence)" },
});

// ── Step 1: Groq resolves infinite niches → subreddits + YouTube queries ──────
async function resolveNicheTargets(
  ctx: UserNicheContext
): Promise<ResolvedNicheTargets> {
  const prompt = `You are a social media trend research expert.

Given this creator's full profile, determine the BEST subreddits and YouTube search queries
to find trending content signals for their specific niche.

CREATOR PROFILE:
- Instagram handle: ${ctx.instagramHandle || "unknown"}
- Detected niches: ${ctx.niches.join(", ") || "unknown"}
- Archetype: ${ctx.archetypeLabel || ctx.archetype || "Creator"}
- Bio: ${ctx.bio || "not available"}
- Top hashtags they use: ${ctx.topHashtags.length > 0 ? ctx.topHashtags.join(", ") : "not available"}
- Brand categories: ${ctx.brandCategories.length > 0 ? ctx.brandCategories.join(", ") : "not available"}
- Content patterns: ${ctx.contentPatterns ? JSON.stringify(ctx.contentPatterns).slice(0, 200) : "not available"}

YOUR TASK:
1. Understand what this creator ACTUALLY makes — look at handle, hashtags, bio together
2. Return 5-7 highly specific subreddits where their target audience discusses related topics
3. Return 3-4 YouTube search queries that would find trending videos in their exact niche
4. Return a clean resolved niche label (what they actually create)

RULES FOR SUBREDDITS:
- Must be real, active subreddits with significant traffic
- Be SPECIFIC to the creator's actual niche — not generic
- Mix: 2-3 niche-specific + 1-2 broader interest + 1 India-specific if relevant
- For movie/book/media creators: include fandom subreddits
- For fashion: include style + shopping subreddits
- For food: include cooking + Indian food subreddits
- For fitness: include workout + health subreddits
- NEVER return r/india or r/worldnews for non-news niches

RULES FOR YOUTUBE QUERIES:
- Be specific to their niche, not generic "trending 2025"
- Include Indian context where relevant
- Focus on what's currently popular in their space

Respond ONLY with valid JSON:
{
  "subreddits": ["malefashionadvice", "streetwear", "frugalmalefashion", "IndianFashion", "femalefashionadvice"],
  "youtubeQueries": ["men outfit ideas trending 2025", "streetwear haul india"],
  "resolvedNicheLabel": "Men's Fashion & Streetwear Creator"
}`;

  try {
    const result = await _callGroq(prompt, {
      useLlama: true,
      maxTokens: 500,
    });

    if (!result?.subreddits || !Array.isArray(result.subreddits)) {
      throw new Error("Invalid niche resolution response");
    }

    logger.info(
      {
        subreddits: result.subreddits,
        resolvedNiche: result.resolvedNicheLabel,
      },
      "Niche resolved"
    );

    return {
      subreddits: result.subreddits.slice(0, 7),
      youtubeQueries: result.youtubeQueries?.slice(0, 4) ?? [],
      resolvedNicheLabel: result.resolvedNicheLabel ?? ctx.niches[0] ?? "general",
    };
  } catch (err: any) {
    logger.warn({ err: err.message }, "Niche resolution failed — using fallback");
    return {
      subreddits: ["india", "popular", "InternetIsBeautiful"],
      youtubeQueries: [`${ctx.niches[0] || "content"} trending 2025`],
      resolvedNicheLabel: ctx.niches[0] ?? "general",
    };
  }
}

// ── Step 2: Reddit Rising + Hot with dynamic subreddits ───────────────────────
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

          // No score filter — rising feed means Reddit already flagged it
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
            source:      `reddit_r/${sub}_${feed}`,
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

  ideas.sort((a, b) => b.velocity - a.velocity);
  logger.info({ count: ideas.length }, "Reddit signals collected");
  return ideas.slice(0, 12);
}

// ── Step 3: YouTube trending India with dynamic queries ───────────────────────
async function fetchYouTubeSignals(
  youtubeQueries: string[],
  niche: string
): Promise<any[]> {
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
  };

  const categoryId = YT_CATEGORY[niche.toLowerCase()] ?? "22";
  const results: any[] = [];

  // Attempt 1: mostPopular India with category
  try {
    const { data } = await HTTP.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "snippet,statistics",
          chart: "mostPopular",
          regionCode: "IN",
          videoCategoryId: categoryId,
          maxResults: 10,
          key: apiKey,
        },
      }
    );

    const items: any[] = data?.items ?? [];
    results.push(...items.map((v: any) => ({
      title:   (v.snippet?.title ?? "").trim(),
      channel: v.snippet?.channelTitle ?? "",
      views:   parseInt(v.statistics?.viewCount ?? "0"),
      source:  "youtube_trending_IN",
    })));

    logger.info({ count: results.length }, "YouTube trending signals collected");
  } catch (err: any) {
    if (err.response?.status === 403) {
      logger.warn("YouTube API key restricted — skipping YouTube source");
      return [];
    }
    // Try without category
    try {
      const { data } = await HTTP.get(
        "https://www.googleapis.com/youtube/v3/videos",
        {
          params: {
            part: "snippet,statistics",
            chart: "mostPopular",
            regionCode: "IN",
            maxResults: 10,
            key: apiKey,
          },
        }
      );
      results.push(...(data?.items ?? []).map((v: any) => ({
        title:   (v.snippet?.title ?? "").trim(),
        channel: v.snippet?.channelTitle ?? "",
        views:   parseInt(v.statistics?.viewCount ?? "0"),
        source:  "youtube_trending_IN_general",
      })));
    } catch {
      logger.warn({ niche }, "YouTube trending fallback also failed");
    }
  }

  return results;
}

// ── Step 4: Groq synthesizes signals → 10 viral ideas ────────────────────────
async function synthesizeIdeas(
  redditSignals:    any[],
  ytSignals:        any[],
  resolvedNiche:    string,
  originalNiches:   string[],
  platform:         string,
  archetype:        string | null,
  followerRange:    string,
): Promise<ViralIdea[]> {

  const redditCtx = redditSignals.length > 0
    ? `REDDIT SIGNALS (real posts trending right now):\n` +
      redditSignals.slice(0, 10).map(
        (s) => `- "${s.title}" | ${s.growthSignal} | ${s.ageHours}h ago | source: ${s.source}`
      ).join("\n")
    : "No Reddit signals available";

  const ytCtx = ytSignals.length > 0
    ? `\nYOUTUBE TRENDING INDIA:\n` +
      ytSignals.slice(0, 8).map(
        (v) => `- "${v.title}" by ${v.channel} | ${v.views.toLocaleString("en-IN")} views`
      ).join("\n")
    : "";

  const prompt = `You are ARIA — India's creator intelligence engine.

You have REAL live data showing what people are actively talking about RIGHT NOW.
Turn these into 10 specific, actionable content IDEAS for this creator.

CREATOR PROFILE:
- Resolved niche: ${resolvedNiche}
- Original detected niches: ${originalNiches.join(", ")}
- Platform: ${platform}
- Followers: ${followerRange}
- Archetype: ${archetype || "Creator"}

LIVE SIGNALS:
${redditCtx}${ytCtx}

RULES:
1. Each idea must be DIRECTLY inspired by a signal above
2. Content angle must be SPECIFIC — exact video concept, not a vague topic
3. Use Indian context — ₹ prices, Indian brands, Indian culture where relevant
4. WhyNow must explain the 48-72h urgency — reference the actual signal
5. HOT = breakout/top signal or <6h old. RISING = strong growth. NEW = emerging
6. Format: Reel for quick trends, Carousel for educational, Short for challenges, Video for deep dives
7. MUST be relevant to the creator's resolved niche: ${resolvedNiche}

Respond ONLY with valid JSON:
{
  "ideas": [
    {
      "title": "Trend name max 8 words",
      "contentAngle": "Exact video concept e.g. 'POV: I tried the viral XYZ trend on ₹999 budget'",
      "whyNow": "One sentence urgency tied to the actual signal",
      "formatSuggestion": "Reel|Carousel|Short|Video",
      "velocityScore": 88,
      "badge": "HOT|RISING|NEW",
      "growthSignal": "2.4K upvotes in 3h on r/malefashionadvice",
      "geo": "GLOBAL",
      "source": "reddit_rising",
      "niche": "${resolvedNiche}"
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
    id: `idea_${resolvedNiche.replace(/\s+/g, "_")}_${Date.now()}_${idx}`,
  }));
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function generateViralIdeas(params: {
  niche:          string;
  platform:       string;
  archetype:      string | null;
  followerRange:  string;
  userContext:    UserNicheContext;
}): Promise<ViralIdea[]> {
  const { platform, archetype, followerRange, userContext } = params;

  logger.info({ niches: userContext.niches }, "Starting viral ideas generation");

  // Step 1: Resolve infinite niche → specific subreddits + YouTube queries
  const targets = await resolveNicheTargets(userContext);

  logger.info({
    resolvedNiche: targets.resolvedNicheLabel,
    subreddits: targets.subreddits,
    youtubeQueries: targets.youtubeQueries,
  }, "Niche targets resolved");

  // Step 2: Fetch signals in parallel
  const [redditResult, ytResult] = await Promise.allSettled([
    fetchRedditSignals(targets.subreddits),
    fetchYouTubeSignals(targets.youtubeQueries, userContext.niches[0] ?? "general"),
  ]);

  const reddit  = redditResult.status === "fulfilled" ? redditResult.value : [];
  const youtube = ytResult.status     === "fulfilled" ? ytResult.value     : [];

  logger.info({
    reddit:  reddit.length,
    youtube: youtube.length,
    total:   reddit.length + youtube.length,
  }, "Signals collected — synthesizing ideas");

  // Step 3: Synthesize — always proceeds even with 0 signals
  return synthesizeIdeas(
    reddit,
    youtube,
    targets.resolvedNicheLabel,
    userContext.niches,
    platform,
    archetype,
    followerRange,
  );
}
