import { FastifyRequest, FastifyReply } from "fastify";
import OpenAI from "openai";
import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { debitCredits } from "../services/credits.service";
import { alertDebitFailed } from "../utils/alerting";
import { markTrialUsed } from "../services/firstExperience.service";
import { YoutubeTranscript } from "youtube-transcript";
import { User } from "../types";
import {
  computeVideoDNAReport,
  RawSignals,
} from "../services/videoDnaScoring.service";
import { runCompetitorGapAnalysis } from "../services/competitorGap.service";
import {
  analyzeThumbnailVision,
  scoreThumbnailFromVision,
} from "../services/thumbnailVision.service";
import type { ThumbnailVisionAnalysis } from "../types/thumbnail.types";

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI / Groq client — lazy singleton
// ─────────────────────────────────────────────────────────────────────────────

let _openai: OpenAI | null = null;
const groq = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 30_000 });
  return _openai;
};

const YT_KEY  = process.env.YOUTUBE_API_KEY;
const MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ─────────────────────────────────────────────────────────────────────────────
// TIMEOUTS
// AI_SIGNAL_TIMEOUT  — hard limit for signal extraction (AI call 1, blocking)
// AI_NARR_TIMEOUT    — soft limit for narrative (AI call 2, graceful fallback)
// ─────────────────────────────────────────────────────────────────────────────
const AI_SIGNAL_TIMEOUT = 18_000;  // 18 s — fail hard, can't score without signals
const AI_NARR_TIMEOUT   = 10_000;  // 10 s — fail soft, return scores with fallback text

// ─────────────────────────────────────────────────────────────────────────────
// withTimeout — races a promise against a deadline
// Uses AbortController so the underlying fetch is actually cancelled, not
// just ignored (which is the bug with naive Promise.race + setTimeout).
// ─────────────────────────────────────────────────────────────────────────────
function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ms);

  return fn(controller.signal).finally(() => clearTimeout(timer));
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const formatCount = (n: string | number): string => {
  const num = typeof n === "string" ? parseInt(n, 10) : n;
  if (isNaN(num)) return "0";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000)     return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
};

const formatDuration = (iso: string): string => {
  if (!iso) return "0:00";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return "0:00";
  const h = parseInt(m[1] || "0");
  const min = parseInt(m[2] || "0");
  const s = parseInt(m[3] || "0");
  if (h > 0) return `${h}:${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${min}:${String(s).padStart(2, "0")}`;
};

const formatDate = (iso: string): string => {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch {
    return iso;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NICHE DERIVATION — video-only, zero user-profile dependency
//
// Priority order:
//   1. Title keyword regex  (most specific — catches "How to invest your money")
//   2. YouTube categoryId   (YouTube's own classification)
//   3. Hard fallback        "general" — never falls back to user niche
//
// Benchmarked against 2025-2026 industry data:
//   Finance ER: 1.2–2.5% (low, lurker audience, high CPM)
//   Gaming ER:  3–6%      (high, superfan communities)
//   Comedy ER:  5–8%      (highest raw ER, lowest CPM)
//   Education:  2–4%      (moderate, algorithm-boosted)
//   Fitness:    2–4%      (India baseline)
// ─────────────────────────────────────────────────────────────────────────────

const deriveNicheFromVideo = (
  categoryId: string,
  title: string,
  transcript: string = "",
): string => {
  // Combine title + first 500 chars of transcript for matching.
  // Title gets 3x weight by repeating it — it's the creator's intentional signal.
  // Transcript fills gaps where the title is ambiguous or misleading.
  const t = (
    `${title} ${title} ${title} ${transcript.slice(0, 500)}`
  ).toLowerCase();

  // Title keyword map — ordered from MOST to LEAST specific
  // Each array entry: [regex, niche string matching NICHE_DIFFICULTY_MAP keys]
  const KEYWORD_NICHE_MAP: Array<[RegExp, string]> = [

    // ── COMPOUND CONTEXT GUARDS (checked first — prevent false positives) ────
    // These catch words that exist in multiple niches and need context to classify.
    // "diet" alone = fitness. "diet + economy/consumer/market/coke" = NOT fitness.
    // "health" alone = health. "health + economy/gdp/policy" = NOT health.
    [/\b(diet\s+\w+\s+(economy|market|consumer|spending|paradox|india|gdp|policy))\b/, "finance"],
    [/\b((economy|economic|gdp|inflation|rbi|market)\s+\w*\s*(diet|food|health))\b/,   "finance"],

    // ── Finance — checked FIRST and most thoroughly ───────────────────────────
    [/\b(stock market|mutual fund|sip|nifty|sensex|ipo|demat|zerodha|groww|smallcase|portfolio|dividend|equity)\b/, "stock market"],
    [/\b(crypto|bitcoin|ethereum|web3|nft|defi|blockchain)\b/,                         "crypto"],
    [/\b(personal finance|financial planning|budget|savings|expense|emi|loan|insurance|tax|itr|income tax)\b/, "personal finance"],
    [/\b(invest|investing|investment|passive income|financial freedom|retire early)\b/, "investing"],
    [/\b(economy|economic|economics|gdp|inflation|recession|rbi|monetary policy|fiscal|trade deficit|current account)\b/, "finance"],
    [/\b(consumer behaviour|consumer behavior|consumer spending|purchasing power|demand supply)\b/, "finance"],
    [/\b(paradox|behavioral economics|nudge theory|price elasticity|market failure|externality)\b/, "finance"],
    [/\b(finance|money|₹|rupee|paisa|lakh|crore|earn money|make money online|wealth)\b/, "finance"],

    // ── Tech ──────────────────────────────────────────────────────────────────
    [/\b(iphone|samsung|oneplus|pixel|smartphone|unboxing|unbox|gadget|tech review)\b/, "tech"],
    [/\b(coding|programming|developer|python|javascript|react|node|sql|api|github|leetcode)\b/, "coding"],
    [/\b(ai tool|chatgpt|claude|gemini|artificial intelligence|machine learning|llm)\b/, "tech"],
    [/\b(laptop|pc|gpu|processor|computer|hardware|software|app review)\b/,            "tech"],
    [/\b(saas|startup|product hunt|build in public)\b/,                                "saas"],

    // ── Gaming ────────────────────────────────────────────────────────────────
    [/\b(gaming|gameplay|walkthrough|playthrough|minecraft|valorant|pubg|bgmi|free fire|gta|roblox|esports|stream)\b/, "gaming"],

    // ── Education ─────────────────────────────────────────────────────────────
    [/\b(upsc|ias|ips|neet|jee|cat|gate|ssc|bank exam|ncert)\b/,                       "education"],
    [/\b(learn|tutorial|how to|explained|beginners guide|course|certification|lecture)\b/, "education"],

    // ── Health & Fitness — single words checked AFTER compound guards above ──
    [/\b(workout|gym|exercise|bodybuilding|muscle|weight loss|fat loss|cardio|hiit|calisthenics)\b/, "fitness"],
    [/\b(yoga|meditation|mindfulness|flexibility|stretching)\b/,                       "wellness"],
    // "diet" and "nutrition" only match here if NOT already matched by finance compound guards above
    [/\b(diet plan|diet tips|nutrition plan|protein intake|calories deficit|meal prep|keto diet|intermittent fasting|healthy eating)\b/, "fitness"],
    [/\b(doctor|medical|mental health|therapy|anxiety|depression|hospital|symptoms|treatment)\b/, "health"],

    // ── Food ──────────────────────────────────────────────────────────────────
    [/\b(recipe|cook|cooking|baking|food vlog|street food|restaurant|taste test|mukbang|food review)\b/, "food"],
    [/\b(biryani|curry|dal|roti|sabzi|indian food|desi food|chai|snack)\b/,            "food"],

    // ── Beauty & Fashion ──────────────────────────────────────────────────────
    [/\b(makeup|skincare|foundation|lipstick|eyeshadow|beauty routine|get ready with me)\b/, "beauty"],
    [/\b(fashion|outfit|ootd|lookbook|style|clothing|haul fashion|thrift)\b/,          "fashion"],
    [/\b(hair|haircut|hairstyle|hair care|hair color)\b/,                              "beauty"],

    // ── Travel ────────────────────────────────────────────────────────────────
    [/\b(travel|trip|vlog trip|tour|explore|destination|hotel review|flight review|backpacking|road trip)\b/, "travel"],
    [/\b(goa|kerala|rajasthan|himachal|uttarakhand|ladakh|kashmir|bali|thailand|europe trip|dubai vlog)\b/, "travel"],

    // ── Business & Entrepreneurship ───────────────────────────────────────────
    [/\b(entrepreneur|startup|business idea|side hustle|freelance|agency|ecommerce|amazon fba|dropshipping)\b/, "entrepreneurship"],
    [/\b(marketing|digital marketing|seo|social media marketing|ads|branding|sales)\b/, "marketing"],
    [/\b(productivity|time management|morning routine|habit|goal setting|self improvement)\b/, "business"],

    // ── Entertainment ─────────────────────────────────────────────────────────
    [/\b(comedy|funny|meme|roast|prank|stand.?up|sketch|skit|reaction)\b/,             "comedy"],
    [/\b(bollywood|movie review|web series|netflix|amazon prime|ott|film review)\b/,   "entertainment"],
    [/\b(music|song|singer|rap|hip hop|cover song|album|playlist|music video)\b/,      "music"],
    [/\b(cricket|ipl|football|kabaddi|sports news|match highlights|athlete)\b/,        "sports"],

    // ── Spirituality & News ───────────────────────────────────────────────────
    [/\b(bhajan|kirtan|spiritual|god|prayer|mandir|temple|astrology|vastu)\b/,         "spirituality"],
    [/\b(news|breaking|current affairs|politics|government|election|parliament)\b/,    "news"],
  ];
  for (const [regex, detectedNiche] of KEYWORD_NICHE_MAP) {
    if (regex.test(t)) return detectedNiche;
  }

  // YouTube categoryId fallback — YouTube's own classification
  const CATEGORY_MAP: Record<string, string> = {
    "1":  "entertainment",
    "2":  "automotive",
    "10": "music",
    "15": "pets",
    "17": "sports",
    "19": "travel",
    "20": "gaming",
    "22": "lifestyle",
    "23": "comedy",
    "24": "entertainment",
    "25": "news",
    "26": "lifestyle",
    "27": "education",
    "28": "tech",
    "29": "general",
  };

  return CATEGORY_MAP[categoryId] ?? "general";
  // NEVER falls back to user profile niche. "general" is the safe neutral floor.
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT FALLBACK SIGNALS — used when AI call 1 fails
// Mid-range values produce a cautious but valid score (~45/100)
// rather than a catastrophic 0 from all-minimum clamping
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_FALLBACK_SIGNALS: Partial<RawSignals> = {
  titleCuriosity:              5,
  titleClarity:                5,
  titleEmotionalPull:          5,
  keywordPresence:             3,
  descriptionQuality:          3,
  tagRelevance:                3,
  descriptionFirstLineQuality: 3,
  hasLeadMagnet:               2,
  thumbnailTitleSync:          5,
  topicDepth:                  5,
  indiaRelevance:              5,
  hasStrongHook:               3,
  hasCTA:                      2,
  hasChapters:                 1,
  thumbnailClutter:            3,
  titleOverpromise:            2,
  ariaInsight:                 "",
  actionItems:                 [],
  improvedHook:                null,
  betterTitle:                 null,
  nextVideoSuggestion:         "",
  nextVideoReason:             "",
  benchmarkAnalysis:           "",
  benchmarkStats:              [],
  shortsOpportunities:         [],
};

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK NARRATIVE — used when AI call 2 (narrative) times out/fails
// Returns score-connected text using the actual computed numbers
// ─────────────────────────────────────────────────────────────────────────────

const buildFallbackNarrative = (scores: any, videoTitle: string) => ({
  ariaInsight: `This video scored ${scores.overallScore}/100 (${scores.grade}). ` +
    `Hook strength is ${scores.hookScore}/100 — ` +
    `${scores.hookScore >= 70 ? "strong opening that should drive clicks" : "the title and thumbnail need more emotional pull to improve CTR"}. ` +
    `SEO score of ${scores.seoScore}/100 ` +
    `${scores.seoScore >= 60 ? "shows good keyword coverage" : "suggests the description and tags need more work for discoverability"}.`,
  actionItems: [
    scores.hookScore < 60
      ? `Rewrite title to add curiosity gap or emotional trigger — current hook score is ${scores.hookScore}/100`
      : `Improve description quality to strengthen SEO — current SEO score is ${scores.seoScore}/100`,
    scores.contentQualityScore < 60
      ? `Add timestamps/chapters and a strong CTA in the description — content quality is ${scores.contentQualityScore}/100`
      : `Add 3-5 relevant tags and a keyword-rich first line to the description`,
    `Analyse retention drop-off in YouTube Studio — engagement score is ${scores.engagementScore}/100`,
  ],
  benchmarkAnalysis: `Scored ${scores.overallScore}/100 in the ${scores.formatType} format category. ` +
    `Engagement rate of ${scores.engagementRate}% is ${scores.erVsBenchmark >= 1 ? "above" : "below"} niche average.`,
  benchmarkStats: [
    `Overall score: ${scores.overallScore}/100 (${scores.grade})`,
    `ER vs niche benchmark: ${scores.erVsBenchmark}x`,
    `Hook score: ${scores.hookScore}/100`,
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// YOUTUBE DATA FETCHER
// ─────────────────────────────────────────────────────────────────────────────

const fetchYouTubeData = async (videoId: string): Promise<any> => {
  const cacheKey = `yt_video:${videoId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const resp = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet,statistics,contentDetails&key=${YT_KEY}`,
    { signal: AbortSignal.timeout(8_000) },
  );

  if (!resp.ok) throw new Error(`YouTube API ${resp.status}`);
  const body = await resp.json() as any;

  if (!body.items?.length) throw new Error("video not found");

  const item    = body.items[0];
  const snippet = item.snippet  || {};
  const stats   = item.statistics   || {};
  const content = item.contentDetails || {};

  const views    = parseInt(stats.viewCount    || "0", 10);
  const likes    = parseInt(stats.likeCount    || "0", 10);
  const comments = parseInt(stats.commentCount || "0", 10);

  const durationMatch = (content.duration || "").match(
    /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/,
  );
  const durationSeconds = durationMatch
    ? parseInt(durationMatch[1] || "0") * 3600 +
      parseInt(durationMatch[2] || "0") * 60 +
      parseInt(durationMatch[3] || "0")
    : 0;

  const data = {
    videoId,
    videoTitle:     snippet.title        || "",
    channelName:    snippet.channelTitle || "",
    channelId:      snippet.channelId    || "",
    description:    (snippet.description || "").slice(0, 600),
    tags:           (snippet.tags        || []).slice(0, 20),
    categoryId:     snippet.categoryId   || "22",
    publishedAt:    formatDate(snippet.publishedAt || ""),
    publishedAtRaw: snippet.publishedAt  || "",
    duration:       formatDuration(content.duration || ""),
    durationSeconds,
    thumbnailUrl:
      snippet.thumbnails?.maxres?.url  ||
      snippet.thumbnails?.high?.url    ||
      snippet.thumbnails?.medium?.url  || "",
    viewCount:    formatCount(views),
    likeCount:    formatCount(likes),
    commentCount: formatCount(comments),
    viewsRaw:    views,
    likesRaw:    likes,
    commentsRaw: comments,
    hasChapters:    (snippet.description || "").includes("0:00") ? 5 : 1,
    hasDescription: (snippet.description || "").length > 100,
    tagCount:       (snippet.tags || []).length,
  };

  await cache.set(cacheKey, data, 7200);
  return data;
};
// ─────────────────────────────────────────────────────────────────────────────
// TRANSCRIPT FETCHER
// Uses youtube-transcript (no API key needed — uses YouTube's auto-captions).
// Returns first 3000 chars of transcript text for niche detection + signal extraction.
// Fails silently — transcript is supplementary, not blocking.
// ─────────────────────────────────────────────────────────────────────────────

const fetchTranscript = async (videoId: string): Promise<string> => {
  const cacheKey = `yt_transcript:${videoId}`;

  try {
    const cached = await cache.get(cacheKey) as string | null;
    if (cached) return cached;

    // Try English first, fall back to Hindi, then any available
    let transcriptItems: any[] = [];
    try {
      transcriptItems = await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
    } catch {
      try {
        transcriptItems = await YoutubeTranscript.fetchTranscript(videoId, { lang: "hi" });
      } catch {
        transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
      }
    }

    if (!transcriptItems?.length) return "";

    // Timestamped format: "[0:45] text" — gives AI timing context for Shorts
    const fullText = transcriptItems
      .filter((t: any) => t.text?.trim())
      .map((t: any) => {
        const secs = Math.round((t.offset || 0) / 1000);
        const m    = Math.floor(secs / 60);
        const s    = secs % 60;
        return `[${m}:${String(s).padStart(2, "0")}] ${(t.text || "").replace(/\s+/g, " ").trim()}`;
      })
      .join(" ")
      .slice(0, 3500);

    await cache.set(cacheKey, fullText, 86400);
    return fullText;

  } catch (err: any) {
    // Transcript unavailable = private video, no captions, regional block
    // This is normal — fail silently
    logger.info({ videoId, reason: err.message }, "Transcript unavailable — continuing without it");
    return "";
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL EXTRACTION PROMPT
// Strict: AI extracts bounded integers only. No scores. No user-profile bias.
// ─────────────────────────────────────────────────────────────────────────────

const buildSignalExtractionPrompt = (
  videoData: any,
  detectedNiche: string,
  transcript: string = "",
): string => {
  return `You are ARIA — India's creator intelligence engine. Extract raw signals from this YouTube video.

CRITICAL RULES:
1. You are a SENSOR only. Extract signals from what you can SEE in the title, description, and tags.
2. Do NOT compute any final scores. Do NOT invent engagement numbers.
3. All numeric outputs must be bounded integers within the specified range.
4. Temperature is 0 — be deterministic. Same input = same output every time.
5. Evaluate this video IN ITS OWN NICHE: "${detectedNiche}". Do not compare it to unrelated niches.

VIDEO DATA:
Title: "${videoData.videoTitle}"
Channel: ${videoData.channelName}
Duration: ${videoData.duration}
Views: ${videoData.viewsRaw.toLocaleString()}
Likes: ${videoData.likesRaw.toLocaleString()}
Comments: ${videoData.commentsRaw.toLocaleString()}
Tags: ${videoData.tags.join(", ") || "none"}
Description preview (first 400 chars): "${videoData.description.slice(0, 400)}"
Has chapters (0:00 timestamps): ${videoData.hasChapters > 1 ? "YES" : "NO"}
Tag count: ${videoData.tagCount}
Detected niche: ${detectedNiche}
${transcript
  ? `\nTRANSCRIPT WITH TIMESTAMPS (format: [minutes:seconds] spoken text — USE THESE TIMESTAMPS for shortsOpportunities start/end values):\n"${transcript.slice(0, 2500)}"\n\nIMPORTANT: When suggesting shortsOpportunities, look at the timestamps in the transcript above. Pick start/end values that correspond to a complete spoken idea or high-energy moment. Convert [m:ss] to total seconds for the start/end fields.`
  : "\nTRANSCRIPT: Not available — estimate shorts timestamps based on video duration (${videoData.durationSeconds}s). Spread suggestions across early, middle, and late sections of the video."
}

SIGNAL DEFINITIONS:

HOOK SIGNALS (1–10 each):
- titleCuriosity: Does the title create a compelling reason to click? 1=boring, 10=irresistible
- titleClarity: Is the title clear about what the video delivers? 1=confusing, 10=crystal clear
- titleEmotionalPull: Does the title trigger emotion (fear, desire, curiosity, FOMO)? 1=none, 10=strong

SEO SIGNALS (1–5 each):
- keywordPresence: Are high-search-volume keywords in the title for the ${detectedNiche} niche? 1=none, 5=excellent
- descriptionQuality: Is the description detailed, keyword-rich, and structured? 1=empty/generic, 5=excellent
- tagRelevance: Are tags specific, relevant, and non-spammy for ${detectedNiche}? 1=irrelevant/none, 5=excellent
- descriptionFirstLineQuality: Are the first 150 chars of description compelling (shown before "Show More")? 1=weak, 5=excellent
- hasLeadMagnet: Is there a lead magnet in description (newsletter, freebie, resource link)? 1=none, 5=strong

CONTENT QUALITY SIGNALS (1–10 each):
- thumbnailTitleSync: Does the title's promise match what the thumbnail likely shows? 1=total mismatch, 10=perfect alignment
- topicDepth: Is this a specific deep-dive or generic overview? 1=completely generic, 10=very specific and deep
- indiaRelevance: How relevant is this content to the Indian YouTube audience? 1=irrelevant, 10=specifically Indian

NARRATIVE SIGNALS (1–5 each):
- hasStrongHook: Is a compelling hook in the first 30s implied by title/description? 1=no hook, 5=very strong
- hasCTA: Is there a clear call-to-action in the description? 1=no CTA, 5=multiple strong CTAs
- hasChapters: Does the description have timestamp chapters? 1=none, 5=well-structured

DISSONANCE SIGNALS (1–5 each):
- thumbnailClutter: How visually noisy is the thumbnail likely to be? 1=minimal/clean, 5=extremely cluttered
- titleOverpromise: Does the title promise more than the content likely delivers? 1=honest, 5=massive clickbait

QUALITATIVE OUTPUTS (no length limits):
- ariaInsight: 2-sentence analysis of this video's core strength and weakness IN THE ${detectedNiche} NICHE.
- actionItems: Array of 3 specific improvement actions. Each starts with a verb. Max 12 words each.
- improvedHook: Rewritten title that would score higher for ${detectedNiche} search. null if title is already excellent.
- betterTitle: SEO-optimised title alternative with ${detectedNiche} keywords. null if current is optimal.
- nextVideoSuggestion: What the creator should make next based on this ${detectedNiche} video. Be specific.
- nextVideoReason: One sentence explaining why that next video would perform well in ${detectedNiche}.
- benchmarkAnalysis: 1-2 sentences comparing this video to top ${detectedNiche} performers on YouTube India.
- benchmarkStats: Array of 2-3 short stat strings like "Top 20% hook score for ${detectedNiche}".
- shortsOpportunities: Identify 1-3 moments from this video that would make excellent YouTube Shorts (15–90 seconds). Rules:
  * ONLY suggest if video duration is over 180 seconds. Video duration here is: ${videoData.durationSeconds} seconds.
  * Each clip must be 15–90 seconds long (end - start must be between 15 and 90).
  * start and end MUST be plain integers (no quotes, no strings). Example: "start": 45, NOT "start": "45".
  * start must be less than end. end must be less than ${videoData.durationSeconds}.
  * viralScore must be a plain integer 1-100. Realistic range: 45-70 for most clips, 80+ only for exceptional moments.
  * If transcript is available, use it to find the most quotable or high-energy spoken moment.
  * If no clear clip moments exist, return [].
RESPOND ONLY with this exact JSON (no markdown, no text before or after):
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
    { "start": 45, "end": 112, "caption": "Example caption for the Short #shorts #niche", "viralScore": 62, "reason": "High-energy explanation of core concept" }
  ]
}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// AI CALL 1 — Signal extraction with AbortSignal timeout
// Hard fail: if this fails, we use DEFAULT_FALLBACK_SIGNALS (not a 500 error)
// ─────────────────────────────────────────────────────────────────────────────

const extractSignals = async (
  prompt: string,
): Promise<{ signals: Partial<RawSignals>; usedFallback: boolean }> => {
  try {
    const response = await withTimeout(
      (signal) =>
        groq().chat.completions.create(
          {
            model:       MODEL,
            max_tokens:  1200,
            temperature: 0,
            messages: [
              {
                role:    "system",
                content: "You are a signal extractor. Respond ONLY with a valid JSON object. No markdown, no preamble, no explanation. Start with { end with }.",
              },
              { role: "user", content: prompt },
            ],
          },
          // Pass abort signal to the underlying fetch via OpenAI SDK options
          { signal } as any,
        ),
      AI_SIGNAL_TIMEOUT,
      "extractSignals",
    );

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");

    const clean = content
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g,    "")
      .trim();

    const parsed = JSON.parse(clean);
    return { signals: parsed, usedFallback: false };
  } catch (err: any) {
    logger.warn({ err: err.message }, "Signal extraction failed — using fallback signals");
    return { signals: DEFAULT_FALLBACK_SIGNALS, usedFallback: true };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NARRATIVE PROMPT BUILDER
// Runs AFTER scoring — references actual computed numbers.
// No user profile niche contamination — uses detectedNiche only.
// ─────────────────────────────────────────────────────────────────────────────

const buildNarrativePrompt = (
  videoData:      any,
  scores:         any,
  detectedNiche:  string,
): string => {
  const lowestComponent = [
    { name: "Hook",            score: scores.hookScore },
    { name: "SEO",             score: scores.seoScore },
    { name: "Content Quality", score: scores.contentQualityScore },
    { name: "Engagement",      score: scores.engagementScore },
  ].sort((a, b) => a.score - b.score)[0];

  const difficultyNote = scores.nicheDifficultyCoefficient > 1.0
    ? `Note: "${detectedNiche}" is a low-engagement niche (lurker audience). A ${scores.nicheDifficultyCoefficient}x difficulty boost was applied — the real ER is stronger than the raw number suggests.`
    : scores.nicheDifficultyCoefficient < 1.0
    ? `Note: "${detectedNiche}" is a high-engagement niche. A ${scores.nicheDifficultyCoefficient}x reduction was applied — high ER is expected here.`
    : "";

  const recencyNote = scores.recencyDecayFactor < 0.9
    ? `Note: Recency decay factor is ${scores.recencyDecayFactor} — older video. View velocity adjusted down.`
    : "";

  const dissonanceNote = scores.dissonancePenalty > 0
    ? `Note: A ${scores.dissonancePenalty}-point Hook Dissonance Penalty was applied — titleCuriosity >> titleClarity (clickbait pattern).`
    : "";

  return `You are ARIA. Write a precise, score-connected analysis of this YouTube video.

DETERMINISTICALLY COMPUTED SCORES (these are final — do not question them):
Overall: ${scores.overallScore}/100 (Grade: ${scores.grade})
  • Hook Score:            ${scores.hookScore}/100${dissonanceNote ? " ← DISSONANCE FLAGGED" : ""}
  • SEO Score:             ${scores.seoScore}/100
  • Content Quality Score: ${scores.contentQualityScore}/100
  • Engagement Score:      ${scores.engagementScore}/100

Weakest component: ${lowestComponent.name} (${lowestComponent.score}/100) — action items MUST target this.
Video niche: ${detectedNiche}
Format detected: ${scores.formatType}
ER vs niche benchmark: ${scores.erVsBenchmark}x
Engagement rate: ${scores.engagementRate}%
${difficultyNote}
${recencyNote}
${dissonanceNote}

VIDEO:
Title: "${videoData.videoTitle}"
Channel: ${videoData.channelName}

RULES:
1. Every sentence in ariaInsight MUST reference at least one specific score number.
2. Do NOT give generic advice. Every action item must target THIS video's weakest score.
3. benchmarkStats must be quantified ("Top 20% hook score for ${detectedNiche}" — not "good hook").
4. If dissonance penalty was applied, ariaInsight must mention it explicitly.
5. All advice is framed for the "${detectedNiche}" niche specifically.

RESPOND ONLY with this exact JSON (no markdown, no preamble):
{
  "ariaInsight": "<2-3 sentences. Each references a specific score number.>",
  "actionItems": [
    "<Verb + fix targeting ${lowestComponent.name}. Max 15 words.>",
    "<Second most critical fix. Max 15 words.>",
    "<Quick win fix. Max 15 words.>"
  ],
  "benchmarkAnalysis": "<1-2 sentences comparing to top ${detectedNiche} YouTube India performers.>",
  "benchmarkStats": [
    "<Quantified stat 1 — e.g. 'Top 15% hook score for ${detectedNiche}'>",
    "<Quantified stat 2>",
    "<Quantified stat 3>"
  ]
}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// AI CALL 2 — Narrative override with soft timeout + graceful fallback
// If this fails, we return the mathematical scores with fallback text.
// Users NEVER see a 500 from a narrative failure.
// ─────────────────────────────────────────────────────────────────────────────

const extractNarrative = async (
  prompt:        string,
  scoredReport:  any,
  videoData:     any,
): Promise<Partial<RawSignals> | null> => {
  try {
    const response = await withTimeout(
      (signal) =>
        groq().chat.completions.create(
          {
            model:       MODEL,
            max_tokens:  2000,
            temperature: 0.3,
            messages: [
              {
                role:    "system",
                content: "You are ARIA. Respond ONLY with a valid JSON object. No markdown, no preamble.",
              },
              { role: "user", content: prompt },
            ],
          },
          { signal } as any,
        ),
      AI_NARR_TIMEOUT,
      "extractNarrative",
    );

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const clean = content
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g,    "")
      .trim();

    return JSON.parse(clean);
  } catch (err: any) {
    logger.warn({ err: err.message }, "Narrative AI call failed — using fallback narrative");
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SHORTS OPPORTUNITY VALIDATOR
// Ensures shorts are only returned for videos long enough to clip,
// and that timestamps are valid and ordered.
// This is the root cause of "shorts not showing" — bad timestamps from AI.
// ─────────────────────────────────────────────────────────────────────────────

const validateShortsOpportunities = (
  opportunities: any[],
  videoDurationSeconds: number,
): any[] => {
  // Videos under 3 minutes cannot produce meaningful clips
  if (!videoDurationSeconds || videoDurationSeconds < 180) return [];
  if (!Array.isArray(opportunities) || opportunities.length === 0) return [];

  const MIN_CLIP_LENGTH = 15;   // seconds — shorter is unusable as a Short
  const MAX_CLIP_LENGTH = 180;  // seconds — YouTube Shorts limit is now 3 minutes (180s)

  const coerceToNumber = (val: any): number | null => {
    // Handle AI returning strings instead of integers e.g. "start": "120"
    if (typeof val === "number" && isFinite(val)) return val;
    if (typeof val === "string") {
      const parsed = parseFloat(val);
      if (!isNaN(parsed) && isFinite(parsed)) return parsed;
    }
    return null;
  };

  const validated = opportunities
    .map((opp) => {
      // Coerce — never reject on type alone
      const rawStart = coerceToNumber(opp?.start);
      const rawEnd   = coerceToNumber(opp?.end);

      if (rawStart === null || rawEnd === null) return null;

      const start      = Math.round(rawStart);
      const end        = Math.round(rawEnd);
      const clipLength = end - start;

      // Hard sanity checks
      if (start < 0)                          return null;
      if (end <= start)                       return null;
      if (clipLength < MIN_CLIP_LENGTH)       return null;
      if (clipLength > MAX_CLIP_LENGTH)       return null;
      if (start >= videoDurationSeconds)      return null;
      if (end > videoDurationSeconds + 10)    return null; // 10s tolerance for rounding

      const rawViralScore = coerceToNumber(opp?.viralScore);
      const viralScore    = rawViralScore !== null
        ? Math.min(100, Math.max(1, Math.round(rawViralScore)))
        : 50;

      return {
        start,
        end:        Math.min(videoDurationSeconds, end),
        caption:    String(opp?.caption  || "").trim().slice(0, 250),
        viralScore,
        reason:     String(opp?.reason   || "").trim().slice(0, 300),
      };
    })
    .filter((opp): opp is NonNullable<typeof opp> => opp !== null)
    .slice(0, 3);

  return validated;
};
// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER — POST /api/v1/video-dna/analyse
//
// EXECUTION ORDER (with parallelism):
//
//   Phase 1 — PARALLEL (no deps on each other):
//     [A] fetchYouTubeData(videoId)
//     [B] prisma.users.findUnique(userId)       ← only for archetype/tone in narrative
//
//   Phase 2 — SEQUENTIAL (each depends on Phase 1):
//     [C] deriveNicheFromVideo(categoryId, title)  ← pure function, instant
//     [D] buildSignalExtractionPrompt(videoData, niche)
//     [E] extractSignals(prompt)               ← AI call 1, hard fail w/ fallback
//
//   Phase 3 — SEQUENTIAL (depends on Phase 2):
//     [F] computeVideoDNAReport(signals, ...)   ← deterministic scoring engine
//
//   Phase 4 — SEQUENTIAL (depends on Phase 3):
//     [G] extractNarrative(prompt, scores, ...)  ← AI call 2, soft fail w/ fallback
//
//   Phase 5 — FIRE AND FORGET (after response is sent):
//     [H] prisma.video_dna_analyses.upsert(...)
//     [I] debitCredits(...)
//
// ─────────────────────────────────────────────────────────────────────────────

export const analyseVideo = async (
  req:   FastifyRequest<{ Body: { videoId: string } }>,
  reply: FastifyReply,
) => {
  const { videoId } = req.body;
  const user        = req.user as User;

  if (!videoId) {
    return errors.error(reply, "videoId is required", 400, "VALIDATION_ERROR");
  }
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return errors.error(reply, "Invalid YouTube video ID", 400, "VALIDATION_ERROR");
  }

  try {
    // ── PHASE 1: PARALLEL — YouTube fetch + user profile fetch + transcript + thumbnail vision ──
    // These have zero dependency on each other. Run simultaneously.
    // YouTube is the critical path; user profile, transcript, and thumbnail are supplementary.
    logger.info({ videoId, userId: user.id }, "Video DNA v4 analysis started");

    const [videoDataResult, fullUserResult, transcriptResult, thumbnailVisionResult] = await Promise.allSettled([
      fetchYouTubeData(videoId),
      prisma.users.findUnique({
        where:  { id: user.id },
        select: {
          archetype:        true,
          niches:           true,
          primary_platform: true,
          follower_range:   true,
          engagement_rate:  true,
          health_score:     true,
          tone_profile:     true,
        },
      }),
      fetchTranscript(videoId),  // ← runs in parallel, fails silently
      // Thumbnail vision call will be completed after niche is detected in Phase 2.
      // For now, we'll initialize it as a deferred promise placeholder.
      Promise.resolve(null as ThumbnailVisionAnalysis | null),
    ]);

    // YouTube is non-negotiable — fail if it failed
    if (videoDataResult.status === "rejected") {
      const ytErr = videoDataResult.reason?.message || "";
      logger.warn({ ytErr, videoId }, "YouTube API failed");
      if (ytErr.includes("not found") || ytErr.includes("private")) {
        return errors.notFound(reply, "Video");
      }
      return errors.serviceDown(reply, "YouTube API");
    }

    const videoData = videoDataResult.value;
    const fullUser  = fullUserResult.status === "fulfilled"
      ? fullUserResult.value
      : null;
    const transcript = transcriptResult.status === "fulfilled"
      ? transcriptResult.value
      : "";

    // ── PHASE 2: Niche derivation + Signal extraction + Thumbnail Vision ─────
    // Niche comes from the VIDEO — not the user profile.
    const detectedNiche = deriveNicheFromVideo(
      videoData.categoryId,
      videoData.videoTitle,
      transcript,  // ← pass transcript for improved niche detection
    );

    logger.info({ videoId, detectedNiche }, "Niche derived from video");

    // THUMBNAIL VISION: Fetch thumbnail analysis with 4-second timeout to keep total pipeline <5s
    let thumbnailAnalysis: ThumbnailVisionAnalysis | null = null;
    try {
      // Race against 4-second timeout to preserve latency SLA
      thumbnailAnalysis = await Promise.race([
        analyzeThumbnailVision(videoData.thumbnailUrl, videoData.videoTitle, detectedNiche),
        new Promise<null>((_, reject) =>
          setTimeout(
            () => reject(new Error("Thumbnail vision timeout (4s)")),
            4000,
          ),
        ),
      ]);
    } catch (visionErr) {
      // Vision failed or timed out — log and continue. AI-inferred values are fallback.
      logger.info(
        { videoId, visionErr: visionErr instanceof Error ? visionErr.message : String(visionErr) },
        "Thumbnail vision skipped — continuing with AI-inferred signals",
      );
      thumbnailAnalysis = null;
    }

    const extractionPrompt = buildSignalExtractionPrompt(
      videoData,
      detectedNiche,
      transcript,  // ← pass transcript for transcript-based signal extraction
    );
    const { signals: rawSignals, usedFallback: signalFallback } =
      await extractSignals(extractionPrompt);

    if (signalFallback) {
      logger.warn({ videoId }, "Using fallback signals — AI extraction failed");
    }

    // If vision succeeded, override AI-inferred thumbnail signals with real vision data
    if (thumbnailAnalysis) {
      const visionScores = scoreThumbnailFromVision(thumbnailAnalysis);
      rawSignals.thumbnailTitleSync = visionScores.thumbnailTitleSync;
      rawSignals.thumbnailClutter = visionScores.thumbnailClutter;
      // Mark that vision was used — for frontend display and analytics
      (rawSignals as any)._thumbnailVisionUsed = true;
      logger.info(
        { videoId, thumbnailVisionUsed: true },
        "Thumbnail vision applied to DNA signals",
      );
    }

    // ── PHASE 3: Deterministic scoring engine ─────────────────────────────────
    // This is pure TypeScript maths — no AI, no network, cannot fail.
    const scoredReport = await computeVideoDNAReport(
      rawSignals,
      videoData.viewsRaw,
      videoData.likesRaw,
      videoData.commentsRaw,
      videoData.durationSeconds,
      detectedNiche,
      videoData.publishedAtRaw,
      videoData.categoryId,
      videoData.videoTitle,
    );

    // ── PHASE 4: Narrative AI call (soft fail) ────────────────────────────────
    // If this times out or fails, we return scores + fallback text.
    // The user always gets a result.
    const narrativePrompt = buildNarrativePrompt(videoData, scoredReport, detectedNiche);
    const narrativeResult = await extractNarrative(narrativePrompt, scoredReport, videoData);

    // Merge: narrative overrides AI call 1's qualitative fields if available
    const fallbackNarrative = buildFallbackNarrative(scoredReport, videoData.videoTitle);

    const finalNarrative = narrativeResult ?? fallbackNarrative;

    // Validate and sanitise shorts opportunities
    // Pull from AI call 1 signals (where they're initially extracted)
    const rawShorts = Array.isArray(rawSignals.shortsOpportunities)
      ? rawSignals.shortsOpportunities
      : [];
    const validatedShorts = validateShortsOpportunities(
      rawShorts,
      videoData.durationSeconds,
    );

    // ── Assemble final result ─────────────────────────────────────────────────
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

      // All scores from the deterministic engine
      ...scoredReport,

      // Narrative — score-connected text (from AI call 2 or fallback)
      ariaInsight:       finalNarrative.ariaInsight       ?? fallbackNarrative.ariaInsight,
      actionItems:       finalNarrative.actionItems        ?? fallbackNarrative.actionItems,
      benchmarkAnalysis: finalNarrative.benchmarkAnalysis ?? fallbackNarrative.benchmarkAnalysis,
      benchmarkStats:    finalNarrative.benchmarkStats    ?? fallbackNarrative.benchmarkStats,

      // Qualitative from AI call 1 (not in narrative call)
      hookAnalysis:        rawSignals.ariaInsight        || "",
      improvedHook:        rawSignals.improvedHook       ?? null,
      titleAnalysis:       rawSignals.benchmarkAnalysis  || "",
      betterTitle:         rawSignals.betterTitle        ?? null,
      nextVideoSuggestion: rawSignals.nextVideoSuggestion || "",
      nextVideoReason:     rawSignals.nextVideoReason    || "",

      // Validated shorts — never undefined, always an array
      shortsOpportunities: validatedShorts,

      // Thumbnail vision — full analysis breakdown + flag for frontend
      thumbnailAnalysis:   thumbnailAnalysis ?? null,
      thumbnailVisionUsed: thumbnailAnalysis !== null,

      // Analysis metadata
      detectedNiche,
      signalFallbackUsed:  signalFallback,
      analysisEngine:      "v4_parallel",
      scoringVersion:      "4.0",
    };

    const responsePayload = {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    };

    logger.info(
      { videoId, userId: user.id, overallScore: result.overallScore, grade: result.grade, detectedNiche },
      "Video DNA v4 complete",
    );

    // ── Fire-and-forget background jobs — run AFTER we schedule the response ──
    // setImmediate pushes these to the next iteration of the event loop,
    // so they never block the HTTP response.
    setImmediate(() => {
      prisma.video_dna_analyses
        .upsert({
          where:  { user_id_video_id: { user_id: user.id, video_id: videoId } },
          update: {
            result_data:       result as any,
            thumbnail_analysis: thumbnailAnalysis ?? undefined,
            analysis_version:  "v4",
            analysed_at:       new Date(),
          },
          create: {
            user_id:            user.id,
            video_id:           videoId,
            video_title:        videoData.videoTitle,
            channel_name:       videoData.channelName,
            result_data:        result as any,
            thumbnail_analysis: thumbnailAnalysis ?? undefined,
            analysis_version:   "v4",
            analysed_at:        new Date(),
          },
        })
        .catch((err: any) => logger.warn({ err }, "Video DNA DB save failed — non-fatal"));

      debitCredits(
        user.id,
        "video_analysis",
        req.creditCheck?.modelToUse ?? "gpt-4o-mini",
        3000,
        1500,
      ).catch((err: any) => alertDebitFailed(user.id, "video_analysis", err));

      // ── MARK TRIAL AS USED ───────────────────────────────────────────
      if (req.creditCheck?.isTrial && req.creditCheck?.trialAction) {
        markTrialUsed(user.id, req.creditCheck.trialAction, { videoId, videoTitle: videoData.videoTitle })
          .catch(err => logger.warn({ err }, 'video_dna: trial mark failed — non-fatal'));
      }
    });

    // Use the standard success() utility — same shape as every other endpoint.
    // This is what api.js and the frontend expect: { success: true, data: {...} }
    return success(reply, responsePayload);

  } catch (err: any) {
    logger.error({ err: err.message, videoId, userId: user.id }, "Video DNA v4 failed");
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
      where:    { user_id: user.id },
      orderBy:  { analysed_at: "desc" },
      take:     10,
      select: {
        video_id:         true,
        video_title:      true,
        channel_name:     true,
        result_data:      true,
        analysed_at:      true,
        analysis_version: true,
      },
    });

    return success(
      reply,
      rows.map((row: any) => ({
        video_id:         row.video_id,
        video_title:      row.video_title,
        channel_name:     row.channel_name,
        score:            row.result_data?.overallScore,
        grade:            row.result_data?.grade,
        verdict:          row.result_data?.scoreVerdict,
        thumbnail_url:    row.result_data?.thumbnailUrl,
        detected_niche:   row.result_data?.detectedNiche,
        analysed_at:      row.analysed_at,
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
  req:   FastifyRequest,
  reply: FastifyReply,
) => {
  const user        = req.user as User;
  const { niche }   = req.body as { niche: string };

  if (!niche?.trim()) return errors.validation(reply, "niche is required");

  try {
    const report      = await runCompetitorGapAnalysis(niche, user.id);
    const modelToUse  = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

    await debitCredits(user.id, "competitor_gap", modelToUse, 2000, 800)
      .catch((err: any) => alertDebitFailed(user.id, "competitor_gap", err));

    return success(reply, {
      ...report,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err: any) {
    logger.error({ err: err.message }, "Competitor gap analysis failed");
    return errors.serviceDown(reply, "Competitor Gap Analysis");
  }
};