import OpenAI from "openai";
import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import {
  getPlatformTimingWindows,
  computeNextSlotHoursAway,
  BANNED_BRAND_CATEGORIES,
} from "../utils/platformRouter";

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT SETUP
// ─────────────────────────────────────────────────────────────────────────────

let _openai: OpenAI | null = null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const groq = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!_openai) _openai = new OpenAI({ apiKey });
  return _openai;
};

// ─────────────────────────────────────────────────────────────────────────────
// CACHE TTLs  (seconds)
// ─────────────────────────────────────────────────────────────────────────────

const TIMING_CACHE_TTL      = 12 * 60 * 60;  // 12 hours — platform windows don't shift hourly
const BRAND_ALERT_CACHE_TTL = 30 * 60;        // 30 min — fresh enough, avoids triple-LLM on refresh

export interface PackageParams {
  niche: string;
  platform: string;
  archetype: string;
  followerRange: string;
  idea?: string;
  script?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// POSTING PACKAGE
// ─────────────────────────────────────────────────────────────────────────────

export const generatePostingPackage = async ({
  niche,
  platform,
  archetype,
  followerRange,
  idea,
  script,
}: PackageParams) => {
  const timingWindows = getPlatformTimingWindows(archetype, platform);

  const prompt = `You are ARIA — India's creator intelligence engine.

Generate a complete posting package for this creator:
- Niche: ${niche}
- Platform: ${platform}
- Archetype: ${archetype}
- Followers: ${followerRange}
- Content idea: "${idea || "general content"}"
${script ? `- Script excerpt: "${script.slice(0, 200)}"` : ""}

Best posting windows for this archetype on ${platform} (IST): ${timingWindows.join(", ")}

Respond ONLY with valid JSON. No markdown fences, no preamble:
{
  "caption": "<full caption with emojis, 3-4 lines, culturally relevant, ends with soft CTA>",
  "firstComment": "<comment to post immediately after — hashtags + engagement booster>",
  "hashtags": {
    "mega": ["<hashtag with >1M posts>", "<hashtag>", "<hashtag>"],
    "mid": ["<100K-1M posts>", "<hashtag>", "<hashtag>"],
    "niche": ["<under 100K>", "<hashtag>", "<hashtag>"]
  },
  "altText": "<accessibility alt text describing the visual>",
  "storyCopy": "<3-line story text to share alongside the post>",
  "youtubeDescription": "<if platform is YouTube: full description with timestamps + CTA, else empty string>",
  "thumbnailText": "<bold text for thumbnail — max 5 words>",
  "ariaPostingTip": "<one specific tip about posting timing or strategy for this archetype>",
  "estimatedReach": "<realistic view range for this follower count>",
  "bestDayTime": "${timingWindows[0]} IST"
}`;

  const res = await groq().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 900,
    temperature: 0.65,  // tighter than before — less creative drift on structured output
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from LLM");

  return safeParseJSON(text);
};

export interface TimingParams {
  archetype: string;
  niche: string;
  platform: string;
  followerRange: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMING INTELLIGENCE
// ─────────────────────────────────────────────────────────────────────────────

export const getTimingIntelligence = async ({
  archetype,
  niche,
  platform,
  followerRange,
}: TimingParams) => {
  const timingWindows = getPlatformTimingWindows(archetype, platform);
  const primarySlot   = timingWindows[0];

  // ── Cache check ──────────────────────────────────────────────────────────
  const cacheKey = `launch:timing:v2:${archetype}:${niche}:${platform}`;
  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      // Re-compute hoursAway server-side on every read — it changes every hour
      const data = cached as any;
      data.nextBestSlotHoursAway = computeNextSlotHoursAway(data.nextBestSlot ?? primarySlot);
      return { ...data, fromCache: true };
    }
  } catch (_) { /* redis miss is non-fatal */ }

  // ── LLM call ─────────────────────────────────────────────────────────────
  const prompt = `You are ARIA — India's creator intelligence engine.

Generate timing intelligence for:
- Archetype: ${archetype}
- Niche: ${niche}
- Platform: ${platform}
- Followers: ${followerRange}
- Seeded windows on ${platform} (IST): ${timingWindows.join(", ")}

Rules:
1. Your bestSlots MUST be chosen from the seeded windows above. Do not invent new times.
2. Assign a score (0-100) and one-sentence reason to each slot.
3. avoidWindows should be specific (e.g. "Before 8 AM", "Post-midnight") not generic.

Respond ONLY with valid JSON. No markdown fences, no preamble:
{
  "bestSlots": [
    { "day": "<day from seed>", "time": "<time from seed> IST", "score": 94, "reason": "<why this works for this niche + archetype — 1 sentence>" },
    { "day": "<day>", "time": "<time> IST", "score": 88, "reason": "<...>" },
    { "day": "<day>", "time": "<time> IST", "score": 82, "reason": "<...>" }
  ],
  "weeklyPattern": "<2-sentence description of when this creator's audience is most active>",
  "platformInsight": "<1 sentence about ${platform}-specific timing quirk for ${niche}>",
  "avoidWindows": ["<specific window to avoid>", "<another>"],
  "nextBestSlot": "${primarySlot}",
  "ariaReason": "<Why these windows work for a ${archetype} in ${niche} on ${platform} — 2 sentences, specific>"
}`;

  const res = await groq().chat.completions.create({
    model:      OPENAI_MODEL,
    max_tokens: 600,
    temperature: 0.4,   // reduced from 0.6 — timing output must be consistent, not creative
    messages:   [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from LLM");

  const result = safeParseJSON(text);

  // ── Inject server-computed hoursAway (never trust LLM for this) ──────────
  const resolvedSlot = result.nextBestSlot ?? primarySlot;
  result.nextBestSlot        = resolvedSlot;
  result.nextBestSlotHoursAway = computeNextSlotHoursAway(resolvedSlot);

  // ── Cache (without hoursAway — we recompute on every read) ───────────────
  try {
    const toCache = { ...result };
    delete toCache.nextBestSlotHoursAway; // always recomputed server-side
    await cache.set(cacheKey, toCache, TIMING_CACHE_TTL);
  } catch (_) { /* non-fatal */ }

  return { ...result, fromCache: false };
};

export interface BrandAlertParams {
  niche: string;
  platform: string;
  archetype: string;
  followerRange: string;
  engagementRate?: number | string;
}

// ─────────────────────────────────────────────────────────────────────────────
// BRAND ALERT
// ─────────────────────────────────────────────────────────────────────────────

export const generateBrandAlert = async ({
  niche,
  platform,
  archetype,
  followerRange,
  engagementRate,
}: BrandAlertParams) => {

  // ── Cache check — keyed by niche + followerRange + platform ──────────────
  // engagementRate intentionally excluded from key; same niche/size => same brands
  const cacheKey = `launch:brand:v2:${niche}:${followerRange}:${platform}`;
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return { ...(cached as any), fromCache: true };
  } catch (_) { /* non-fatal */ }

  const bannedList = BANNED_BRAND_CATEGORIES.join(', ');

  const prompt = `You are ARIA — India's creator intelligence engine.

A ${archetype} creator in ${niche} on ${platform} has:
- Followers: ${followerRange}
- Engagement: ${engagementRate || "4"}%

Generate a brand deal alert with a ready-to-send pitch template.

STRICT RULES:
1. Only suggest brands that have an active presence on Indian social media and have run influencer campaigns in India.
2. Only suggest brands that are currently operating in India (not shut down or exited the market).
3. DO NOT suggest brands from these categories: ${bannedList}.
4. DO NOT suggest competitor creator analytics platforms or SaaS tools.
5. Estimated deal values must be realistic for the follower range given (nano/micro/mid-tier differ significantly).
6. If you are not confident a brand is real and active, replace it with a well-known Indian D2C brand in the same category.

Focus only on brands likely to respond to Indian creators in ${niche} at this follower size.

Respond ONLY with valid JSON. No markdown fences, no preamble:
{
  "brandOpportunities": [
    {
      "brand": "<real, active Indian brand or D2C brand>",
      "category": "<brand category>",
      "fitScore": 92,
      "timing": "<why now is the right time to pitch — 1 sentence>",
      "estimatedDeal": "₹15,000 – ₹40,000",
      "pitchAngle": "<one-line content idea specifically for this brand>"
    },
    {
      "brand": "<second brand>",
      "category": "<category>",
      "fitScore": 85,
      "timing": "<...>",
      "estimatedDeal": "₹10,000 – ₹25,000",
      "pitchAngle": "<...>"
    },
    {
      "brand": "<third brand>",
      "category": "<category>",
      "fitScore": 78,
      "timing": "<...>",
      "estimatedDeal": "₹8,000 – ₹20,000",
      "pitchAngle": "<...>"
    }
  ],
  "pitchTemplate": {
    "subject": "<email subject line>",
    "body": "<full email body — 4 short paragraphs: intro, your stats, content idea for their brand, CTA. Use [BRAND_NAME] as placeholder. Keep under 150 words.>",
    "whatsappVersion": "<WhatsApp-friendly version — 3 lines max>"
  },
  "ariaAdvice": "<One sharp insight about brand deals for this archetype right now in India>"
}`;

  const res = await groq().chat.completions.create({
    model:       OPENAI_MODEL,
    max_tokens:  900,
    temperature: 0.7,
    messages:    [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from LLM");

  const result = safeParseJSON(text);

  // ── Cache ─────────────────────────────────────────────────────────────────
  try {
    await cache.set(cacheKey, result, BRAND_ALERT_CACHE_TTL);
  } catch (_) { /* non-fatal */ }

  return { ...result, fromCache: false };
};

// ─────────────────────────────────────────────────────────────────────────────
// SAVE LAUNCH PACKAGE TO DB
// ─────────────────────────────────────────────────────────────────────────────

export const saveLaunchPackage = async (userId: string, packageData: any): Promise<string | null> => {
  try {
    const row = await prisma.launch_packages.create({
      data: {
        user_id:      userId,
        package_data: packageData as any,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    logger.warn({ err }, "Could not save launch package");
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strips markdown fences and parses JSON safely.
 * Throws a descriptive error if parsing fails so the controller can log it.
 */
const safeParseJSON = (raw: string): any => {
  const clean = raw
    .replace(/^```(?:json)?\n?/gm, '')
    .replace(/^```\n?/gm, '')
    .trim();
  try {
    return JSON.parse(clean);
  } catch (err) {
    throw new Error(`LLM returned non-JSON output: ${clean.slice(0, 200)}`);
  }
};
