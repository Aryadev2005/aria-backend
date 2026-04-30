import { prisma } from "../config/database";
import { logger } from "../utils/logger";
import { searchYouTubeByNiche } from "./youtubeTrending.service";
import * as groqService from "./ai/groq.service";

// ─── Indian Festival Calendar ──────────────────────────────────────────────
export interface Festival {
  name: string;
  month: number;
  day: number;
  windowDays: number;
}

const INDIAN_FESTIVALS: Festival[] = [
  { name: "New Year", month: 1, day: 1, windowDays: 7 },
  { name: "Pongal", month: 1, day: 14, windowDays: 5 },
  { name: "Valentine's", month: 2, day: 14, windowDays: 7 },
  { name: "Holi", month: 3, day: 25, windowDays: 10 },
  { name: "IPL Season", month: 3, day: 22, windowDays: 60 },
  { name: "Eid", month: 4, day: 10, windowDays: 7 },
  { name: "Independence", month: 8, day: 15, windowDays: 5 },
  { name: "Navratri", month: 10, day: 3, windowDays: 10 },
  { name: "Diwali", month: 10, day: 20, windowDays: 14 },
  { name: "Christmas", month: 12, day: 25, windowDays: 7 },
];

const ARCHETYPE_SOURCES: Record<string, string[]> = {
  TRENDSETTER: ["Myntra Blog", "Nykaa Trends", "Vogue India"],
  EDUCATOR: ["Economic Times", "Zerodha Blog", "Mint"],
  ENTERTAINER: ["Twitter India Trends", "Reddit r/india"],
  STORYTELLER: ["MakeMyTrip Blog", "Lonely Planet India"],
  CONNECTOR: ["ParentCircle", "SheThePeople"],
  EXPERT: ["91Mobiles", "GadgetsNow", "Healthline India"],
  HUSTLER: ["YourStory", "Inc42", "Shark Tank India"],
  ATHLETE: ["HealthKart Blog", "GQ India Fitness"],
  CHEF: ["Zomato Blog", "Times Food"],
  PERFORMER: ["Spotify Charts India", "JioSaavn Trends"],
};

export const getUpcomingFestivals = () => {
  const now = new Date();
  return INDIAN_FESTIVALS.map((f) => {
    const festDate = new Date(now.getFullYear(), f.month - 1, f.day);
    const daysUntil = Math.ceil(
      (festDate.getTime() - now.getTime()) / 86400000,
    );
    return daysUntil >= 0 && daysUntil <= 30
      ? {
          name: f.name,
          daysUntil,
          windowDays: f.windowDays,
          isUrgent: daysUntil <= 5,
        }
      : null;
  })
    .filter(Boolean)
    .sort((a, b) => (a as any).daysUntil - (b as any).daysUntil);
};

/**
 * Pull real live trends from DB for this niche
 */
export const getLiveTrendsForNiche = async (niche: string) => {
  try {
    return await prisma.live_trends.findMany({
      select: {
        title: true,
        search_volume: true,
        velocity: true,
        niche_tags: true,
        source: true,
        raw_data: true,
      },
      where: {
        OR: [
          { niche_tags: { has: niche } },
          { niche_tags: { has: "general" } },
        ],
      },
      orderBy: [{ velocity: "desc" }, { fetched_at: "desc" }],
      take: 10,
    });
  } catch (err) {
    logger.warn({ err, niche }, "Could not fetch live trends");
    return [];
  }
};

export interface NicheIntelligenceParams {
  niche: string;
  platform: string;
  archetype: string;
  followerRange: string;
}

/**
 * Core: Generate intelligence with REAL data grounding
 */
export const generateNicheIntelligence = async ({
  niche,
  platform,
  archetype,
  followerRange,
}: NicheIntelligenceParams) => {
  const sources = ARCHETYPE_SOURCES[archetype] || ARCHETYPE_SOURCES.EDUCATOR;
  const festivals = getUpcomingFestivals();
  const festCtx = festivals.length
    ? festivals.map((f: any) => `${f.name} in ${f.daysUntil} days`).join(", ")
    : "No major festivals in next 7 days";

  // ── Pull real live data ────────────────────────────────────────────────
  const [liveTrends, youtubeNicheVideos] = await Promise.allSettled([
    getLiveTrendsForNiche(niche),
    searchYouTubeByNiche(niche, 5),
  ]);

  const realTrends: any[] =
    liveTrends.status === "fulfilled" ? liveTrends.value : [];
  const ytVideos: any[] =
    youtubeNicheVideos.status === "fulfilled"
      ? youtubeNicheVideos.value || []
      : [];

  // ── Build real data context for ARIA prompt ───────────────────────────
  const liveTrendContext =
    realTrends.length > 0
      ? `LIVE TRENDS RIGHT NOW (real data from Google Trends + YouTube):\n` +
        realTrends
          .map(
            (t) =>
              `- "${t.title}" | velocity: ${t.velocity}/100 | views: ${(t.search_volume || 0).toLocaleString("en-IN")} | source: ${t.source}`,
          )
          .join("\n")
      : "Live trend data loading — use your India creator knowledge";

  const ytContext =
    ytVideos && ytVideos.length > 0
      ? `\nTOP YOUTUBE VIDEOS IN ${niche.toUpperCase()} INDIA THIS WEEK:\n` +
        ytVideos.map((v) => `- "${v.title}" by ${v.channel}`).join("\n")
      : "";

  const prompt = `You are ARIA — India's creator intelligence engine.

Creator: ${archetype} | Niche: ${niche} | Platform: ${platform} | Followers: ${followerRange}
Intelligence sources: ${sources.join(", ")}
Festival context: ${festCtx}

${liveTrendContext}${ytContext}

Using the REAL data above, generate a niche intelligence feed.
opportunityScore = velocity + competition gap + niche fit (1-100).
nobodyHasDoneThis = true when trend is RISING but creator density is LOW.
peakWindowHours = estimated hours until this trend peaks.

Respond ONLY with valid JSON:
{
  "ariaTopPick": {
    "title": "The #1 opportunity from the real data above this creator should act on RIGHT NOW",
    "reason": "One sentence — cite the real trend/video that signals this",
    "urgency": "high|medium|low",
    "peakWindowHours": 36
  },
  "opportunities": [
    {
      "id": "opp_1",
      "title": "Trend title (from real data above)",
      "description": "Why this is working right now in India — reference the actual data",
      "angle": "Specific angle THIS creator should take",
      "badge": "HOT|RISING|NEW",
      "opportunityScore": 87,
      "nobodyHasDoneThis": false,
      "peakWindowHours": 48,
      "estimatedViews": "50K-200K",
      "hookSuggestion": "Exact first 3 seconds words to say on camera",
      "nicheSource": "google_trends|youtube|reddit"
    }
  ],
  "competitorMoves": [
    {
      "description": "What similar creators are doing this week based on YouTube data",
      "engagement": "est. views range",
      "gap": "The angle nobody has covered yet"
    }
  ],
  "festivalBoosts": ${JSON.stringify(festivals.slice(0, 3))}
}`;

  // Use groq.service directly since it has parseJSON
  const message = await groqService._callGroq(prompt, { maxTokens: 1800 });
  return message;
};

/**
 * Competitor intelligence with real YouTube data
 */
export const generateCompetitorIntelligence = async ({
  niche,
  platform,
  archetype,
}: Partial<NicheIntelligenceParams>) => {
  const ytVideos = await searchYouTubeByNiche(niche || "general", 8).catch(
    () => [],
  );
  const liveTrends = await getLiveTrendsForNiche(niche || "general");

  const ytContext =
    ytVideos && ytVideos.length > 0
      ? `ACTUAL YOUTUBE VIDEOS in ${niche} India this week:\n` +
        ytVideos.map((v: any) => `- "${v.title}" — ${v.channel}`).join("\n")
      : "";

  const trendContext =
    liveTrends.length > 0
      ? `\nLIVE TRENDS: ${liveTrends
          .slice(0, 5)
          .map((t: any) => t.title)
          .join(", ")}`
      : "";

  const prompt = `You are ARIA. Analyze what similar ${archetype} creators are doing in ${niche} on ${platform} in India.

${ytContext}${trendContext}

Based on the real data above, respond ONLY with valid JSON:
{
  "weeklyWinners": [
    {
      "format": "Reel|Carousel|Short|Long-form",
      "angle": "specific angle being used (from real videos above)",
      "estimatedViews": "est range",
      "whyItWorked": "one sentence based on real data",
      "canYouDoThis": true
    }
  ],
  "gaps": [
    {
      "opportunity": "Topic in the real data that nobody has fully covered yet",
      "difficulty": "easy|medium|hard",
      "estimatedViews": "100K+"
    }
  ],
  "ariaInsight": "One sharp observation based on the real YouTube + trends data above"
}`;

  return groqService._callGroq(prompt, { maxTokens: 900 });
};

/**
 * Inspiration with real data
 */
export const generateInspiration = async ({
  niche,
  platform,
  archetype,
  followerRange,
}: NicheIntelligenceParams) => {
  const liveTrends = await getLiveTrendsForNiche(niche);
  const ytVideos = await searchYouTubeByNiche(niche, 5).catch(() => []);

  const context =
    liveTrends.length > 0
      ? `REAL LIVE TRENDS IN ${niche.toUpperCase()} RIGHT NOW:\n` +
        liveTrends
          .slice(0, 6)
          .map((t: any) => `- ${t.title} (velocity: ${t.velocity})`)
          .join("\n")
      : "";

  const ytCtx =
    ytVideos && ytVideos.length > 0
      ? `\nRECENT YOUTUBE VIDEOS: ${ytVideos.map((v: any) => `"${v.title}"`).join(", ")}`
      : "";

  const prompt = `You are ARIA. Generate 4 content ideas for a ${archetype} creator in ${niche} on ${platform} (${followerRange} followers) in India.

${context}${ytCtx}

Each idea must be grounded in the real data above and specific enough to film TODAY.

Respond ONLY with valid JSON:
{
  "ideas": [
    {
      "id": "idea_1",
      "title": "Content idea title (tied to real trend above)",
      "hook": "Exact first 3 seconds script — the actual words",
      "format": "Reel 30s|YouTube Short|Carousel",
      "duration": "30s",
      "difficulty": "easy|medium|hard",
      "estimatedViews": "20K-80K",
      "whyNow": "One sentence referencing the real trend signal",
      "oneTapToStudio": true
    }
  ]
}`;

  return groqService._callGroq(prompt, { maxTokens: 1000 });
};

/**
 * DB-cached snapshot (6h TTL)
 */
export const getOrGenerateRadarSnapshot = async ({
  niche,
  platform,
  archetype,
  followerRange,
}: NicheIntelligenceParams) => {
  try {
    const existing = await prisma.radar_snapshots.findFirst({
      where: {
        niche,
        platform,
        expires_at: { gt: new Date() },
      },
      orderBy: { generated_at: "desc" },
      select: { intelligence_data: true },
    });
    if (existing?.intelligence_data) {
      logger.info({ niche, platform }, "Radar: cache hit");
      return { ...(existing.intelligence_data as any), fromCache: true };
    }
  } catch (err) {
    logger.warn({ err }, "radar_snapshots not ready — skipping cache");
  }

  const intelligence = await generateNicheIntelligence({
    niche,
    platform,
    archetype,
    followerRange,
  });

  try {
    await prisma.radar_snapshots.create({
      data: {
        niche,
        platform,
        intelligence_data: intelligence as any,
        expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000),
      },
    });
  } catch (err) {
    logger.warn({ err }, "Could not cache radar snapshot");
  }

  return { ...intelligence, fromCache: false };
};
