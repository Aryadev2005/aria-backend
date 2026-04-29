// src/services/launch.service.js
// ARIA Launch — timing intelligence, posting package, brand deal alerts
'use strict';

const Groq = require('groq-sdk');
const { getDB } = require('../config/database');
const { cache } = require('../config/redis');
const { logger } = require('../utils/logger');
const { getPlatformTimingWindows } = require('../utils/platformRouter');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Generate full posting package ───────────────────────────────────────────
const generatePostingPackage = async ({ niche, platform, archetype, followerRange, idea, script }) => {
  const timingWindows = getPlatformTimingWindows(archetype, platform);

  const prompt = `You are ARIA — India's creator intelligence engine.

Generate a complete posting package for this creator:
- Niche: ${niche}
- Platform: ${platform}
- Archetype: ${archetype}
- Followers: ${followerRange}
- Content idea: "${idea || 'general content'}"
${script ? `- Script excerpt: "${script.slice(0, 200)}"` : ''}

Best posting windows for this archetype on ${platform} (IST): ${timingWindows.join(', ')}

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

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 900,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.choices[0].message.content;
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
};

// ─── Timing intelligence ──────────────────────────────────────────────────────
const getTimingIntelligence = async ({ archetype, niche, platform, followerRange }) => {
  const timingWindows = getPlatformTimingWindows(archetype, platform);

  const cacheKey = `launch:timing:${archetype}:${niche}:${platform}`;
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return { ...cached, fromCache: true };
  } catch (_) {}

  const prompt = `You are ARIA — India's creator intelligence engine.

Generate timing intelligence for:
- Archetype: ${archetype}
- Niche: ${niche}
- Platform: ${platform}
- Followers: ${followerRange}
- Best known windows on ${platform}: ${timingWindows.join(', ')} IST

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

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 600,
    temperature: 0.6,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.choices[0].message.content;
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const result = JSON.parse(clean);

  try { await cache.set(cacheKey, result, 3600); } catch (_) {}

  return { ...result, fromCache: false };
};

// ─── Brand deal alert ─────────────────────────────────────────────────────────
const generateBrandAlert = async ({ niche, platform, archetype, followerRange, engagementRate }) => {
  const prompt = `You are ARIA — India's creator intelligence engine.

A ${archetype} creator in ${niche} on ${platform} has:
- Followers: ${followerRange}
- Engagement: ${engagementRate || '4'}%

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

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 800,
    temperature: 0.75,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.choices[0].message.content;
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
};

// ─── Save launch package to DB ────────────────────────────────────────────────
const saveLaunchPackage = async (userId, packageData) => {
  try {
    const sql = getDB();
    const [row] = await sql`
      INSERT INTO launch_packages (user_id, package_data, created_at)
      VALUES (${userId}, ${JSON.stringify(packageData)}, NOW())
      RETURNING id
    `;
    return row.id;
  } catch (err) {
    logger.warn({ err }, 'Could not save launch package');
    return null;
  }
};

module.exports = {
  generatePostingPackage,
  getTimingIntelligence,
  generateBrandAlert,
  saveLaunchPackage,
};
