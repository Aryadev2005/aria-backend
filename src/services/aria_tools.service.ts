import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import Groq from "groq-sdk";

// ── Tool definitions (passed to Groq as tools: []) ──────────────────────────
export const ARIA_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_live_trends",
      description:
        "Get real-time trending topics for a niche and platform from live data. Call this whenever the user asks what is trending, what to post, or what is working right now. Do NOT use training data for trend questions.",
      parameters: {
        type: "object",
        properties: {
          niche: {
            type: "string",
            description:
              "Creator niche e.g. fashion, fitness, finance, food, travel",
          },
          platform: {
            type: "string",
            enum: ["instagram", "youtube", "both"],
            description: "Target platform",
          },
          badge: {
            type: "string",
            enum: ["HOT", "RISING", "ALL"],
            description: "Filter by trend velocity",
          },
        },
        required: ["niche"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "match_bgm",
      description:
        "Find trending background music / audio that matches the creator niche and content type. Call when user asks about audio, music, sounds, or BGM for their content.",
      parameters: {
        type: "object",
        properties: {
          niche: { type: "string", description: "Creator niche" },
          mood: {
            type: "string",
            description:
              "Content mood e.g. energetic, emotional, funny, aesthetic",
          },
          platform: { type: "string", enum: ["instagram", "youtube", "both"] },
        },
        required: ["niche"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_best_posting_time",
      description:
        "Get the optimal posting time for this specific creator based on their analytics and audience. Call when user asks when to post.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["instagram", "youtube"] },
          content_type: {
            type: "string",
            description: "e.g. Reel, Carousel, Short, Video",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_creator_analytics",
      description:
        "Fetch the creator's real performance metrics — followers, engagement, top posts. Call when user asks how they are performing, what their stats are, or when discussing growth.",
      parameters: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: ["overview", "top_posts", "growth", "engagement"],
            description: "Which metric to fetch",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_hook_variations",
      description:
        "Generate 3 hook variations for a specific piece of content, tailored to the creator's archetype. Call when user asks for hook ideas or wants to improve an opening line.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "The content topic or idea" },
          platform: { type: "string", description: "Target platform" },
          format: {
            type: "string",
            description: "Content format e.g. Reel, Carousel",
          },
        },
        required: ["topic"],
      },
    },
  },
];

export interface ToolArgs {
  niche?: string;
  platform?: string;
  badge?: string;
  mood?: string;
  content_type?: string;
  metric?: string;
  topic?: string;
  format?: string;
}

export interface UserContext {
  niche?: string;
  platform?: string;
  archetype?: string;
}

/**
 * Tool dispatcher — maps LLM tool calls to real services
 */
export const dispatchTool = async (
  toolName: string,
  toolArgs: ToolArgs,
  userId: string,
  userContext: UserContext,
) => {
  logger.info({ toolName, toolArgs, userId }, "ARIA tool called");

  try {
    switch (toolName) {
      case "get_live_trends": {
        const cacheKey = `live_trends:${toolArgs.niche}:${toolArgs.platform || "all"}`;
        const cached = await cache.get(cacheKey);
        if (cached) return { source: "live_db", data: cached };

        // Pull from live_trends table (fed by BullMQ trend worker)
        const niche = toolArgs.niche || userContext?.niche || "general";
        const badge = toolArgs.badge || "ALL";

        const trends = await prisma.live_trends.findMany({
          where: {
            expires_at: { gt: new Date() },
            OR: [
              { niche_tags: { has: niche } },
              { niche_tags: { isEmpty: true } },
            ],
            ...(badge !== "ALL" ? { badge } : {}),
          },
          orderBy: [{ velocity: "desc" }, { search_volume: "desc" }],
          take: 5,
          select: {
            title: true,
            search_volume: true,
            velocity: true,
            badge: true,
            recommendation: true,
            expires_at: true,
          },
        });

        if (trends.length === 0) {
          // Fallback to groq-generated trends if DB is empty
          return {
            source: "ai_generated",
            note: "Live trend DB empty — using AI estimates. Run trend worker to populate.",
            data: [
              {
                title: `${niche} content gap`,
                velocity: 80,
                recommendation: "Post original takes on this niche",
              },
            ],
          };
        }

        await cache.set(cacheKey, trends, 600); // 10 min cache
        return { source: "live_db", data: trends };
      }

      case "match_bgm": {
        const niche = toolArgs.niche || userContext?.niche || "general";
        // const platform = toolArgs.platform || userContext?.platform || 'instagram'

        const songs = await prisma.live_songs.findMany({
          where: {
            fetched_at: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
          orderBy: [{ chart_position: "asc" }],
          take: 20,
          select: {
            title: true,
            artist: true,
            chart_position: true,
            language: true,
            streams_today: true,
          },
        });

        const rankedSongs = [...songs]
          .sort((a, b) => {
            const langRank = (lang?: string | null) => {
              if (lang === "Hindi") return 0;
              if (lang === "English") return 1;
              return 2;
            };
            const leftLang = langRank(a.language);
            const rightLang = langRank(b.language);
            if (leftLang !== rightLang) return leftLang - rightLang;
            return (a.chart_position || 9999) - (b.chart_position || 9999);
          })
          .slice(0, 5);

        if (rankedSongs.length === 0) {
          return {
            source: "fallback",
            note: "Song worker not populated yet. Run song.worker.js.",
            data: [
              {
                title: "Phir Aur Kya Chahiye",
                artist: "Arijit Singh",
                recommendation: "Trending for lifestyle/vlog content",
              },
              {
                title: "Kesariya",
                artist: "Arijit Singh",
                recommendation: "High saves for emotional storytelling",
              },
            ],
          };
        }

        return { source: "live_db", data: rankedSongs, niche };
      }

      case "get_best_posting_time": {
        const user = (await prisma.users.findUnique({
          where: { id: userId },
          select: {
            scraped_summary: true,
            primary_platform: true,
            engagement_rate: true,
          },
        })) as any;

        const scrapedSummary = user?.scraped_summary as any;

        if (scrapedSummary?.bestPostingTime) {
          return {
            source: "personal_analytics",
            bestTime: scrapedSummary.bestPostingTime,
            bestDays: scrapedSummary.bestDays || ["Wednesday", "Friday"],
            note: "Based on your actual audience activity",
          };
        }

        // Generic India-optimised times by platform
        const platform =
          toolArgs.platform || userContext?.platform || "instagram";
        const genericTimes: Record<string, any> = {
          instagram: {
            bestTime: "7:00 PM IST",
            bestDays: ["Wednesday", "Friday", "Saturday"],
            note: "India audience peak hours",
          },
          youtube: {
            bestTime: "6:00 PM IST",
            bestDays: ["Saturday", "Sunday"],
            note: "India audience peak hours",
          },
        };

        return { source: "general_india_data", ...genericTimes[platform] };
      }

      case "get_creator_analytics": {
        const user = (await prisma.users.findUnique({
          where: { id: userId },
          select: {
            follower_range: true,
            engagement_rate: true,
            health_score: true,
            scraped_summary: true,
            archetype: true,
            growth_stage: true,
          },
        })) as any;

        const metric = toolArgs.metric || "overview";

        if (metric === "overview") {
          return {
            followerRange: user?.follower_range || "Unknown",
            engagementRate: user?.engagement_rate || 0,
            healthScore: user?.health_score || 0,
            growthStage: user?.growth_stage || "GROWTH",
            archetype: user?.archetype || "Unknown",
          };
        }

        if (metric === "top_posts" && user?.scraped_summary?.topPosts) {
          return { topPosts: user.scraped_summary.topPosts.slice(0, 3) };
        }

        return {
          note: "Connect your Instagram or YouTube handle in Profile to get real analytics.",
        };
      }

      case "generate_hook_variations": {
        // Import groq service to generate hooks
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

        const archetype = userContext?.archetype || "ENTERTAINER";
        const niche = userContext?.niche || "general";

        const prompt = `Generate 3 hook variations for: "${toolArgs.topic}"
Creator: ${archetype} in ${niche} niche on ${toolArgs.platform || "Instagram"}
Format: ${toolArgs.format || "Reel"}

Return ONLY a JSON array:
[
  { "hook": "first 3 seconds script", "trigger": "curiosity|emotion|shock|aspiration", "rating": 85 },
  { "hook": "...", "trigger": "...", "rating": 80 },
  { "hook": "...", "trigger": "...", "rating": 78 }
]`;

        const response = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          max_tokens: 600,
          messages: [{ role: "user", content: prompt }],
        });

        const content = response.choices[0].message.content;
        if (!content) throw new Error("Empty response from Groq");

        const raw = content
          .replace(/```json\n?/g, "")
          .replace(/```\n?/g, "")
          .trim();
        return { hooks: JSON.parse(raw) };
      }

      default:
        logger.warn({ toolName }, "Unknown tool called");
        return { error: `Tool ${toolName} not found` };
    }
  } catch (err: any) {
    logger.error({ err, toolName, userId }, "Tool dispatch failed");
    return { error: `Tool ${toolName} failed: ${err.message}`, fallback: true };
  }
};
