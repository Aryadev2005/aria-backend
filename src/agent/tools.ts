// src/agent/tools.ts
// All 12 ARIA tools — each fetches live data, normalizes it, returns lean JSON.
// The agent (LLM) decides which tools to call based on the user's query.
// Raw API response never touches the LLM — only the normalized output does.

import axios from "axios";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../utils/logger";

import {
  normalizeYouTubeVideo,
  normalizeYouTubeChannel,
  normalizeYouTubeSearch,
  normalizeJioSaavnSongs,
  normalizeGoogleTrends,
  normalizeInstagramMedia,
  normalizeInstagramInsights,
  normalizeDBTrends,
  normalizeUserProfile,
  normalizeDBSongs,
} from "./normalizer";

const YT_KEY = process.env.YOUTUBE_API_KEY;
const YT_BASE = "https://www.googleapis.com/youtube/v3";

const isPrismaClient = (db: any) =>
  !!db && typeof db !== "function" && typeof db.$transaction === "function";

// ── TOOL 1: YouTube video stats ───────────────────────────────────────────────
export const getYouTubeVideoStats = tool(
  async ({ videoId }) => {
    try {
      const { data } = await axios.get(`${YT_BASE}/videos`, {
        params: {
          key: YT_KEY,
          id: videoId,
          part: "snippet,statistics,contentDetails",
        },
        timeout: 8000,
      });
      return JSON.stringify(normalizeYouTubeVideo(data));
    } catch (err: any) {
      return JSON.stringify({
        error: `YouTube video fetch failed: ${err.message}`,
      });
    }
  },
  {
    name: "get_youtube_video_stats",
    description:
      "Fetch real-time stats for a YouTube video: views, likes, comments, engagement rate, duration, tags, publish date. Use when user pastes a YouTube URL or asks about a specific video.",
    schema: z.object({
      videoId: z
        .string()
        .length(11)
        .describe("11-character YouTube video ID extracted from URL"),
    }),
  },
);

// ── TOOL 2: YouTube channel stats ─────────────────────────────────────────────
export const getYouTubeChannelStats = tool(
  async ({ channelId }) => {
    try {
      const { data } = await axios.get(`${YT_BASE}/channels`, {
        params: { key: YT_KEY, id: channelId, part: "snippet,statistics" },
        timeout: 8000,
      });
      return JSON.stringify(normalizeYouTubeChannel(data));
    } catch (err: any) {
      return JSON.stringify({ error: `Channel fetch failed: ${err.message}` });
    }
  },
  {
    name: "get_youtube_channel_stats",
    description:
      "Fetch a YouTube channel's subscriber count, total views, video count, and average views per video. Use for channel-level analysis or competitor research.",
    schema: z.object({
      channelId: z.string().describe("YouTube channel ID (starts with UC...)"),
    }),
  },
);

// ── TOOL 3: YouTube search (live competitor / trend research) ─────────────────
export const searchYouTube = tool(
  async ({ query, maxResults = 8 }) => {
    try {
      const { data } = await axios.get(`${YT_BASE}/search`, {
        params: {
          key: YT_KEY,
          q: query,
          part: "snippet",
          type: "video",
          order: "viewCount",
          regionCode: "IN",
          relevanceLanguage: "hi",
          maxResults,
        },
        timeout: 8000,
      });
      return JSON.stringify(normalizeYouTubeSearch(data));
    } catch (err: any) {
      return JSON.stringify({ error: `YouTube search failed: ${err.message}` });
    }
  },
  {
    name: "search_youtube",
    description:
      "Search YouTube for videos matching a topic, trend, or niche. Returns top results by view count. Use to research what's performing well on YouTube India for a given topic.",
    schema: z.object({
      query: z
        .string()
        .describe('Search query — e.g. "budget fashion haul india 2025"'),
      maxResults: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe("Number of results, default 8"),
    }),
  },
);

// ── TOOL 4: Spotify India trending tracks ─────────────────────────────────────
export const getSpotifyTrending = tool(
  async () => {
    try {
      // Fetch Spotify India Daily Charts via charts page
      const { data } = await axios.get(
        "https://charts.spotify.com/charts/view/regional-in-daily/latest",
        { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 12000 },
      );

      // Extract __NEXT_DATA__ which contains chart data
      const match = data.match(
        /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
      );
      if (!match) throw new Error("Could not extract Spotify chart data");

      const parsed = JSON.parse(match[1]);
      const entries = parsed?.props?.pageProps?.chartEntryData || [];
      const tracks = (entries as any[])
        .slice(0, 30)
        .map((e, i) => ({
          rank: i + 1,
          title: e.trackMetadata?.trackName,
          artist: (e.trackMetadata?.artists || [])
            .map((a: any) => a.name)
            .join(", "),
          streams: e.chartEntryData?.rankingMetric?.value || 0,
          peakRank: e.chartEntryData?.peakRank || i + 1,
        }))
        .filter((t) => t.title);

      return JSON.stringify({ source: "spotify_india_daily", tracks });
    } catch (err: any) {
      // Fallback: return empty, agent will try JioSaavn
      return JSON.stringify({
        source: "spotify_india_daily",
        tracks: [],
        error: err.message,
      });
    }
  },
  {
    name: "get_spotify_trending",
    description:
      "Fetch Spotify India daily trending tracks — real chart positions and stream counts. Use when user asks about trending music, audio for Reels, or BGM recommendations.",
    schema: z.object({}),
  },
);

// ── TOOL 5: JioSaavn trending (Indian music chart) ────────────────────────────
export const getJioSaavnTrending = tool(
  async () => {
    try {
      const { data } = await axios.get("https://www.jiosaavn.com/api.php", {
        params: {
          __call: "webapi.get",
          _format: "json",
          _marker: "0",
          ctx: "web6",
          n: 20,
          p: 1,
          query: "trending",
        },
        timeout: 10000,
      });
      const songs = (data.results || []).slice(0, 15);
      return JSON.stringify({
        source: "jiosaavn_trending",
        songs: normalizeJioSaavnSongs(songs),
      });
    } catch (err: any) {
      return JSON.stringify({
        source: "jiosaavn_trending",
        songs: [],
        error: err.message,
      });
    }
  },
  {
    name: "get_jiosaavn_trending",
    description:
      "Fetch JioSaavn India trending songs — specifically useful for Hindi/regional language music trends. Use alongside Spotify for comprehensive Indian music trend coverage.",
    schema: z.object({}),
  },
);

// ── TOOL 6: Google Trends (live search interest) ──────────────────────────────
export const getGoogleTrends = tool(
  async ({ keyword, geo = "IN", timeframe = "now 7-d" }) => {
    try {
      // @ts-ignore
      const googleTrends = await import("google-trends-api");
      const result = await googleTrends.interestOverTime({
        keyword,
        geo,
        startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      });
      const parsed = JSON.parse(result);
      return JSON.stringify({
        keyword,
        trend: normalizeGoogleTrends(parsed),
      });
    } catch (err: any) {
      return JSON.stringify({ error: `Google Trends failed: ${err.message}` });
    }
  },
  {
    name: "get_google_trends",
    description:
      "Get real-time Google search interest for a keyword in India. Returns trend direction (rising/falling), average interest (0-100), and peak. Use when user asks what's trending or for keyword research.",
    schema: z.object({
      keyword: z
        .string()
        .describe("Search keyword or topic to check trend for"),
      geo: z
        .string()
        .optional()
        .describe('Country code, default "IN" for India'),
      timeframe: z
        .string()
        .optional()
        .describe(
          'Timeframe: "now 1-d", "now 7-d", "today 1-m". Default "now 7-d"',
        ),
    }),
  },
);

// ── TOOL 7: Instagram personal analytics (Graph API) ─────────────────────────
export const getInstagramPersonalStats = tool(
  async ({ userId, accessToken, metric = "posts" }) => {
    try {
      const baseUrl = "https://graph.instagram.com";
      let endpoint, params;

      if (metric === "posts") {
        endpoint = `${baseUrl}/${userId}/media`;
        params = {
          fields:
            "id,media_type,timestamp,caption,like_count,comments_count,reach,saved,impressions,permalink",
          access_token: accessToken,
        };
      } else {
        endpoint = `${baseUrl}/${userId}/insights`;
        params = {
          metric:
            "reach,impressions,profile_views,follower_count,website_clicks,email_contacts",
          access_token: accessToken,
        };
      }

      const { data: response } = await axios.get(endpoint, {
        params,
        timeout: 10000,
      });

      return JSON.stringify({
        metric,
        data:
          metric === "posts"
            ? normalizeInstagramMedia(response)
            : normalizeInstagramInsights(response),
      });
    } catch (err: any) {
      return JSON.stringify({
        error: `Instagram Graph API failed: ${err.message}`,
      });
    }
  },
  {
    name: "get_instagram_personal_stats",
    description:
      "Fetch the creator's own Instagram post performance and account insights via Instagram Graph API. Only works if user has connected their Instagram Business account. Use for personal analytics questions.",
    schema: z.object({
      userId: z.string().describe("Instagram user ID from DB"),
      accessToken: z
        .string()
        .describe("Instagram Graph API access token from DB"),
      metric: z
        .enum(["posts", "insights"])
        .optional()
        .describe(
          '"posts" for media performance, "insights" for account-level metrics',
        ),
    }),
  },
);

// ── TOOL 8: User personal profile from ARIA DB ────────────────────────────────
export const getUserProfile = tool(
  async ({ userId, db }: any) => {
    try {
      let user: any = null;
      let memoryRows: any[] = [];
      let igConnection: any = null;

      if (isPrismaClient(db)) {
        user = await (db.users as any).findUnique({
          where: { id: userId },
          select: {
            id: true,
            name: true,
            archetype: true,
            archetype_label: true,
            niches: true,
            primary_platform: true,
            instagram_handle: true,
            youtube_handle: true,
            follower_range: true,
            follower_count: true,
            engagement_rate: true,
            health_score: true,
            growth_stage: true,
            tone_profile: true,
            creator_intent: true,
            aria_confirmed_niche: true,
            scraped_summary: true,        // ADDED — real Instagram data
            aria_last_analysis: true,     // ADDED — ARIA's own profile analysis
            aria_analyzed_at: true,       // ADDED — when was this analysis done
          },
        });

        memoryRows = await (db.aria_memory as any).findMany({
          where: { user_id: userId },
          orderBy: { confidence: 'desc' },
          take: 30,
          select: { category: true, key: true, value: true },
        });

        // Fetch Instagram token from account_connections (not users table)
        igConnection = await (db.account_connections as any).findFirst({
          where: { user_id: userId, platform: 'instagram' },
          select: { platform_user_id: true, encrypted_token: true, handle: true },
        }).catch(() => null);
      } else {
        const rows = await db`
          SELECT id, name, archetype, archetype_label, niches, primary_platform,
                 instagram_handle, youtube_handle, follower_range, follower_count, 
                 engagement_rate, health_score, growth_stage, tone_profile, 
                 creator_intent, aria_confirmed_niche, scraped_summary, 
                 aria_last_analysis, aria_analyzed_at
          FROM users WHERE id = ${userId}
        `;
        user = rows[0];

        memoryRows = await db`
          SELECT category, key, value FROM aria_memory
          WHERE user_id = ${userId}
          ORDER BY confidence DESC LIMIT 30
        `;

        const igRows = await db`
          SELECT platform_user_id, encrypted_token, handle FROM account_connections
          WHERE user_id = ${userId} AND platform = 'instagram' LIMIT 1
        `.catch(() => []);
        igConnection = igRows[0] || null;
      }

      if (!user) return JSON.stringify({ error: "user_not_found" });

      user.memory = memoryRows.reduce((acc: any, m: any) => {
        if (!acc[m.category]) acc[m.category] = {};
        acc[m.category][m.key] = m.value;
        return acc;
      }, {});

      if (igConnection) {
        user.instagram_handle = igConnection.handle;
        user.has_instagram_connected = true;
      }

      return JSON.stringify(normalizeUserProfile(user));
    } catch (err: any) {
      return JSON.stringify({
        error: `Failed to fetch user profile: ${err.message}`,
      });
    }
  },
  {
    name: "get_user_profile",
    description:
      "Fetch the current user's full creator profile: archetype, niche, follower range, engagement rate, health score, platform, and all persistent ARIA memory learnings. Always call this first when answering personal questions about the user's performance or strategy.",
    // NOTE: 'db' is intentionally NOT in this schema — it is injected by the agent
    // runtime wrapper in aria_agent.ts and must never be exposed to the LLM.
    schema: z.object({
      userId: z.string().uuid().describe("User UUID from auth context"),
    }),
  },
);

// ── TOOL 9: ARIA DB live trends ───────────────────────────────────────────────
export const getDBLiveTrends = tool(
  async ({ niche, badge, db }: any) => {
    try {
      let trends: any[] = [];

      if (isPrismaClient(db)) {
        trends = await (db.live_trends as any).findMany({
          where: {
            expires_at: { gt: new Date() },
            ...(niche && niche !== "all" ? { niche_tags: { has: niche } } : {}),
            ...(badge && badge !== "ALL" ? { badge } : {}),
          },
          orderBy: { velocity: 'desc' },
          take: 20,
          select: {
            title: true,
            badge: true,
            velocity: true,
            search_volume: true,
            niche_tags: true,
            recommendation: true,
          },
        });
      } else {
        const nicheClause = niche && niche !== "all" ? `AND '${niche}' = ANY(niche_tags)` : '';
        const badgeClause = badge && badge !== "ALL" ? `AND badge = '${badge}'` : '';
        trends = await db`
          SELECT title, badge, velocity, search_volume, niche_tags, recommendation
          FROM live_trends
          WHERE expires_at > NOW() ${db.unsafe(nicheClause)} ${db.unsafe(badgeClause)}
          ORDER BY velocity DESC LIMIT 20
        `;
      }

      if (!trends.length) {
        return JSON.stringify({ message: "No live trends found in DB right now. Try get_google_trends for fresh data.", trends: [] });
      }

      return JSON.stringify(normalizeDBTrends(trends));
    } catch (err: any) {
      return JSON.stringify({
        error: `Failed to fetch live trends: ${err.message}`,
      });
    }
  },
  {
    name: "get_db_live_trends",
    description:
      "Fetch live trending topics from ARIA's real-time trends database (populated by BullMQ workers from pytrends + Reddit). Faster than Google Trends API. Use for trend-based content advice.",
    // NOTE: 'db' is injected by aria_agent.ts wrapper — NOT exposed to the LLM.
    schema: z.object({
      niche: z
        .string()
        .optional()
        .describe(
          'Creator niche filter e.g. "fashion", "fitness". Use "all" for all niches.',
        ),
      badge: z
        .enum(["HOT", "RISING", "NEW", "ALL"])
        .optional()
        .describe("Trend velocity filter"),
    }),
  },
);

// ── TOOL 10: ARIA DB trending songs ──────────────────────────────────────────
export const getDBTrendingSongs = tool(
  async ({ language, niche, db }: { language?: string; niche?: string; db?: any }) => {
    try {
      const { retrieveSongs } = await import("../services/songs/song.rag.service");

      const result = await retrieveSongs({
        language: language || "Hindi",
        niche:    niche    || "general",
        limit:    15,
      });

      if (!result.songs.length) {
        return JSON.stringify({
          message: "No songs in DB yet. Worker runs every 6h — check back soon.",
          songs:   [],
        });
      }

      // Build a rich summary for ARIA to use in responses
      const postNow  = result.songs.filter((s) => s.signal === "postNow").slice(0, 5);
      const peaking  = result.songs.filter((s) => s.lifecycle === "PEAKING").slice(0, 3);
      const rising   = result.songs.filter((s) => s.lifecycle === "RISING" && s.signal === "postNow").slice(0, 5);

      return JSON.stringify({
        fromCache:   result.fromCache,
        language:    result.metadata.language,
        niche:       result.metadata.niche,
        totalSongs:  result.metadata.songCount,
        postNow:     postNow.map((s)  => ({ title: s.title, artist: s.artist, rank: s.chart_position, lifecycle: s.lifecycle })),
        peaking:     peaking.map((s)  => ({ title: s.title, artist: s.artist, rank: s.chart_position })),
        rising:      rising.map((s)   => ({ title: s.title, artist: s.artist, rank: s.chart_position, change: s.chart_change })),
        narrative:   result.hotWindowNarrative,
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, "getDBTrendingSongs tool failed");
      return JSON.stringify({ error: `Failed to fetch trending songs: ${err.message}`, songs: [] });
    }
  },
  {
    name: "get_db_trending_songs",
    description:
      "Fetch currently trending songs/audio from ARIA's 3-tier song intelligence system. Data is scraped from Spotify, JioSaavn, and YouTube every 6 hours and enriched with lifecycle signals (RISING/PEAKING/DECLINING). Use for BGM/audio recommendations for Reels and Shorts. Includes postNow/wait/tooLate signals.",
    schema: z.object({
      language: z
        .string()
        .optional()
        .describe('Language filter: "Hindi", "English", "Punjabi", "Telugu", etc. Default: Hindi'),
      niche: z
        .string()
        .optional()
        .describe('Niche filter: "fashion", "fitness", "general", etc. Default: general'),
    }),
  },
);

// ── TOOL 11: User's past content performance ──────────────────────────────────
export const getUserContentHistory = tool(
  async ({ userId, limit, db }: any) => {
    try {
      let content: any[] = [];

      if (isPrismaClient(db)) {
        content = await (db.content_history as any).findMany({
          where: { user_id: userId },
          orderBy: { created_at: "desc" },
          take: limit,
          select: {
            trend_title: true,
            hook: true,
            content_format: true,
            platform: true,
            niche: true,
            created_at: true,
          },
        });
      } else {
        content = await db`
          SELECT trend_title, hook, content_format, platform, niche, created_at
          FROM content_history WHERE user_id = ${userId}
          ORDER BY created_at DESC LIMIT ${limit}
        `;
      }

      if (!content.length) {
        return JSON.stringify({ message: "No content history yet for this user.", content: [] });
      }

      return JSON.stringify({
        content: (content as any[]).map((c) => ({
          title: c.trend_title,
          hook: c.hook || null,
          format: c.content_format,
          platform: c.platform,
          niche: c.niche,
          createdAt: c.created_at,
        })),
      });
    } catch (err: any) {
      return JSON.stringify({
        error: `Failed to fetch content history: ${err.message}`,
      });
    }
  },
  {
    name: "get_user_content_history",
    description:
      "Fetch the user's recent content creation history from ARIA — what they've created, which formats, which platforms. Use to avoid repeating suggestions and to identify content gaps.",
    // NOTE: 'db' is injected by aria_agent.ts wrapper — NOT exposed to the LLM.
    schema: z.object({
      userId: z.string().uuid(),
      limit: z.number().optional().describe("Number of records, default 10"),
    }),
  },
);

// ── TOOL 12: Video DNA quick analysis (uses already-built service) ─────────────
export const analyseYouTubeVideoQuick = tool(
  async ({ videoId }) => {
    try {
      // Fetch video stats
      const videoRes = await axios.get(`${YT_BASE}/videos`, {
        params: {
          key: YT_KEY,
          id: videoId,
          part: "snippet,statistics,contentDetails",
        },
        timeout: 8000,
      });

      const video = normalizeYouTubeVideo(videoRes.data);

      if ("error" in video) return JSON.stringify({ error: "video_not_found" });

      // Search for similar videos to benchmark
      const searchRes = await axios.get(`${YT_BASE}/search`, {
        params: {
          key: YT_KEY,
          q: video.title,
          part: "snippet",
          type: "video",
          order: "viewCount",
          regionCode: "IN",
          maxResults: 5,
        },
        timeout: 8000,
      });

      const similar = normalizeYouTubeSearch(searchRes.data);

      return JSON.stringify({
        video,
        benchmarkingAgainst:
          similar.results.length > 0
            ? similar
            : { message: "No benchmarks found" },
      });
    } catch (err: any) {
      return JSON.stringify({ error: `Video analysis failed: ${err.message}` });
    }
  },
  {
    name: "analyse_youtube_video_quick",
    description:
      "Fetch a YouTube video's stats AND top performing videos in the same category for comparison. Use when user wants to analyse a specific video and benchmark it against competitors.",
    schema: z.object({
      videoId: z.string().length(11).describe("11-character YouTube video ID"),
    }),
  },
);

// ── TOOL 13: Confirm niche (onboarding completion) ───────────────────────────
export const confirmNiche = tool(
  async ({ userId, db }: any) => {
    try {
      if (isPrismaClient(db)) {
        await (db.users as any).update({
          where: { id: userId },
          data: { aria_confirmed_niche: true },
        });
      } else {
        await db`
          UPDATE users SET aria_confirmed_niche = true WHERE id = ${userId}
        `;
      }
      return JSON.stringify({ success: true, message: "Niche confirmed." });
    } catch (err: any) {
      return JSON.stringify({
        success: false,
        error: `Failed to confirm niche: ${err.message}`,
      });
    }
  },
  {
    name: "confirm_niche",
    description:
      "Mark the user's detected niche and archetype as confirmed. Call this when the user says 'yes', 'looks good', 'correct', or otherwise confirms the analysis ARIA presented to them after connecting Instagram.",
    // NOTE: 'db' is injected by aria_agent.ts wrapper — NOT exposed to the LLM.
    schema: z.object({
      userId: z.string().uuid().describe("User UUID from auth context"),
    }),
  },
);

// ── Export all tools as array ─────────────────────────────────────────────────
export const ALL_ARIA_TOOLS = [
  getYouTubeVideoStats,
  getYouTubeChannelStats,
  searchYouTube,
  getSpotifyTrending,
  getJioSaavnTrending,
  getGoogleTrends,
  getInstagramPersonalStats,
  getUserProfile,
  getDBLiveTrends,
  getDBTrendingSongs,
  getUserContentHistory,
  analyseYouTubeVideoQuick,
  confirmNiche,
];
