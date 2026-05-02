import OpenAI from "openai";
import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import { getPlatformTimingWindows } from "../utils/platformRouter";

let _openai: OpenAI | null = null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const groq = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!_openai) _openai = new OpenAI({ apiKey });
  return _openai;
};

export interface PackageParams {
  niche: string;
  platform: string;
  archetype: string;
  followerRange: string;
  idea?: string;
  script?: string;
}

/**
 * Generate full posting package
 */
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

Respond ONLY with valid JSON:
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
  "youtubeDescription": "<if platform is YouTube: full description with timestamps + CTA>",
  "thumbnailText": "<bold text for thumbnail — max 5 words>",
  "ariaPostingTip": "<one specific tip about posting timing or strategy for this archetype>",
  "estimatedReach": "<realistic view range for this follower count>",
  "bestDayTime": "${timingWindows[0]} IST"
}`;

  const res = await groq().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 900,
    temperature: 0.7,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from OpenAI");

  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean);
};

export interface TimingParams {
  archetype: string;
  niche: string;
  platform: string;
  followerRange: string;
}

/**
 * Timing intelligence
 */
export const getTimingIntelligence = async ({
  archetype,
  niche,
  platform,
  followerRange,
}: TimingParams) => {
  const timingWindows = getPlatformTimingWindows(archetype, platform);

  const cacheKey = `launch:timing:${archetype}:${niche}:${platform}`;
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return { ...(cached as any), fromCache: true };
  } catch (_) {}

  const prompt = `You are ARIA — India's creator intelligence engine.

Generate timing intelligence for:
- Archetype: ${archetype}
- Niche: ${niche}
- Platform: ${platform}
- Followers: ${followerRange}
- Best known windows on ${platform}: ${timingWindows.join(", ")} IST

Respond ONLY with valid JSON:
{
  "bestSlots": [
    { "day": "Wednesday", "time": "7:30 PM IST", "score": 94, "reason": "One sentence why this works for this niche + archetype" },
    { "day": "Saturday", "time": "11:00 AM IST", "score": 88, "reason": "..." },
    { "day": "Friday", "time": "8:00 PM IST", "score": 82, "reason": "..." }
  ],
  "weeklyPattern": "2-sentence description of when this creator's audience is most active",
  "platformInsight": "1 sentence about ${platform}-specific timing quirk for ${niche}",
  "avoidWindows": ["Early morning", "any other time to avoid"],
  "nextBestSlot": "${timingWindows[0]} IST",
  "nextBestSlotHoursAway": 0,
  "ariaReason": "Why these windows work for a ${archetype} in ${niche} on ${platform} — 2 sentences, specific"
}`;

  const res = await groq().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 600,
    temperature: 0.6,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from OpenAI");

  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const result = JSON.parse(clean);

  try {
    await cache.set(cacheKey, result, 3600);
  } catch (_) {}

  return { ...result, fromCache: false };
};

export interface BrandAlertParams {
  niche: string;
  platform: string;
  archetype: string;
  followerRange: string;
  engagementRate?: number | string;
}

/**
 * Brand deal alert
 */
export const generateBrandAlert = async ({
  niche,
  platform,
  archetype,
  followerRange,
  engagementRate,
}: BrandAlertParams) => {
  const prompt = `You are ARIA — India's creator intelligence engine.

A ${archetype} creator in ${niche} on ${platform} has:
- Followers: ${followerRange}
- Engagement: ${engagementRate || "4"}%

Generate a brand deal alert with a ready-to-send pitch template.
Focus only on brands likely to respond to Indian creators in this niche at this size.

Respond ONLY with valid JSON:
{
  "brandOpportunities": [
    {
      "brand": "<real Indian brand or D2C brand>",
      "category": "<brand category>",
      "fitScore": 92,
      "timing": "Why now is the right time to pitch",
      "estimatedDeal": "₹15,000 – ₹40,000"
    },
    {
      "brand": "<second brand>",
      "category": "<category>",
      "fitScore": 85,
      "timing": "...",
      "estimatedDeal": "₹10,000 – ₹25,000"
    },
    {
      "brand": "<third brand>",
      "category": "<category>",
      "fitScore": 78,
      "timing": "...",
      "estimatedDeal": "₹8,000 – ₹20,000"
    }
  ],
  "pitchTemplate": {
    "subject": "<email subject line>",
    "body": "<full email body — 4 short paragraphs: intro, your stats, content idea for their brand, CTA. Use [BRAND_NAME] as placeholder. Keep under 150 words.>",
    "whatsappVersion": "<WhatsApp-friendly version — 3 lines max>"
  },
  "ariaAdvice": "One sharp insight about brand deals for this archetype right now in India"
}`;

  const res = await groq().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 800,
    temperature: 0.75,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from OpenAI");

  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean);
};

/**
 * Save launch package to DB
 */
export const saveLaunchPackage = async (userId: string, packageData: any) => {
  try {
    const row = await prisma.launch_packages.create({
      data: {
        user_id: userId,
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
