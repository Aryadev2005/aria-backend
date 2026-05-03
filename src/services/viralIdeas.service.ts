import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import axios from "axios";
import { logger } from "../utils/logger";
import { _callGroq } from "./ai/groq.service";

const execFileAsync = promisify(execFile);

export interface ViralIdea {
  id: string;
  title: string;
  contentAngle: string;       // "How to make a 'Quiet Luxury on ₹500' Reel"
  whyNow: string;             // Why this is about to blow up
  formatSuggestion: string;   // "Reel", "Carousel", "Short"
  velocityScore: number;      // 0-100
  badge: "HOT" | "RISING" | "NEW";
  growthSignal: string;       // "+2400%" or "Breakout"
  geo: string;                // "GLOBAL" or specific region
  source: string;
  niche: string;
}

// ── Step 1: Pull rising signals from pytrends (global) ──────────────────────
async function fetchRisingSignals(niche: string): Promise<any[]> {
  const scriptPath = path.join(
    __dirname,
    "../../scripts/fetch_viral_ideas.py"
  );

  try {
    const { stdout } = await execFileAsync(
      "python3",
      [scriptPath, niche],
      { timeout: 90000, maxBuffer: 5 * 1024 * 1024 }
    );

    const data = JSON.parse(stdout);
    if (data.error) {
      logger.warn({ error: data.error, niche }, "pytrends rising signals failed");
      return [];
    }

    logger.info({ count: data.ideas?.length, niche }, "Rising signals fetched");
    return data.ideas || [];
  } catch (err: any) {
    logger.warn({ err: err.message, niche }, "fetch_viral_ideas.py failed");
    return [];
  }
}

// ── Step 2: Pull YouTube global trending for niche ───────────────────────────
async function fetchYouTubeGlobalSignals(niche: string): Promise<any[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];

  // Map niche to YouTube category IDs
  const CATEGORY_MAP: Record<string, string> = {
    fashion: "26",      // How-to & Style
    beauty: "26",
    fitness: "17",      // Sports
    food: "26",
    tech: "28",         // Science & Technology
    gaming: "20",
    comedy: "23",
    music: "10",
    education: "27",
    travel: "19",
    general: "22",      // People & Blogs
  };

  const categoryId = CATEGORY_MAP[niche] || "22";

  try {
    // Fetch globally trending (no regionCode = worldwide)
    const response = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          part: "snippet,statistics",
          chart: "mostPopular",
          videoCategoryId: categoryId,
          maxResults: 20,
          key: apiKey,
        },
        timeout: 10000,
      }
    );

    const videos = response.data?.items || [];

    return videos.map((v: any) => ({
      title: v.snippet?.title || "",
      channel: v.snippet?.channelTitle || "",
      views: parseInt(v.statistics?.viewCount || "0"),
      likes: parseInt(v.statistics?.likeCount || "0"),
      publishedAt: v.snippet?.publishedAt,
      source: "youtube_global_trending",
      niche,
    }));
  } catch (err: any) {
    logger.warn({ err: err.message }, "YouTube global fetch failed");
    return [];
  }
}

// ── Step 3: Use Groq to synthesize real signals → 10 actionable ideas ────────
async function synthesizeIdeas(
  risingSignals: any[],
  ytSignals: any[],
  niche: string,
  platform: string,
  archetype: string | null,
  followerRange: string
): Promise<ViralIdea[]> {
  const signalContext = [
    risingSignals.length > 0
      ? `GOOGLE GLOBAL RISING QUERIES (last 7 days, breakout signals):\n${risingSignals
          .slice(0, 10)
          .map(
            (s) =>
              `- "${s.title}" | growth: ${s.growth_value} | seed: ${s.seed_keyword}`
          )
          .join("\n")}`
      : "Google signals unavailable",

    ytSignals.length > 0
      ? `\nYOUTUBE GLOBAL TRENDING (${niche}):\n${ytSignals
          .slice(0, 8)
          .map((v) => `- "${v.title}" by ${v.channel} | ${v.views.toLocaleString()} views`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `You are ARIA — India's creator intelligence engine. 

You have REAL data from Google Trends and YouTube about what's rising GLOBALLY right now.
Your job: Turn these raw signals into 10 specific, actionable content IDEAS for this creator.

CREATOR PROFILE:
- Niche: ${niche}
- Platform: ${platform}
- Followers: ${followerRange}
- Archetype: ${archetype || "Creator"}

REAL LIVE SIGNALS (use ONLY these — do not invent):
${signalContext}

RULES:
1. Each idea must be DIRECTLY inspired by one of the signals above
2. Give a specific content angle — not just the trend topic but HOW to make the video
3. Explain WHY this is about to go viral in the next 48-72 hours
4. Be specific to Indian creators and Indian context where relevant
5. If a signal has "Breakout" growth, mark it HOT. >500% = RISING. Rest = NEW
6. Do NOT invent trends not in the signals

Respond ONLY with valid JSON:
{
  "ideas": [
    {
      "title": "The trend topic name (short, max 8 words)",
      "contentAngle": "Specific video concept e.g. 'POV: I tried the viral XYZ trend on ₹200 budget'",
      "whyNow": "1 sentence: why this is about to blow up in 48-72 hours",
      "formatSuggestion": "Reel|Carousel|Short|Video",
      "velocityScore": 92,
      "badge": "HOT|RISING|NEW",
      "growthSignal": "+2400% this week",
      "geo": "GLOBAL",
      "source": "google_rising + youtube_trending",
      "niche": "${niche}"
    }
  ]
}`;

  const result = await _callGroq(prompt, { useLlama: true, maxTokens: 2000 });

  if (!result?.ideas || !Array.isArray(result.ideas)) {
    logger.warn("Groq returned invalid ideas structure");
    return [];
  }

  // Add stable IDs
  return result.ideas.slice(0, 10).map((idea: any, idx: number) => ({
    ...idea,
    id: `idea_${niche}_${Date.now()}_${idx}`,
  }));
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function generateViralIdeas(params: {
  niche: string;
  platform: string;
  archetype: string | null;
  followerRange: string;
}): Promise<ViralIdea[]> {
  const { niche, platform, archetype, followerRange } = params;

  logger.info({ niche }, "Generating viral ideas");

  // Run both fetches in parallel
  const [risingSignals, ytSignals] = await Promise.allSettled([
    fetchRisingSignals(niche),
    fetchYouTubeGlobalSignals(niche),
  ]);

  const signals = risingSignals.status === "fulfilled" ? risingSignals.value : [];
  const yt = ytSignals.status === "fulfilled" ? ytSignals.value : [];

  if (signals.length === 0 && yt.length === 0) {
    logger.warn({ niche }, "No signals from any source — returning empty");
    return [];
  }

  return synthesizeIdeas(signals, yt, niche, platform, archetype, followerRange);
}
