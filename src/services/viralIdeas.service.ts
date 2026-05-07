import { logger } from "../utils/logger";
import { _callGroq } from "./ai/groq.service";
import { prisma } from "../config/database";
import { getVoicePortrait } from "./voice.service";

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

// ── Source 1: Read Reddit signals from DB (stored by discovery worker) ────────
async function readRedditSignals(limit = 40): Promise<any[]> {
  try {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000); // last 72h
    const rows = await (prisma as any).discovery_reddit_raw.findMany({
      where: {
        expires_at: { gt: new Date() },
        scraped_at: { gt: cutoff },
        velocity:   { gte: 55 },
      },
      orderBy: [
        { is_breakout: "desc" },
        { velocity: "desc" },
      ],
      take: limit,
      select: {
        title:        true,
        score:        true,
        num_comments: true,
        subreddit:    true,
        velocity:     true,
        is_breakout:  true,
        age_hours:    true,
        feed:         true,
        flair:        true,
      },
    });

    return rows.map((r: any) => ({
      title:       r.title,
      source:      `reddit_r/${r.subreddit}_${r.feed}`,
      velocity:    r.velocity,
      growthSignal: `${r.score} upvotes · ${r.num_comments} comments`,
      isBreakout:  r.is_breakout,
      ageHours:    Number(r.age_hours),
      geo:         "GLOBAL",
    }));
  } catch (err: any) {
    logger.warn({ err: err.message }, "Reddit DB read failed");
    return [];
  }
}

// ── Source 2: Read YouTube signals from DB (stored by discovery worker) ────────
async function readYouTubeSignals(limit = 30): Promise<any[]> {
  try {
    const rows = await (prisma as any).live_trends.findMany({
      where: {
        source:     "youtube",
        expires_at: { gt: new Date() },
      },
      orderBy: { velocity: "desc" },
      take:    limit,
      select: {
        title:          true,
        velocity:       true,
        search_volume:  true,
        recommendation: true,
        raw_data:       true,
      },
    });

    return rows.map((r: any) => ({
      title:   r.title,
      channel: (r.raw_data as any)?.channelTitle || "",
      views:   r.search_volume || 0,
      source:  "youtube_trending_IN",
    }));
  } catch (err: any) {
    logger.warn({ err: err.message }, "YouTube DB read failed");
    return [];
  }
}

// ── Source 3: Read TikTok signals from raw store ───────────────────────────────
async function readTikTokSignals(limit = 30): Promise<any[]> {
  try {
    const rows = await (prisma as any).discovery_tiktok_raw.findMany({
      where:   { 
        expires_at: { gt: new Date() },
        views: { gt: BigInt(10000) },
      },
      orderBy: { engagement_rate: "desc" },
      take:    limit,
      select: {
        description:     true,
        creator_name:    true,
        views:           true,
        likes:           true,
        comments:        true,
        engagement_rate: true,
        sound_name:      true,
        sound_artist:    true,
        hashtags:        true,
      },
    });

    return rows.map((r: any) => ({
      title:       (r.description || "").substring(0, 100),
      creator:     r.creator_name || "",
      views:       Number(r.views),
      engagement:  Number(r.engagement_rate),
      sound:       r.sound_name ? `${r.sound_name} — ${r.sound_artist || ""}` : "",
      hashtags:    (r.hashtags || []).slice(0, 5).join(", "),
      source:      "tiktok_global",
    }));
  } catch (err: any) {
    logger.warn({ err: err.message }, "TikTok DB read failed");
    return [];
  }
}

// ── Source 4: Read Pinterest signals from raw store ────────────────────────────
async function readPinterestSignals(limit = 20): Promise<any[]> {
  try {
    const rows = await (prisma as any).discovery_pinterest_raw.findMany({
      where:   { 
        expires_at: { gt: new Date() },
        saves: { gt: BigInt(100) },
      },
      orderBy: { saves: "desc" },
      take:    limit,
      select: {
        title:           true,
        description:     true,
        saves:           true,
        clicks:          true,
        engagement_rate: true,
        board_name:      true,
        hashtags:        true,
      },
    });

    return rows.map((r: any) => ({
      title:      (r.title || r.description || "").substring(0, 100),
      saves:      Number(r.saves),
      board:      r.board_name || "",
      hashtags:   (r.hashtags || []).slice(0, 5).join(", "),
      source:     "pinterest_global",
    }));
  } catch (err: any) {
    logger.warn({ err: err.message }, "Pinterest DB read failed");
    return [];
  }
}

// ── Source 5: Read Google Trends from raw store ────────────────────────────────
async function readGoogleTrendsSignals(limit = 20): Promise<any[]> {
  try {
    const rows = await (prisma as any).discovery_google_trends_raw.findMany({
      where:   { 
        expires_at: { gt: new Date() },
        interest_score: { gte: 50 },
      },
      orderBy: { interest_score: "desc" },
      take:    limit,
      select: {
        keyword:         true,
        interest_score:  true,
        related_queries: true,
        related_topics:  true,
        breakout:        true,
      },
    });

    return rows.map((r: any) => ({
      title:    r.keyword,
      score:    r.interest_score,
      breakout: r.breakout,
      related:  [...(r.related_queries || []), ...(r.related_topics || [])].slice(0, 5).join(", "),
      source:   "google_trends_global",
    }));
  } catch (err: any) {
    logger.warn({ err: err.message }, "Google Trends DB read failed");
    return [];
  }
}

// ── Fallback: generate synthetic signals from YouTube when a source is empty ──
// Used when Pinterest/Google Trends tables have no data yet
function buildFallbackSignals(
  ytSignals: any[],
  tiktokSignals: any[],
  source: "pinterest_global" | "google_trends_global",
  limit: number,
): any[] {
  // Derive fallback signals from YouTube + TikTok titles as proxy topics
  const combined = [
    ...ytSignals.map(v => ({ title: v.title, score: v.views || 70 })),
    ...tiktokSignals.map(v => ({ title: v.title, score: v.views || 60 })),
  ]
    .filter(s => s.title)
    .slice(0, limit);

  if (source === "pinterest_global") {
    return combined.map(s => ({
      title:    s.title.substring(0, 100),
      saves:    s.score,
      board:    "trending",
      hashtags: "",
      source:   "pinterest_global",
      isFallback: true,
    }));
  }

  return combined.map(s => ({
    title:    s.title.substring(0, 100),
    score:    70,
    breakout: false,
    related:  "",
    source:   "google_trends_global",
    isFallback: true,
  }));
}

// ── Single Groq call: resolves subreddits + synthesizes 10 ideas ─────────────
// Merging niche resolution + idea synthesis into ONE call to avoid rate limits
async function resolveAndSynthesize(
  redditSignals:    any[],
  ytSignals:        any[],
  tiktokSignals:    any[],
  pinterestSignals: any[],
  googleSignals:    any[],
  ctx:              UserNicheContext,
  platform:         string,
  followerRange:    string,
  voicePortrait:    any,
  memory:           any,
  feedbackHistory:  any[],
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

  const tiktokCtx = tiktokSignals.length > 0
    ? `\nTIKTOK GLOBAL TRENDING (raw worldwide data):\n` +
      tiktokSignals.slice(0, 8).map(
        v => `- "${v.title}" | ${v.views.toLocaleString("en-IN")} views | ${(v.engagement * 100).toFixed(1)}% engagement${v.sound ? ` | Sound: ${v.sound}` : ""}`
      ).join("\n")
    : "";

  const pinterestCtx = pinterestSignals.length > 0
    ? `\nPINTEREST GLOBAL TRENDING (raw worldwide data):\n` +
      pinterestSignals.slice(0, 6).map(
        p => `- "${p.title}" | ${p.saves.toLocaleString("en-IN")} saves | Board: ${p.board}`
      ).join("\n")
    : "";

  const googleCtx = googleSignals.length > 0
    ? `\nGOOGLE TRENDS GLOBAL BREAKOUTS:\n` +
      googleSignals.slice(0, 6).map(
        g => `- "${g.title}" | Score: ${g.score}/100${g.breakout ? " ⚡ BREAKOUT" : ""} | Related: ${g.related}`
      ).join("\n")
    : "";

  // Extract top topics from memory
  const topTopics = (memory?.content_territory || [])
    .sort((a: any, b: any) => b.times_seen - a.times_seen)
    .slice(0, 5)
    .map((m: any) => m.value);

  // Build feedback context from creator's history
  const helpfulAngles = feedbackHistory
    .filter((f: any) => f.was_helpful === true)
    .map((f: any) => {
      const data = f.recommendation_data as any;
      return data?.title || data?.contentAngle || '';
    })
    .filter(Boolean)
    .slice(0, 5);

  const unhelpfulAngles = feedbackHistory
    .filter((f: any) => f.was_helpful === false)
    .map((f: any) => {
      const data = f.recommendation_data as any;
      return data?.title || data?.contentAngle || '';
    })
    .filter(Boolean)
    .slice(0, 5);

  const feedbackCtx = helpfulAngles.length > 0 || unhelpfulAngles.length > 0
    ? `\nCREATOR FEEDBACK HISTORY (learn from this — do not repeat rejected ideas):\n${
        helpfulAngles.length > 0
          ? `Ideas this creator found valuable (lean into these angles): ${helpfulAngles.join('; ')}`
          : ''
      }\n${
        unhelpfulAngles.length > 0
          ? `Ideas this creator rejected (avoid these angles entirely): ${unhelpfulAngles.join('; ')}`
          : ''
      }`
    : '';

  const creatorIdentityCtx = voicePortrait ? `

CREATOR VOICE IDENTITY (use this to filter and angle every idea):
- Content territory: ${voicePortrait.contentTerritory}
- Primary topics they own: ${voicePortrait.primaryTopics.join(", ")}
- Audience: ${voicePortrait.audienceDescription}
- Their tone: ${voicePortrait.toneSignature}
- Personal constraints: ${voicePortrait.personalConstraints.join(", ")}
- Formats they use: ${voicePortrait.preferredFormats.join(", ")}
${voicePortrait.avoidTopics.length > 0 ? `- NEVER suggest: ${voicePortrait.avoidTopics.join(", ")}` : ""}
${topTopics.length > 0 ? `- Topics ARIA has observed them return to repeatedly: ${topTopics.join(", ")}` : ""}

CRITICAL RULE: Every single idea must be filtered through this identity.
A trend idea that does not fit this creator's territory, audience, or constraints must be excluded.
Reframe trends through the lens of what this specific creator uniquely does.
Do not give generic trend angles. Give angles only this creator could execute.${feedbackCtx}` : feedbackCtx;

  const prompt = `You are ARIA — India's creator intelligence engine.

CREATOR PROFILE:
- CONFIRMED NICHE (use this — do not override): ${ctx.niches[0] || "general"}
- Instagram handle: ${ctx.instagramHandle || "unknown"}
- Additional context: ${ctx.niches.slice(1).join(", ") || "none"}
- Archetype: ${ctx.archetypeLabel || ctx.archetype || "Creator"}
- Bio: ${ctx.bio || "not available"}
- Top hashtags: ${ctx.topHashtags.length > 0 ? ctx.topHashtags.join(", ") : "not available"}
- Brand categories: ${ctx.brandCategories.length > 0 ? ctx.brandCategories.join(", ") : "not available"}
- Platform: ${platform}
- Followers: ${followerRange}
${creatorIdentityCtx}

IMPORTANT: The CONFIRMED NICHE above is what the user selected. Always generate ideas for that niche.
The handle and bio are context only — do NOT use them to override the confirmed niche.
Data from Reddit, YouTube, TikTok (${tiktokSignals.length} videos), Pinterest (${pinterestSignals.length} pins), Google Trends (${googleSignals.length} topics) — all global, unfiltered. Match to creator's confirmed niche.

LIVE SIGNALS:
${redditCtx}${ytCtx}${tiktokCtx}${pinterestCtx}${googleCtx}

YOUR TASK:
Generate exactly 20 specific, actionable content ideas for this creator.

MANDATORY SOURCE DISTRIBUTION — you must follow this exactly:
- 4 ideas sourced from REDDIT signals above (source: "reddit")
- 4 ideas sourced from YOUTUBE signals above (source: "youtube")  
- 4 ideas sourced from TIKTOK signals above (source: "tiktok")
- 4 ideas sourced from PINTEREST signals above (source: "pinterest")
- 4 ideas sourced from GOOGLE TRENDS signals above (source: "google_trends")

If a source has fewer signals than needed, still generate 4 ideas for it — infer related trends in the creator's niche from that source's style (Pinterest = visual/aesthetic angles, Google Trends = search-intent angles, etc.)

RULES:
1. Each idea must directly reference the signal it came from — name it in whyNow
2. Content angle must be SPECIFIC — exact video concept, not a vague topic
3. Idea must match the CONFIRMED NICHE — do not generate off-niche ideas
4. Hook must be the exact first 3 seconds of the video (actual words to say or show)
5. formatSuggestion must be one of: Reel 30s | Reel 60s | Carousel | YouTube Short | Talking Head
6. velocityScore must be 60-99 based on signal strength
7. badge: HOT if score>80, RISING if 65-80, NEW if <65
8. growthSignal must reference actual numbers from the signal (views, upvotes, saves)
9. MUST match what this creator actually makes — not generic content
10. Use Indian context — ₹ prices, Indian brands (Myntra, Meesho, Nykaa, Zerodha), Indian culture

Respond ONLY with valid JSON:
{
  "resolvedNiche": "${ctx.niches[0] || "general"}", // Always use the confirmed niche
  "ideas": [
    {
      "title": "Trend name max 8 words",
      "contentAngle": "Exact video concept",
      "whyNow": "One sentence urgency tied to actual signal",
      "personalReason": "One sentence explaining why this specific trend was picked for this creator based on their identity, voice, or audience",
      "formatSuggestion": "Reel 30s | Reel 60s | Carousel | YouTube Short | Talking Head",
      "velocityScore": 88,
      "badge": "HOT|RISING|NEW",
      "growthSignal": "actual signal e.g. '2.4K upvotes in 3h on r/Entrepreneur'",
      "geo": "GLOBAL",
      "source": "reddit",
      "sourcePlatform": "reddit | youtube | tiktok | pinterest | google_trends",
      "niche": "resolved niche"
    }
  ]
}`;

  const result = await _callGroq(prompt, { useLlama: false, maxTokens: 6000 });

  if (!result?.ideas || !Array.isArray(result.ideas)) {
    logger.warn({ result }, "Groq returned invalid ideas structure");
    return [];
  }

  logger.info({ resolvedNiche: result.resolvedNiche }, "Niche resolved by Groq");

  return result.ideas.slice(0, 20).map((idea: any, idx: number) => ({
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
  const primaryNiche = userContext.niches[0] || 'general';

  // ── Step 1: Use hybrid RAG to get the pre-assembled hot window ────────────
  // This is Tier 1 — already narrowed, already embedded, ARIA-ready
  let hotWindowNarrative = '';
  let vectorTrends: any[] = [];

  try {
    const { hybridRetrieve } = await import('./retrieval/hybrid-rag.service');
    const ragResult = await hybridRetrieve({ niche: primaryNiche, forceRefresh: false });
    hotWindowNarrative = ragResult.hotWindowNarrative || '';
    vectorTrends       = ragResult.signals?.vectorResults || [];
  } catch (err: any) {
    logger.warn({ err: err.message }, 'viralIdeas: hybridRetrieve failed — falling back to direct DB');
  }

  // ── Step 2: Direct live_trends query as fallback / supplement ─────────────
  // Only used if RAG returned nothing — NEVER dump all rows, always limit
  let directSignals: any[] = [];
  if (vectorTrends.length < 5) {
    try {
      directSignals = await (prisma as any).live_trends.findMany({
        where: {
          expires_at: { gt: new Date() },
          OR: [
            { niche_tags: { has: primaryNiche } },
            { niche_tags: { has: 'general' } },
          ],
        },
        orderBy: { velocity: 'desc' },
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
      logger.warn({ err: err.message }, 'viralIdeas: direct live_trends query failed');
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
    const src = s.source || 'unknown';
    if (!bySource[src]) bySource[src] = [];
    const override = s.is_override ? ` [${s.override_reason?.toUpperCase()}]` : '';
    const format   = s.content_format && s.content_format !== 'unknown' ? ` · ${s.content_format}` : '';
    bySource[src].push(`- "${s.title}" | ${s.badge || 'NEW'} | velocity:${s.velocity || 0}${format}${override}`);
  }

  const signalContext = Object.entries(bySource)
    .map(([src, lines]) => `\n${src.toUpperCase()} SIGNALS:\n${lines.slice(0, 8).join('\n')}`)
    .join('\n');

  // ── Step 4: Fetch user context (memory, feedback history, voice portrait) ──
  const [memoryRow, feedbackHistory, voicePortrait] = await Promise.allSettled([
    (prisma as any).aria_memory.findFirst({
      where: { user_id: userContext.userId },
      select: { memory_data: true },
    }),
    (prisma as any).aria_feedback.findMany({
      where: { user_id: userContext.userId },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { was_helpful: true, recommendation_data: true },
    }),
    (prisma as any).creator_voice_profiles?.findFirst?.({
      where: { user_id: userContext.userId },
      select: { portrait: true },
    }).catch(() => null),
  ]);

  const memory        = memoryRow.status === 'fulfilled' ? (memoryRow.value as any)?.memory_data : null;
  const feedback      = feedbackHistory.status === 'fulfilled' ? feedbackHistory.value : [];
  const voice         = voicePortrait.status === 'fulfilled' ? voicePortrait.value : null;

  const helpfulAngles = (feedback as any[])
    .filter((f: any) => f.was_helpful === true)
    .map((f: any) => (f.recommendation_data as any)?.title || '')
    .filter(Boolean).slice(0, 5);

  const unhelpfulAngles = (feedback as any[])
    .filter((f: any) => f.was_helpful === false)
    .map((f: any) => (f.recommendation_data as any)?.title || '')
    .filter(Boolean).slice(0, 5);

  // ── Step 5: Build the OpenAI prompt ──────────────────────────────────────
  const prompt = `You are ARIA, India's most advanced creator intelligence engine.

CREATOR PROFILE:
- Niche: ${primaryNiche}
- Platform: ${platform}
- Follower Range: ${followerRange}
- Archetype: ${userContext.archetypeLabel || userContext.archetype || 'Creator'}
- Bio: ${userContext.bio || 'Not provided'}
- Top hashtags they use: ${userContext.topHashtags.slice(0, 5).join(', ') || 'none yet'}
${voice ? `- Voice & Tone: ${JSON.stringify(voice.portrait).substring(0, 300)}` : ''}

LIVE TREND SIGNALS (scraped from YouTube, Reddit, TikTok, Pinterest, Google — last 12-24 hours):
${signalContext || 'No live signals available — use your knowledge of Indian trends'}

${hotWindowNarrative ? `ARIA INTELLIGENCE CONTEXT:\n${hotWindowNarrative.substring(0, 800)}` : ''}

${helpfulAngles.length > 0 ? `CREATOR LIKED THESE ANGLES (use similar): ${helpfulAngles.join('; ')}` : ''}
${unhelpfulAngles.length > 0 ? `CREATOR REJECTED THESE (avoid entirely): ${unhelpfulAngles.join('; ')}` : ''}

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
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await client.chat.completions.create({
      model:       'gpt-4o-mini',
      max_tokens:  2000,
      temperature: 0.8,
      messages:    [{ role: 'user', content: prompt }],
    });

    const raw   = response.choices[0]?.message?.content || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed.ideas || [];

  } catch (err: any) {
    logger.error({ err: err.message }, 'viralIdeas: OpenAI call failed');
    // Graceful fallback — return what we have from live_trends directly
    return allSignals.slice(0, 6).map((s: any) => ({
      title:         s.title,
      format:        s.content_format === 'short_form' ? 'Reel' : 'Carousel',
      hook:          `Here's what's trending in ${primaryNiche} right now...`,
      whyNow:        s.recommendation || `Trending on ${s.source}`,
      contentAngle:  `Your take on: ${s.title}`,
      ariaTip:       'Post within 24 hours to ride the peak.',
      viralityScore: s.velocity || 50,
      badge:         s.badge || 'NEW',
      sources:       [s.source],
      isContentGap:  false,
      contentGapNote:'',
    }));
  }
}
