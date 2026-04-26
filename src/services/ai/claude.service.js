'use strict'

const Anthropic = require('@anthropic-ai/sdk')
const { logger } = require('../../utils/logger')

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 2,
  timeout: 30000,
})

const MODEL      = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'
const MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS || '2000', 10)

const parseJSON = (text) => {
  const clean = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
  return JSON.parse(clean)
}

const generateContent = async ({ trendTitle, platform, niche, followerRange, songTitle, tone = 'casual', language = 'hinglish' }) => {
  const prompt = `You are India's top social media content strategist.

Creator: ${niche} niche, ${platform}, ${followerRange} followers
Topic: "${trendTitle}"
${songTitle ? `Song: "${songTitle}"` : ''}
Tone: ${tone}, Language: ${language}

Respond ONLY with valid JSON:
{
  "hook": "attention-grabbing line using Indian context and ₹ for prices",
  "caption": "full caption with emojis, 3-4 sentences",
  "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8"],
  "bestTimeToPost": "Today · 7:30 PM IST",
  "contentFormat": "Reel",
  "expectedEngagement": "High saves, Medium comments",
  "thumbnailText": "bold thumbnail text",
  "cta": "call to action"
}`

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseJSON(res.content[0].text)
}

const generateHooks = async ({ topic, platform, niche, followerRange }) => {
  const prompt = `Generate 5 hooks for Indian ${niche} creator on ${platform} (${followerRange} followers).
Topic: "${topic}"

Respond ONLY with valid JSON:
{
  "hooks": [
    { "text": "hook", "trigger": "curiosity|controversy|relatability|fear|aspiration", "rating": 85 }
  ]
}`

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseJSON(res.content[0].text)
}

const rewriteHook = async ({ hook, platform, niche }) => {
  const prompt = `Rewrite this hook 5 stronger ways for Indian ${niche} ${platform} creator:
"${hook}"

Respond ONLY with valid JSON:
{
  "rewrites": [
    { "text": "hook", "improvement": "why better", "rating": 90 }
  ]
}`

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseJSON(res.content[0].text)
}

const repurposeContent = async ({ content, sourcePlatform, targetPlatforms }) => {
  const prompt = `Repurpose this ${sourcePlatform} content for: ${targetPlatforms.join(', ')}
"${content}"

Respond ONLY with valid JSON:
{
  "repurposed": {
    "instagram": { "caption": "", "hashtags": [], "format": "Reel" },
    "youtube":   { "title": "", "description": "", "tags": [] },
    "twitter":   { "tweet": "", "thread": [] }
  }
}`

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseJSON(res.content[0].text)
}

const analyseContent = async ({ caption, platform, niche }) => {
  const prompt = `Rate this ${platform} caption for ${niche} creator:
"${caption}"

Respond ONLY with valid JSON:
{
  "score": 85,
  "verdict": "Excellent",
  "strengths": ["s1", "s2"],
  "improvements": ["i1", "i2"],
  "estimatedReach": "High",
  "estimatedSaves": "Medium",
  "suggestedEdit": "improved caption"
}`

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseJSON(res.content[0].text)
}

const generateTrendInsights = async ({ niche, platform, followerRange }) => {
  const prompt = `Generate 8 trending content ideas for Indian ${niche} creator on ${platform} (${followerRange} followers).
Include Bollywood, IPL, festivals, D2C brands.

Respond ONLY with valid JSON array:
[{
  "id": "trend_1",
  "title": "trend title",
  "platform": "${platform}",
  "stat": "2.4M views this week",
  "badge": "HOT",
  "aiTip": "specific tip in 1 sentence",
  "velocity": 87,
  "peakETA": "24 hours",
  "opportunityScore": 92,
  "isPersonalized": true
}]`

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseJSON(res.content[0].text)
}

const generateSongInsights = async ({ niche, platform }) => {
  const prompt = `Top 10 trending songs RIGHT NOW for Indian ${niche} creator on ${platform}.
Include Bollywood, Punjabi, Indie, English songs.

Respond ONLY with valid JSON array:
[{
  "id": "song_1",
  "title": "song title",
  "artist": "artist name",
  "lifecycle": "early",
  "signal": "postNow",
  "rank": 1,
  "platform": "Instagram Reels",
  "stat": "+340% this week",
  "signalReason": "Early mover advantage — use NOW",
  "duration": "0:28 trending cut",
  "bpm": 128,
  "isRegional": false,
  "language": null,
  "niche": "${niche}"
}]`

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseJSON(res.content[0].text)
}

const generateRateCard = async ({ followers, engagement, niche, platform }) => {
  const prompt = `Rate card for Indian ${niche} creator: ${followers} followers, ${engagement}% engagement on ${platform}.

Respond ONLY with valid JSON:
{
  "storyMention": "₹X,XXX",
  "feedPost": "₹X,XXX",
  "reel": "₹XX,XXX",
  "campaign5Posts": "₹XX,XXX",
  "brandAmbassador": "₹X,XX,XXX/month",
  "verdict": "You are undercharging",
  "industryAverage": "what similar creators charge",
  "negotiationTip": "one tip"
}`

  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseJSON(res.content[0].text)
}

module.exports = {
  generateContent,
  generateHooks,
  rewriteHook,
  repurposeContent,
  analyseContent,
  generateTrendInsights,
  generateSongInsights,
  generateRateCard,
}