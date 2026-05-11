import { logger } from "../utils/logger";
import { prisma } from "../config/database";
import OpenAI from "openai";

let _openai: OpenAI | null = null;
const getAI = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 60_000 });
  return _openai;
};

export interface ViralIdea {
  id: string;
  title: string;
  contentAngle: string;
  whyNow: string;
  format: string;
  formatSuggestion: string;
  hook: string;
  ariaTip: string;
  viralityScore: number;
  velocityScore: number;
  badge: "HOT" | "RISING" | "NEW";
  growthSignal: string;
  geo: string;
  source: string;
  sources: string[];
  niche: string;
  isContentGap: boolean;
  contentGapNote: string;
}

export interface UserNicheContext {
  userId: string;
  niches: string[];
  archetype: string | null;
  archetypeLabel: string | null;
  instagramHandle: string | null;
  bio: string | null;
  topHashtags: string[];
  brandCategories: string[];
  contentPatterns: any;
}


// ── Main export ───────────────────────────────────────────────────────────────
export async function generateViralIdeas(params: {
  platform: string;
  followerRange: string;
  userContext: UserNicheContext;
}): Promise<ViralIdea[]> {
  const { platform, followerRange, userContext } = params;
  const primaryNiche = userContext.niches[0] || "general";

  // ── Step 1: Use hybrid RAG to get the pre-assembled hot window ────────────
  // This is Tier 1 — already narrowed, already embedded, ARIA-ready
  let hotWindowNarrative = "";
  let vectorTrends: any[] = [];

  try {
    const { hybridRetrieve } = await import("./retrieval/hybrid-rag.service");
    const ragResult = await hybridRetrieve({ niche: primaryNiche, forceRefresh: false });
    hotWindowNarrative = ragResult.hotWindowNarrative || "";
    vectorTrends = ragResult.signals?.vectorResults || [];
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "viralIdeas: hybridRetrieve failed — falling back to direct DB"
    );
  }

  // ── Step 2: Direct live_trends query as fallback / supplement ─────────────
  // Only used if RAG returned nothing — NEVER dump all rows, always limit
  let directSignals: any[] = [];
  if (vectorTrends.length < 5) {
    try {
      directSignals = await prisma.live_trends.findMany({
        where: {
          expires_at: { gt: new Date() },
          OR: [
            { niche_tags: { has: primaryNiche } },
            { niche_tags: { has: "general" } },
          ],
        },
        orderBy: { velocity: "desc" },
        take: 20,
        select: {
          title: true,
          source: true,
          velocity: true,
          badge: true,
          niche_tags: true,
          content_format: true,
          recommendation: true,
          is_override: true,
          override_reason: true,
          raw_data: true,
          fetched_at: true,
        },
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, "viralIdeas: direct live_trends query failed");
    }
  }

  // ── Step 3: Build source-labelled signal strings for the prompt ───────────
  const allSignals = [
    ...vectorTrends.map((t: any) => ({ ...t, fromRag: true })),
    ...directSignals.map((t: any) => ({ ...t, fromRag: false })),
  ];

  // Group by source for the prompt
  const bySource: Record<string, string[]> = {};
  for (const s of allSignals) {
    const src = s.source || "unknown";
    if (!bySource[src]) bySource[src] = [];
    const override = s.is_override ? ` [${s.override_reason?.toUpperCase()}]` : "";
    const format =
      s.content_format && s.content_format !== "unknown"
        ? ` · ${s.content_format}`
        : "";
    bySource[src].push(
      `- "${s.title}" | ${s.badge || "NEW"} | velocity:${s.velocity || 0}${format}${override}`
    );
  }

  const signalContext = Object.entries(bySource)
    .map(([src, lines]) => `\n${src.toUpperCase()} SIGNALS:\n${lines.slice(0, 8).join("\n")}`)
    .join("\n");

  // ── Step 4: Fetch user context (memory, feedback history, voice portrait) ──
  const [memoryRow, feedbackHistory, voicePortrait] = await Promise.allSettled([
    prisma.aria_memory.findFirst({
      where: { user_id: userContext.userId },
      select: { value: true },
    }),
    prisma.aria_feedback.findMany({
      where: { user_id: userContext.userId },
      orderBy: { created_at: "desc" },
      take: 20,
      select: { was_helpful: true, recommendation_data: true },
    }),
    prisma.creator_voice_profiles.findUnique({
      where: { user_id: userContext.userId },
      select: { voice_data: true },
    }).catch(() => null),
  ]);

  const memory =
    memoryRow.status === "fulfilled" ? (memoryRow.value as any)?.value : null;
  const feedback =
    feedbackHistory.status === "fulfilled" ? feedbackHistory.value : [];
  const voice =
    voicePortrait.status === "fulfilled" ? (voicePortrait.value as any)?.voice_data : null;

  const helpfulAngles = (feedback as any[])
    .filter((f: any) => f.was_helpful === true)
    .map((f: any) => (f.recommendation_data as any)?.title || "")
    .filter(Boolean)
    .slice(0, 5);

  const unhelpfulAngles = (feedback as any[])
    .filter((f: any) => f.was_helpful === false)
    .map((f: any) => (f.recommendation_data as any)?.title || "")
    .filter(Boolean)
    .slice(0, 5);

  // ── Step 5: Build the OpenAI prompt ──────────────────────────────────────
  const prompt = `You are ARIA, India's most advanced creator intelligence engine.

CREATOR PROFILE:
- Niche: ${primaryNiche}
- Platform: ${platform}
- Follower Range: ${followerRange}
- Archetype: ${userContext.archetypeLabel || userContext.archetype || "Creator"}
- Bio: ${userContext.bio || "Not provided"}
- Top hashtags they use: ${userContext.topHashtags.slice(0, 5).join(", ") || "none yet"}
${voice ? `- Voice & Tone: ${JSON.stringify(voice.portrait).substring(0, 300)}` : ""}

LIVE TREND SIGNALS (scraped from YouTube, Reddit, TikTok, Pinterest, Google — last 12-24 hours):
${signalContext || "No live signals available — use your knowledge of Indian trends"}

${hotWindowNarrative ? `ARIA INTELLIGENCE CONTEXT:\n${hotWindowNarrative.substring(0, 800)}` : ""}

${helpfulAngles.length > 0 ? `CREATOR LIKED THESE ANGLES (use similar): ${helpfulAngles.join("; ")}` : ""}
${unhelpfulAngles.length > 0 ? `CREATOR REJECTED THESE (avoid entirely): ${unhelpfulAngles.join("; ")}` : ""}

TASK: Generate exactly 6 trending content ideas for this creator for ${platform}.
Each idea must be directly inspired by the live signals above.
Ideas must be specific to the INDIAN market and the creator's niche.

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no backticks):
{
  "ideas": [
    {
      "title": "specific content idea title",
      "format": "Reel|Carousel|Story|Video",
      "hook": "the first 3 seconds / opening line that stops the scroll",
      "whyNow": "which signal makes this timely — reference the actual source",
      "contentAngle": "the unique angle that makes this different from what others will make",
      "ariaTip": "one specific tactical tip for this creator given their niche and stage",
      "viralityScore": 75,
      "badge": "HOT|RISING|NEW",
      "sources": ["youtube", "reddit"],
      "isContentGap": false,
      "contentGapNote": ""
    }
  ]
}

RULES:
- viralityScore must be between 60-98, not all the same
- badge must match the velocity of the underlying signal
- isContentGap = true if Google Trends shows this topic trending but no video covers it well
- All ideas must be distinct formats — no two the same format
- First idea should be the strongest signal (HOT badge)
- Ideas 5-6 can be "sleeper" picks — override signals with high potential`;

  // ── Step 6: Call OpenAI ───────────────────────────────────────────────────
  try {
    const response = await getAI().chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: 2000,
      temperature: 0.8,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.choices[0]?.message?.content || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // Map response fields with backward-compat aliases
    return (parsed.ideas || []).map((idea: any, idx: number) => ({
      ...idea,
      id: idea.id || `idea_${Date.now()}_${idx}`,
      formatSuggestion: idea.format || idea.formatSuggestion || "Reel",
      velocityScore: idea.viralityScore || idea.velocityScore || 70,
      growthSignal: idea.whyNow || idea.growthSignal || "",
      geo: idea.geo || "India",
      source: (idea.sources || [])[0] || "unknown",
      niche: primaryNiche,
    }));
  } catch (err: any) {
    logger.error({ err: err.message }, "viralIdeas: OpenAI call failed");
    // Graceful fallback — return what we have from live_trends directly
    return allSignals.slice(0, 6).map((s: any, idx: number) => ({
      id: `idea_fallback_${Date.now()}_${idx}`,
      title: s.title,
      format: s.content_format === "short_form" ? "Reel" : "Carousel",
      formatSuggestion: s.content_format === "short_form" ? "Reel" : "Carousel",
      hook: `Here's what's trending in ${primaryNiche} right now...`,
      whyNow: s.recommendation || `Trending on ${s.source}`,
      contentAngle: `Your take on: ${s.title}`,
      ariaTip: "Post within 24 hours to ride the peak.",
      viralityScore: s.velocity || 50,
      velocityScore: s.velocity || 50,
      badge: (s.badge as "HOT" | "RISING" | "NEW") || "NEW",
      growthSignal: s.recommendation || "",
      geo: "India",
      source: s.source || "unknown",
      sources: [s.source || "unknown"],
      niche: primaryNiche,
      isContentGap: false,
      contentGapNote: "",
    }));
  }
}
