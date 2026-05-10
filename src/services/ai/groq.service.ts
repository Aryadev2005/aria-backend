import { ChatOpenAI } from "@langchain/openai";
import { logger } from "../../utils/logger";

const createOpenAIClient = (useLlama = false, maxTokens = 1000) =>
  new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    // Keep old "useLlama" toggle semantics by mapping to heavy/light OpenAI models.
    model: useLlama
      ? process.env.OPENAI_REASONING_MODEL ||
        process.env.OPENAI_MODEL ||
        "gpt-4o"
      : process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0,
    maxTokens,
    timeout: 25000,
  });

// ─── JSON parser — strips markdown fences if LLM adds them ────────────────
const parseJSON = (text: string) => {
  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean);
};

export interface GroqCallOptions {
  maxTokens?: number;
  useLlama?: boolean;
  maxRetries?: number;
  model?: string;
}

/**
 * CORE CALLER — every function routes through here
 * Retries 3x with exponential backoff
 * Uses stricter system prompt on retry to fix JSON hallucinations
 */
export const _callGroq = async (
  prompt: string,
  {
    maxTokens = 1000,
    useLlama = false,
    maxRetries = 3,
    model: modelOverride,
  }: GroqCallOptions = {},
): Promise<any> => {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required for AI analysis");
  }

  // ── Determine model ─────────────────────────────────────────────────────────
  // Explicit model override takes precedence, then useLlama logic, then defaults
  const model =
    modelOverride ||
    (useLlama
      ? process.env.OPENAI_REASONING_MODEL ||
        process.env.OPENAI_MODEL ||
        "gpt-4o"
      : process.env.OPENAI_MODEL || "gpt-4o-mini");

  // ── Create client ONCE outside the retry loop ─────────────────────────────
  // Previously this was inside the loop — wasteful on every retry attempt.
  const llm = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model,
    temperature: 0,
    maxTokens,
    timeout: 20000, // reduced from 25s → 20s; fail fast and retry sooner
  });

  let lastErr: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const systemContent =
        attempt === 1
          ? "You are ARIA — India's creator intelligence engine. Always respond with valid JSON only. No preamble, no markdown fences."
          : "CRITICAL: Respond ONLY with a raw JSON object. No text before or after. No ```json. No explanation. Start your response with { and end with }.";

      const completion = await llm.invoke([
        { role: "system", content: systemContent },
        { role: "user", content: prompt },
      ]);

      const rawContent = completion.content;
      const content = Array.isArray(rawContent)
        ? rawContent
            .map((part: any) =>
              typeof part === "string" ? part : part?.text || "",
            )
            .join("")
        : String(rawContent || "");
      if (!content) throw new Error("Empty response from OpenAI");

      try {
        return parseJSON(content);
      } catch (jsonErr) {
        logger.warn(
          { jsonErr, attempt, content: content.slice(0, 200) },
          "OpenAI JSON parse failed — retrying",
        );
        lastErr = jsonErr;
      }
    } catch (err: any) {
      logger.warn({ err: err.message, attempt, model }, "OpenAI call failed");
      lastErr = err;
      if (
        err.status === 401 ||
        err.status === 403 ||
        err.code === "invalid_api_key"
      )
        break;
    }

    if (attempt < maxRetries) {
      // Reduced backoff: 1s, 2s (was 2s, 4s)
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  logger.error(
    { err: lastErr, prompt: prompt.slice(0, 100) },
    "OpenAI exhausted all retries",
  );
  throw lastErr || new Error("OpenAI call failed after retries");
};

// Alias used by ariaService.js (older service)
export const callARIA = _callGroq;

// ─────────────────────────────────────────────────────────────────────────────
// ARIA FUNCTIONS
// Heavy reasoning (archetype, persona, rate card) → useLlama: true
// Fast simple tasks (hooks, rewrite, analyse) → useLlama: false (default)
// ─────────────────────────────────────────────────────────────────────────────

export interface ArchetypeParams {
  niche: string;
  platform: string;
  followerRange: string;
  creatorIntent: string;
  scrapedData?: any;
}

export const detectArchetype = async ({
  niche,
  platform,
  followerRange,
  creatorIntent,
  scrapedData,
}: ArchetypeParams) => {
  const prompt = `You are ARIA - an AI creator intelligence system. Analyze this creator profile and detect their archetype.

Creator Profile:
- Niche: ${niche}
- Platform: ${platform}
- Follower Range: ${followerRange}
- Intent: ${creatorIntent}
${scrapedData ? `- Bio/Data: ${JSON.stringify(scrapedData)}` : ""}

Archetypes in India's creator economy:
- THE EDUCATOR: teaches skills, builds authority
- THE ENTERTAINER: viral content, trend-chaser
- THE INFLUENCER: lifestyle, aspirational
- THE BUILDER: behind-the-scenes, community-focused
- THE STORYTELLER: narrative-driven, emotional
- THE EXPERT: niche authority, consulting

Respond ONLY with valid JSON:
{
  "archetype": "EDUCATOR|ENTERTAINER|INFLUENCER|BUILDER|STORYTELLER|EXPERT",
  "archetypeLabel": "descriptive label",
  "archetypeConfidence": 85,
  "growthStage": "DISCOVERY|GROWTH|MONETIZATION|SCALE",
  "toneProfile": "casual|professional|humorous|inspirational|educational"
}`;

  // Llama 70B — archetype detection needs nuanced reasoning
  return _callGroq(prompt, { maxTokens: 500, useLlama: true });
};

export interface GapParams {
  archetype: string;
  niche: string;
  platform: string;
  followerRange: string;
  scrapedData?: any;
  engagementRate: number;
}

export const analyzeGaps = async ({
  archetype,
  niche,
  platform,
  followerRange,
  scrapedData,
  engagementRate,
}: GapParams) => {
  const prompt = `You are ARIA. Analyze content gaps for a ${archetype} creator in ${niche} on ${platform}.

Current Data:
- Follower Range: ${followerRange}
- Engagement Rate: ${engagementRate}%
${scrapedData ? `- Creator Data: ${JSON.stringify(scrapedData)}` : ""}

Respond ONLY with valid JSON:
{
  "contentGaps": [
    { "gap": "Not enough video content", "opportunity": "High", "recommendation": "Increase Reel frequency to 3x/week" }
  ],
  "underexploredFormats": ["Shorts", "Stories"],
  "copycatVsOriginal": { "copycat%": 35, "originalContent%": 65, "verdict": "Healthy mix" },
  "topicClusters": ["Fashion", "Lifestyle"],
  "estimatedMissingFollowers": 5000,
  "gapScore": 72
}`;

  return _callGroq(prompt, { maxTokens: 800, useLlama: true });
};

export interface ViralBlueprintParams {
  archetype: string;
  niche: string;
  platform: string;
  followerRange: string;
  gaps?: any;
  toneProfile?: string;
}

export const generateViralBlueprint = async ({
  archetype,
  niche,
  platform,
  followerRange,
  gaps,
  toneProfile,
}: ViralBlueprintParams) => {
  const prompt = `You are ARIA. Generate a viral growth blueprint for a ${archetype} ${niche} creator on ${platform}.

Blueprint parameters:
- Followers: ${followerRange}
- Tone: ${toneProfile}
- Content Gaps: ${JSON.stringify(gaps?.contentGaps?.slice(0, 3) || [])}

Respond ONLY with valid JSON:
{
  "30dayBlueprint": {
    "week1": "Post 3 Reels on trending sounds. Focus on hook optimization.",
    "week2": "Introduce Carousel format. Test gap content.",
    "week3": "Cross-promote across Stories + Reels",
    "week4": "Analyze best-performing format. Double down."
  },
  "viralMechanics": ["Hook", "Pattern interrupt", "CTA"],
  "contentMixRecommendation": { "reels": 60, "carousels": 25, "stories": 15 },
  "bestTimeToPost": "7:00 PM IST Wed-Sat",
  "recommendedFrequency": "5x per week",
  "expectedGrowthIn30Days": "15-25%"
}`;

  return _callGroq(prompt, { maxTokens: 1000, useLlama: true });
};

export interface PersonaParams {
  niche: string;
  platform: string;
  followerRange: string;
  creatorIntent: string;
  scrapedData?: any;
  engagementRate: number;
}

export const fullPersonaGrowthMap = async ({
  niche,
  platform,
  followerRange,
  creatorIntent,
  scrapedData,
  engagementRate,
}: PersonaParams) => {
  const prompt = `You are ARIA - India's top AI creator intelligence. Generate a complete persona growth map.

Creator:
- Niche: ${niche}
- Platform: ${platform}
- Followers: ${followerRange}
- Engagement: ${engagementRate}%
- Intent: ${creatorIntent}

Respond ONLY with valid JSON:
{
  "personaSummary": "2-3 sentence overview of creator's position",
  "growthStage": "DISCOVERY|GROWTH|MONETIZATION|SCALE",
  "currentHealthScore": 72,
  "nextMilestone": "50K followers",
  "daysToNextMilestone": 45,
  "archetypeProfile": "Creator archetype and strength areas",
  "immediateActions": ["Action 1: description", "Action 2: description"],
  "contentStrategy": {
    "themes": ["Theme 1", "Theme 2"],
    "formats": ["Reels", "Carousels"],
    "frequency": "5x/week"
  },
  "growthProjections": { "month1": 18000, "month3": 25000, "month6": 45000 },
  "riskFactors": ["Risk 1"],
  "opportunityWindows": ["Opportunity 1"],
  "monetizationReadiness": 65,
  "nextSteps": ["Step 1", "Step 2"]
}`;

  // Llama 70B — flagship analysis needs max intelligence
  return _callGroq(prompt, { maxTokens: 1500, useLlama: true });
};

export interface ContentParams {
  trendTitle: string;
  platform: string;
  niche: string;
  followerRange: string | null;
  songTitle?: string | null;
  tone?: string | null;
  language?: string | null;
  archetype?: string | null;
  model?: string;
}

export const generateContent = async ({
  trendTitle,
  platform,
  niche,
  followerRange,
  songTitle,
  tone = "casual",
  language = "hinglish",
  archetype,
  model,
}: ContentParams) => {
  const prompt = `You are India's top social media content strategist for ${archetype || "creator"}.

Creator: ${niche} niche, ${platform}, ${followerRange} followers
Topic: "${trendTitle}"
${songTitle ? `Song: "${songTitle}"` : ""}
Tone: ${tone}, Language: ${language}

Respond ONLY with valid JSON:
{
  "hook": "attention-grabbing first line using Indian context and ₹ for prices",
  "caption": "full caption with emojis, 3-4 sentences, culturally relevant",
  "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8"],
  "bestTimeToPost": "Day · HH:MM PM IST",
  "contentFormat": "Reel|Carousel|Stories",
  "expectedEngagement": "High saves, Medium comments",
  "thumbnailText": "bold thumbnail text",
  "cta": "call to action"
}`;

  // Llama 70B — content generation benefits from creativity
  return _callGroq(prompt, { maxTokens: 1000, useLlama: true, model });
};

export interface HookParams {
  topic: string;
  platform: string;
  niche: string;
  followerRange: string | null;
  archetype?: string | null;
  model?: string;
}

export const generateHooks = async ({
  topic,
  platform,
  niche,
  followerRange,
  archetype,
  model,
}: HookParams) => {
  const prompt = `Generate 5 hooks for Indian ${niche} ${archetype || "creator"} on ${platform} (${followerRange} followers).
Topic: "${topic}"

Respond ONLY with valid JSON:
{
  "hooks": [
    { "text": "hook text", "trigger": "curiosity|controversy|relatability|fear|aspiration", "rating": 85 }
  ]
}`;

  // Mixtral — fast enough, hooks are pattern-based
  return _callGroq(prompt, { maxTokens: 800, useLlama: false, model });
};

export interface RewriteHookParams {
  hook: string;
  platform: string;
  niche: string | null;
  archetype?: string | null;
  model?: string;
}

export const rewriteHook = async ({
  hook,
  platform,
  niche,
  archetype,
  model,
}: RewriteHookParams) => {
  const prompt = `Rewrite this hook 5 stronger ways for Indian ${niche} ${archetype || "creator"} on ${platform}:
"${hook}"

Respond ONLY with valid JSON:
{
  "rewrites": [
    { "text": "rewritten hook", "improvement": "why this is better", "rating": 90 }
  ]
}`;

  // Mixtral — fast, pattern-based task
  return _callGroq(prompt, { maxTokens: 800, useLlama: false, model });
};

export interface RepurposeParams {
  content: string;
  sourcePlatform: string;
  targetPlatforms: string[];
  model?: string;
}

export const repurposeContent = async ({
  content,
  sourcePlatform,
  targetPlatforms,
  model,
}: RepurposeParams) => {
  const prompt = `Repurpose this ${sourcePlatform} content for: ${targetPlatforms.join(", ")}
"${content}"

Respond ONLY with valid JSON:
{
  "repurposed": {
    "instagram": { "caption": "", "hashtags": [], "format": "Reel" },
    "youtube":   { "title": "", "description": "", "tags": [] },
    "twitter":   { "tweet": "", "thread": [] }
  }
}`;

  return _callGroq(prompt, { maxTokens: 1000, useLlama: false, model });
};

export interface AnalyseContentParams {
  caption: string;
  platform: string;
  niche: string | null;
  archetype?: string | null;
  model?: string;
}

export const analyseContent = async ({
  caption,
  platform,
  niche,
  archetype,
  model,
}: AnalyseContentParams) => {
  const prompt = `Analyze this ${platform} content for a ${niche} ${archetype || "creator"}:
"${caption}"

Respond ONLY with valid JSON:
{
  "hookEffectiveness": 85,
  "emotionalTrigger": "aspiration",
  "callToAction": "Identified",
  "estimatedReach": "High",
  "recommendations": ["Specific recommendation 1"],
  "score": 82
}`;

  // Mixtral — fast analysis
  return _callGroq(prompt, { maxTokens: 600, useLlama: false, model });
};

export interface TrendInsightParams {
  niche: string;
  platform: string;
  followerRange: string;
  archetype?: string | null;
  liveTrendsContext?: string;
  imputationContext?: any;
}

export const generateTrendInsights = async ({
  niche,
  platform,
  followerRange,
  archetype,
  liveTrendsContext,
  imputationContext,
}: TrendInsightParams) => {
  // If we have early signals, tell ARIA to be honest about uncertainty
  const uncertaintyNote = imputationContext?.hasEarlySignals
    ? '\nNOTE: Some signals are under 6 hours old. For those, say "ARIA is monitoring" instead of a confident peak window. Never invent engagement numbers for early signals.'
    : "";

  const prompt = `You are ARIA. Generate trend insights for a ${niche} ${archetype || "creator"} on ${platform} (${followerRange} followers).
${liveTrendsContext ? `Live market context: ${liveTrendsContext}` : ""}
${uncertaintyNote}

Respond ONLY with valid JSON:
{
  "trends": [
    {
      "title": "trend name",
      "description": "why it matters right now",
      "badge": "HOT|RISING|STABLE",
      "searchVolume": 45000,
      "velocity": 85,
      "opportunityScore": 92,
      "recommendation": "Specific action to take",
      "expiresIn": "3 days",
      "confidence": "HIGH|MEDIUM|LOW",
      "caution": null
    }
  ]
}`;

  return _callGroq(prompt, { maxTokens: 1200, useLlama: true });
};

export interface SongInsightParams {
  niche: string;
  platform: string;
  archetype?: string;
}

export const generateSongInsights = async ({
  niche,
  platform,
  archetype,
}: SongInsightParams) => {
  const prompt = `You are ARIA. Generate song insights for trending audio clips for ${niche} creators on ${platform}.
Archetype: ${archetype || "general"}

Respond ONLY with valid JSON:
{
  "songs": [
    {
      "title": "song title",
      "artist": "artist name",
      "uses": 12500,
      "growth": "+340% this week",
      "viralPotential": 88,
      "bestFor": "Reels|Stories",
      "recommendation": "How and when to use this"
    }
  ]
}`;

  return _callGroq(prompt, { maxTokens: 1000, useLlama: false });
};

export interface RateCardParams {
  followers: string | number;
  engagement: number;
  niche: string;
  platform: string;
  archetype?: string;
}

export const generateRateCard = async ({
  followers,
  engagement,
  niche,
  platform,
  archetype,
}: RateCardParams) => {
  const prompt = `You are ARIA. Generate a sponsorship rate card for a ${niche} ${archetype || "creator"}.

Stats:
- Followers: ${followers}
- Engagement: ${engagement}%
- Platform: ${platform}

Respond ONLY with valid JSON:
{
  "rateCard": {
    "singlePost": 15000,
    "3posts": 40000,
    "monthlyPartnership": 100000,
    "benchmarkAgainstPeers": "20th percentile (higher is better)"
  },
  "recommendation": "Your rate is competitive for your niche"
}`;

  // Llama 70B — pricing needs reasoning about Indian market rates
  return _callGroq(prompt, { maxTokens: 500, useLlama: true });
};
