import { FastifyRequest, FastifyReply } from "fastify";
import axios from "axios";
import OpenAI from "openai";
import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { debitCredits } from "../services/credits.service";
import { User } from "../types";
import {
  computeVideoDNAReport,
  RawSignals,
} from "../services/videoDnaScoring.service";
import { runCompetitorGapAnalysis } from "../services/competitorGap.service";

let _openai: OpenAI | null = null;
const groq = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 30_000 });
  return _openai;
};

const YT_KEY = process.env.YOUTUBE_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────

const formatCount = (n: string | number): string => {
  const num = typeof n === "string" ? parseInt(n, 10) : n;
  if (isNaN(num)) return "0";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
};

const formatDuration = (iso: string): string => {
  const match = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return "—";
  const h = parseInt(match[1] || "0");
  const m = parseInt(match[2] || "0");
  const s = parseInt(match[3] || "0");
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const formatDate = (iso: string): string => {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Fetch YouTube data
// ─────────────────────────────────────────────────────────────────────────────

interface YouTubeVideoData {
  videoId: string;
  videoTitle: string;
  channelName: string;
  channelId: string;
  description: string;
  tags: string[];
  categoryId: string;
  publishedAt: string;      // formatted display string ("15 Jan 2023")
  publishedAtRaw: string;   // ← ISO 8601 for recency decay calc
  duration: string;
  durationSeconds: number;
  thumbnailUrl: string;
  viewCount: string;
  likeCount: string;
  commentCount: string;
  viewsRaw: number;
  likesRaw: number;
  commentsRaw: number;
  hasChapters: number;
  hasDescription: boolean;
  tagCount: number;
}

const fetchYouTubeData = async (videoId: string): Promise<YouTubeVideoData> => {
  const cacheKey = `yt_video_v2:${videoId}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as ReturnType<typeof fetchYouTubeData>;

  const response = await axios.get(
    "https://www.googleapis.com/youtube/v3/videos",
    {
      params: {
        key: YT_KEY,
        id: videoId,
        part: "snippet,statistics,contentDetails",
      },
      timeout: 10_000,
    },
  );

  const items = response.data?.items;
  if (!items?.length) throw new Error("Video not found or is private");

  const video = items[0];
  const snippet = video.snippet;
  const stats = video.statistics;
  const content = video.contentDetails;

  const views = parseInt(stats.viewCount || "0");
  const likes = parseInt(stats.likeCount || "0");
  const comments = parseInt(stats.commentCount || "0");

  // Parse ISO 8601 duration to seconds
  const durationMatch = content.duration?.match(
    /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/,
  );
  const durationSeconds = durationMatch
    ? parseInt(durationMatch[1] || "0") * 3600 +
      parseInt(durationMatch[2] || "0") * 60 +
      parseInt(durationMatch[3] || "0")
    : 0;

  const data = {
    videoId,
    videoTitle: snippet.title,
    channelName: snippet.channelTitle,
    channelId: snippet.channelId,
    description: (snippet.description || "").slice(0, 600),
    tags: (snippet.tags || []).slice(0, 20),
    categoryId: snippet.categoryId || "22",
    publishedAt: formatDate(snippet.publishedAt),  // display string
    publishedAtRaw: snippet.publishedAt || "",         // ← ISO 8601 for recency decay
    duration: formatDuration(content.duration),
    durationSeconds,
    thumbnailUrl:
      snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || "",
    viewCount: formatCount(views),
    likeCount: formatCount(likes),
    commentCount: formatCount(comments),
    viewsRaw: views,
    likesRaw: likes,
    commentsRaw: comments,
    hasChapters: (snippet.description || "").includes("0:00") ? 5 : 1, // chaptered? bonus
    hasDescription: (snippet.description || "").length > 100,
    tagCount: (snippet.tags || []).length,
  };

  await cache.set(cacheKey, data, 7200);
  return data;
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Signal extraction prompt
// AI ONLY extracts bounded integers and qualitative text.
// IT DOES NOT COMPUTE ANY FINAL SCORES.
// Temperature is 0 — extraction, not generation.
// ─────────────────────────────────────────────────────────────────────────────

const buildSignalExtractionPrompt = (
  videoData: any,
  user: Partial<User>,
): string => {
  const archetype = user?.archetype || "CREATOR";
  const niche =
    (Array.isArray(user?.niches) ? user.niches[0] : user?.niches) || "general";
  const platform = user?.primary_platform || "youtube";
  const followerRange = user?.follower_range || "unknown";
  const engRate = user?.engagement_rate || 0;

  return `You are ARIA — India's creator intelligence engine. Extract raw signals from this YouTube video.

CRITICAL RULES:
1. You are a SENSOR only. Extract signals from what you can SEE in the title, description, and tags.
2. Do NOT compute any final scores. Do NOT invent engagement numbers.
3. All numeric outputs must be bounded integers within the specified range.
4. Temperature is 0 — be deterministic. Same input = same output every time.

VIDEO DATA:
Title: "${videoData.videoTitle}"
Channel: ${videoData.channelName}
Duration: ${videoData.duration}
Views: ${videoData.viewsRaw.toLocaleString()}
Likes: ${videoData.likesRaw.toLocaleString()}
Comments: ${videoData.commentsRaw.toLocaleString()}
Tags: ${videoData.tags.join(", ") || "none"}
Description preview (first 400 chars): "${videoData.description.slice(0, 400)}"
Has chapters in description: ${videoData.hasChapters > 1 ? "Yes" : "No"}
Tag count: ${videoData.tagCount}

CREATOR CONTEXT (personalise qualitative outputs only):
Archetype: ${archetype} | Niche: ${niche} | Platform: ${platform}
Followers: ${followerRange} | Their engagement rate: ${engRate}%

INDIA CONTEXT:
Rate India relevance for the Indian YouTube audience — cultural fit, language (Hindi/Hinglish/English), topics, festivals, problems faced by Indians specifically.

SIGNAL DEFINITIONS:

HOOK SIGNALS (1–10 each):
- titleCuriosity: Does this title create genuine curiosity or FOMO? 1=boring statement, 10=irresistible must-click
- titleClarity: Is the topic crystal clear from the title alone? 1=completely unclear, 10=instantly obvious
- titleEmotionalPull: Does it trigger a strong emotion (inspiration, fear, joy, anger)? 1=flat, 10=very emotional

SEO SIGNALS (1–5 each):
- keywordPresence: Are high-volume searchable keywords in the title? 1=no keywords, 5=multiple strong keywords
- descriptionQuality: Is the full description optimised (informative, not blank/spam)? 1=blank/spam, 5=excellent
- tagRelevance: Are tags specific and relevant (not generic or spammy)? 1=irrelevant/none, 5=highly targeted
- descriptionFirstLineQuality: Is the FIRST LINE of the description compelling? (YouTube shows ~150 chars before "Show More" in search results) 1=generic/blank, 5=keyword-rich and compelling
- hasLeadMagnet: Does the description contain a link to a newsletter, free download, or community? 1=none, 5=clear prominent lead magnet

CONTENT QUALITY SIGNALS (1–10 each):
- thumbnailTitleSync: Does the thumbnail visually promise the same thing the title promises? 1=completely mismatched, 10=perfect alignment
- topicDepth: Is the topic specific and niche enough to be genuinely useful? 1=generic listicle, 10=very specific and deep
- indiaRelevance: How relevant is this content to the Indian YouTube audience? 1=irrelevant to India, 10=specifically made for India

NARRATIVE SIGNALS (1–5 each):
- hasStrongHook: Based on the title/description, is there a compelling hook in the first 30 seconds implied? 1=no hook, 5=very strong hook
- hasCTA: Is there a clear call-to-action in the description (subscribe, comment, share)? 1=no CTA, 5=multiple strong CTAs
- hasChapters: Does the description contain timestamp-based chapters? 1=no chapters, 5=well-structured chapters

DISSONANCE SIGNALS (1–5 each):
- thumbnailClutter: How visually noisy/cluttered is the implied thumbnail? 1=minimal and clean, 5=extremely cluttered (too much text, faces, arrows)
- titleOverpromise: Does the title over-promise beyond what the content likely delivers? 1=accurate and honest, 5=massive clickbait/misleading

QUALITATIVE OUTPUTS (AI-generated text — no length restrictions):
- ariaInsight: Brief 2-sentence analysis of this video's core strength and weakness.
- actionItems: Array of 3 specific improvement actions. Each starts with a verb. Max 12 words each.
- improvedHook: Rewritten version of the title that would score higher. Return null if title is already excellent.
- betterTitle: SEO-optimised title alternative with keywords. Return null if current title is already optimal.
- nextVideoSuggestion: What the creator should make next based on this video's topic. Be specific.
- nextVideoReason: One sentence explaining why that next video would perform well.
- benchmarkAnalysis: 1-2 sentences comparing this video's approach to top performers in its niche.
- benchmarkStats: Array of 2-3 short comparative stat strings like "Top 20% hook score for ${niche}" or "Below average description quality for ${platform}".
- shortsOpportunities: Array of 0-3 short-clip opportunities. Each has start (seconds), end (seconds), caption (text for the Short), viralScore (1-100), reason (why this moment is clipworthy). viralScore must be realistic: 45-70 for most clips, 80+ only for genuinely viral moments.

RESPOND ONLY with this exact JSON structure (no markdown, no text before or after):
{
  "titleCuriosity": <1-10>,
  "titleClarity": <1-10>,
  "titleEmotionalPull": <1-10>,
  "keywordPresence": <1-5>,
  "descriptionQuality": <1-5>,
  "tagRelevance": <1-5>,
  "descriptionFirstLineQuality": <1-5>,
  "hasLeadMagnet": <1-5>,
  "thumbnailTitleSync": <1-10>,
  "topicDepth": <1-10>,
  "indiaRelevance": <1-10>,
  "hasStrongHook": <1-5>,
  "hasCTA": <1-5>,
  "hasChapters": <1-5>,
  "thumbnailClutter": <1-5>,
  "titleOverpromise": <1-5>,
  "ariaInsight": "<string>",
  "actionItems": ["<string>", "<string>", "<string>"],
  "improvedHook": "<string or null>",
  "betterTitle": "<string or null>",
  "nextVideoSuggestion": "<string>",
  "nextVideoReason": "<string>",
  "benchmarkAnalysis": "<string>",
  "benchmarkStats": ["<string>", "<string>"],
  "shortsOpportunities": [
    { "start": <seconds>, "end": <seconds>, "caption": "<text>", "viralScore": <1-100>, "reason": "<text>" }
  ]
}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Call AI (signal extraction only)
// Temperature 0 = deterministic extraction, minimal variance
// ─────────────────────────────────────────────────────────────────────────────

const extractSignals = async (prompt: string): Promise<Partial<RawSignals>> => {
  const response = await groq().chat.completions.create({
    model: MODEL,
    max_tokens: 1100,
    temperature: 0, // ← CRITICAL: temperature 0 for extraction tasks
    messages: [
      {
        role: "system",
        content:
          "You are a signal extractor. Respond ONLY with a valid JSON object. No markdown, no preamble, no explanation. Start with { end with }.",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from AI");

  const clean = content
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean);
};

// ─────────────────────────────────────────────────────────────────────────────
// Second AI call: score-connected narrative
// Runs AFTER scoring is complete so it can reference actual numbers.
// This replaces the generic ariaInsight from the first extraction call.
// Temperature 0.3 — still structured but slightly more expressive.
// ─────────────────────────────────────────────────────────────────────────────

interface NarrativeScoreContext {
  overallScore:               number;
  grade:                      string;
  hookScore:                  number;
  seoScore:                   number;
  contentQualityScore:        number;
  engagementScore:            number;
  formatType:                 string;
  nicheDifficultyCoefficient: number;
  dissonancePenalty:          number;
  erVsBenchmark:              number;
  recencyDecayFactor:         number;
  engagementRate:             number;
}

const buildNarrativePrompt = (
  videoData: any,
  scores: NarrativeScoreContext,
  user: Partial<User>,
  niche: string,
): string => {
  const archetype = user?.archetype || "CREATOR";

  const lowestComponent = [
    { name: "Hook", score: scores.hookScore },
    { name: "SEO", score: scores.seoScore },
    { name: "Content Quality", score: scores.contentQualityScore },
    { name: "Engagement", score: scores.engagementScore },
  ].sort((a, b) => a.score - b.score)[0];

  const difficultyNote = scores.nicheDifficultyCoefficient > 1.0
    ? `Note: ${niche} is a low-engagement niche. A ${scores.nicheDifficultyCoefficient}x difficulty boost was applied to the engagement score, so the creator's ER is actually stronger than the raw number suggests.`
    : scores.nicheDifficultyCoefficient < 1.0
    ? `Note: ${niche} is a high-engagement niche. A ${scores.nicheDifficultyCoefficient}x reduction was applied since this audience naturally has very high ER.`
    : "";

  const recencyNote = scores.recencyDecayFactor < 0.9
    ? `Note: Recency decay factor is ${scores.recencyDecayFactor} — this is an older video. View velocity score has been adjusted down accordingly.`
    : "";

  const dissonanceNote = scores.dissonancePenalty > 0
    ? `Note: A ${scores.dissonancePenalty}-point Hook Dissonance Penalty was applied because titleCuriosity significantly exceeds titleClarity — a clickbait pattern.`
    : "";

  return `You are ARIA. Write a precise, score-connected analysis of this YouTube video.

DETERMINISTICALLY COMPUTED SCORES (these are final — do not question them):
Overall: ${scores.overallScore}/100 (Grade: ${scores.grade})
  • Hook Score:            ${scores.hookScore}/100${dissonanceNote ? " ← DISSONANCE FLAGGED" : ""}
  • SEO Score:             ${scores.seoScore}/100
  • Content Quality Score: ${scores.contentQualityScore}/100
  • Engagement Score:      ${scores.engagementScore}/100

Weakest component: ${lowestComponent.name} (${lowestComponent.score}/100) — action items must target this.
Format detected: ${scores.formatType}
ER vs niche benchmark: ${scores.erVsBenchmark}x
Engagement rate: ${scores.engagementRate}%
${difficultyNote}
${recencyNote}
${dissonanceNote}

VIDEO:
Title: "${videoData.videoTitle}"
Channel: ${videoData.channelName}

CREATOR:
Archetype: ${archetype} | Niche: ${niche}

RULES:
1. Every sentence in ariaInsight MUST reference at least one specific score number.
2. Do NOT give generic advice. Every action item must be specific to THIS video's scores.
3. benchmarkStats must be quantified (e.g. "Top 20% hook score for ${niche}" — not "good hook").
4. If dissonance penalty was applied, ariaInsight must mention it explicitly.

RESPOND ONLY with this exact JSON (no markdown, no preamble):
{
  "ariaInsight": "<2-3 sentences. Each sentence references a specific score. Example structure: 'Your Hook Score (${scores.hookScore}) is [assessment] because [specific reason from title/description]. However, your ${lowestComponent.name} Score (${lowestComponent.score}) is the main drag because [specific reason]. [One sentence on what this means for the channel's growth.]'>",
  "actionItems": [
    "<Verb + specific fix targeting ${lowestComponent.name}. Max 15 words.>",
    "<Second most critical fix. Max 15 words.>",
    "<Quick win fix. Max 15 words.>"
  ],
  "benchmarkAnalysis": "<1-2 sentences comparing this video to top ${niche} performers. Reference the ${scores.nicheDifficultyCoefficient}x difficulty coefficient if relevant. Be specific.>",
  "benchmarkStats": [
    "<Quantified stat string 1 — e.g. 'Top 15% hook score for ${niche}'>",
    "<Quantified stat string 2>",
    "<Quantified stat string 3>"
  ]
}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Handler: POST /api/v1/video-dna/analyse
// ─────────────────────────────────────────────────────────────────────────────

export const analyseVideo = async (
  req: FastifyRequest<{ Body: { videoId: string } }>,
  reply: FastifyReply,
) => {
  const { videoId } = req.body;
  const user = req.user as User;

  if (!videoId) {
    return errors.error(reply, "videoId is required", 400, "VALIDATION_ERROR");
  }
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return errors.error(
      reply,
      "Invalid YouTube video ID",
      400,
      "VALIDATION_ERROR",
    );
  }

  try {
    // Fetch full user profile for personalised signals
    const fullUser = await prisma.users.findUnique({
      where: { id: user.id },
      select: {
        archetype: true,
        niches: true,
        primary_platform: true,
        follower_range: true,
        engagement_rate: true,
        health_score: true,
        tone_profile: true,
      },
    });

    logger.info({ videoId, userId: user.id }, "Video DNA analysis started");

    // Step 1: Fetch YouTube metadata
    let videoData: any;
    try {
      videoData = await fetchYouTubeData(videoId);
    } catch (ytErr: any) {
      logger.warn({ ytErr: ytErr.message, videoId }, "YouTube API failed");
      if (
        ytErr.message.includes("not found") ||
        ytErr.message.includes("private")
      ) {
        return errors.notFound(reply, "Video");
      }
      return errors.serviceDown(reply, "YouTube API");
    }

    // ── Step 2: AI call 1 — Signal Extraction (temperature 0, deterministic) ──
    // AI acts as sensor only. Extracts bounded integers + qualitative text.
    // Does NOT compute any scores.
    const prompt = buildSignalExtractionPrompt(
      videoData,
      fullUser as Partial<User>,
    );

    let rawSignals: Partial<RawSignals>;
    try {
      rawSignals = await extractSignals(prompt);
    } catch (aiErr: any) {
      logger.error(
        { aiErr: aiErr.message, videoId },
        "Signal extraction failed",
      );
      return errors.serviceDown(reply, "ARIA signal extraction");
    }

    // ── Step 3: Resolve niche from user profile ────────────────────────────────
    const rawNiches = fullUser?.niches;
    const niche: string = (() => {
      if (Array.isArray(rawNiches) && rawNiches.length > 0) return String(rawNiches[0]);
      if (typeof rawNiches === 'string' && rawNiches.startsWith('[')) {
        try {
          const parsed = JSON.parse(rawNiches);
          if (Array.isArray(parsed) && parsed.length > 0) return String(parsed[0]);
        } catch { /* fall through */ }
      }
      if (typeof rawNiches === 'string' && rawNiches.trim()) return rawNiches.trim();
      return 'general';
    })();

    // ── Step 4: TypeScript scoring engine (deterministic, zero AI variance) ────
    // Passes publishedAtRaw, categoryId, and videoTitle for v3 improvements.
    const scoredReport = await computeVideoDNAReport(
      rawSignals,
      videoData.viewsRaw,
      videoData.likesRaw,
      videoData.commentsRaw,
      videoData.durationSeconds,
      niche,
      videoData.publishedAtRaw,   // ← NEW: for recency decay
      videoData.categoryId,        // ← NEW: for format detection
      videoData.videoTitle,        // ← NEW: for format detection via title keywords
    );

    // ── Step 5: AI call 2 — Score-Connected Narrative (temperature 0.3) ────────
    // Runs AFTER scoring so the AI can reference the actual computed numbers.
    // Replaces the generic ariaInsight from Step 2 with a score-specific one.
    let narrativeOverride: {
      ariaInsight:      string;
      actionItems:      string[];
      benchmarkAnalysis:string;
      benchmarkStats:   string[];
    } | null = null;

    try {
      const narrativePrompt = buildNarrativePrompt(
        videoData,
        {
          overallScore:               scoredReport.overallScore,
          grade:                      scoredReport.grade,
          hookScore:                  scoredReport.hookScore,
          seoScore:                   scoredReport.seoScore,
          contentQualityScore:        scoredReport.contentQualityScore,
          engagementScore:            scoredReport.engagementScore,
          formatType:                 scoredReport.formatType,
          nicheDifficultyCoefficient: scoredReport.nicheDifficultyCoefficient,
          dissonancePenalty:          scoredReport.dissonancePenalty,
          erVsBenchmark:              scoredReport.erVsBenchmark,
          recencyDecayFactor:         scoredReport.recencyDecayFactor,
          engagementRate:             scoredReport.engagementRate,
        },
        fullUser as Partial<User>,
        niche,
      );

      const narrativeResponse = await groq().chat.completions.create({
        model:      MODEL,
        max_tokens: 800,
        temperature: 0.3, // slightly more expressive for narrative — not extraction
        messages: [
          {
            role:    "system",
            content: "You are ARIA, a creator intelligence engine. Respond ONLY with valid JSON. No markdown, no preamble.",
          },
          { role: "user", content: narrativePrompt },
        ],
      });

      const narrativeContent = narrativeResponse.choices[0]?.message?.content;
      if (narrativeContent) {
        const cleanNarrative = narrativeContent
          .replace(/```json\n?/g, "")
          .replace(/```\n?/g,     "")
          .trim();
        narrativeOverride = JSON.parse(cleanNarrative);
      }
    } catch (narrativeErr: any) {
      // Non-fatal — fall back to extraction-call qualitative text
      logger.warn({ narrativeErr: narrativeErr.message, videoId }, "Narrative call failed — using extraction fallback");
    }

    // ── Step 6: Assemble final result ──────────────────────────────────────────
    // Merge scored report with video metadata.
    // Override qualitative fields with score-connected narrative if available.
    const result = {
      // Video metadata
      videoId:      videoData.videoId,
      videoTitle:   videoData.videoTitle,
      channelName:  videoData.channelName,
      publishedAt:  videoData.publishedAt,
      duration:     videoData.duration,
      thumbnailUrl: videoData.thumbnailUrl,
      viewCount:    videoData.viewCount,
      likeCount:    videoData.likeCount,
      commentCount: videoData.commentCount,

      // All scores and derived metrics from the scoring engine
      ...scoredReport,

      // Override narrative fields with score-connected versions if available
      ...(narrativeOverride && {
        ariaInsight:      narrativeOverride.ariaInsight,
        actionItems:      narrativeOverride.actionItems,
        benchmarkAnalysis:narrativeOverride.benchmarkAnalysis,
        benchmarkStats:   narrativeOverride.benchmarkStats,
        // Keep hookAnalysis and titleAnalysis in sync
        hookAnalysis:     narrativeOverride.ariaInsight,
        titleAnalysis:    narrativeOverride.benchmarkAnalysis,
      }),

      // Analysis provenance
      analysisEngine:  "v3_deterministic",
      scoringVersion:  "3.0",
    };

    // ── Step 7: Persist to DB (fire-and-forget) ────────────────────────────────
    prisma.video_dna_analyses
      .upsert({
        where:  { user_id_video_id: { user_id: user.id, video_id: videoId } },
        update: {
          result_data:      result as any,
          analysis_version: "v3",
          analysed_at:      new Date(),
        },
        create: {
          user_id:          user.id,
          video_id:         videoId,
          video_title:      videoData.videoTitle,
          channel_name:     videoData.channelName,
          result_data:      result as any,
          analysis_version: "v3",
          analysed_at:      new Date(),
        },
      })
      .catch((err: any) =>
        logger.warn({ err }, "Video DNA history save failed"),
      );

    logger.info(
      {
        videoId,
        userId: user.id,
        overallScore: result.overallScore,
        grade: result.grade,
      },
      "Video DNA v3 complete",
    );

    // Debit AFTER successful video analysis
    await debitCredits(
      user.id,
      "video_analysis",
      req.creditCheck?.modelToUse ?? "gpt-4o-mini",
      3000, // large context
      1500, // detailed analysis output
      
    ).catch((err) => logger.warn({ err }, "Debit failed — non-fatal"));

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err: any) {
    logger.error(
      { err: err.message, videoId, userId: user.id },
      "Video DNA failed",
    );
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/video-dna/history
// ─────────────────────────────────────────────────────────────────────────────

export const getHistory = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    const rows = await prisma.video_dna_analyses.findMany({
      where: { user_id: user.id },
      orderBy: { analysed_at: "desc" },
      take: 10,
      select: {
        video_id: true,
        video_title: true,
        channel_name: true,
        result_data: true,
        analysed_at: true,
        analysis_version: true,
      },
    });

    return success(
      reply,
      rows.map((row: any) => ({
        video_id: row.video_id,
        video_title: row.video_title,
        channel_name: row.channel_name,
        score: row.result_data?.overallScore,
        grade: row.result_data?.grade,
        verdict: row.result_data?.scoreVerdict,
        thumbnail_url: row.result_data?.thumbnailUrl,
        analysed_at: row.analysed_at,
        analysis_version: row.analysis_version,
      })),
    );
  } catch (err) {
    logger.error({ err }, "Video DNA history failed");
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/video-dna/competitor-gap
// ─────────────────────────────────────────────────────────────────────────────
export const getCompetitorGap = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { niche } = req.body as { niche: string };

  if (!niche?.trim()) return errors.validation(reply, "niche is required");

  try {
    const report = await runCompetitorGapAnalysis(niche, user.id);
    const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

    // Debit AFTER successful competitor gap analysis
    await debitCredits(
      user.id,
      "competitor_gap",
      modelToUse,
      2000,
      800,
      
    ).catch((err) => logger.warn({ err }, "Debit failed — non-fatal"));

    return success(reply, {
      ...report,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, "Competitor gap analysis failed");
    return errors.serviceDown(reply, "Competitor Gap Analysis");
  }
};
