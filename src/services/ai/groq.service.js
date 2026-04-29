'use strict'

const Groq = require('groq-sdk')
const { logger } = require('../../utils/logger')

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
})

const MODEL = process.env.GROQ_MODEL || 'mixtral-8x7b-32768'

const parseJSON = (text) => {
  const clean = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
  return JSON.parse(clean)
}

// ============ NEW ARIA FUNCTIONS ============

/**
 * Detect creator archetype based on user profile
 * Returns: { archetype, archetypeLabel, archetypeConfidence, growthStage, toneProfile }
 */
const detectArchetype = async ({ niche, platform, followerRange, creatorIntent, scrapedData }) => {
  const prompt = `You are ARIA - an AI creator intelligence system. Analyze this creator profile and detect their archetype.

Creator Profile:
- Niche: ${niche}
- Platform: ${platform}
- Follower Range: ${followerRange}
- Intent: ${creatorIntent}
${scrapedData ? `- Bio/Data: ${JSON.stringify(scrapedData)}` : ''}

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
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

/**
 * Analyze content gaps vs live market trends
 */
const analyzeGaps = async ({ archetype, niche, platform, followerRange, scrapedData, engagementRate }) => {
  const prompt = `You are ARIA. Analyze content gaps for a ${archetype} creator in ${niche} on ${platform}.

Current Data:
- Follower Range: ${followerRange}
- Engagement Rate: ${engagementRate}%
${scrapedData ? `- Creator Data: ${JSON.stringify(scrapedData)}` : ''}

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
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

/**
 * Generate a viral blueprint for creator growth
 */
const generateViralBlueprint = async ({ archetype, niche, platform, followerRange, gaps, toneProfile }) => {
  const prompt = `You are ARIA. Generate a viral growth blueprint for a ${archetype} ${niche} creator on ${platform}.

Blueprint parameters:
- Followers: ${followerRange}
- Tone: ${toneProfile}
- Content Gaps: ${JSON.stringify(gaps?.contentGaps?.slice(0, 3) || [])}

Respond ONLY with valid JSON:
{
  "30dayBlueprint": {
    "week1": "Post 3 Reels on trending sounds from ${niche}. Focus on hook optimization.",
    "week2": "Introduce Carousel format. Test gap content.",
    "week3": "Cross-promote across Stories + Reels",
    "week4": "Analyze best-performing format. Double down."
  },
  "viralMechanics": ["Hook", "Pattern interrupt", "CTA"],
  "contentMixRecommendation": {
    "reels": 60,
    "carousels": 25,
    "stories": 15
  },
  "bestTimeToPost": "7:00 PM IST Wed-Sat",
  "recommendedFrequency": "5x per week",
  "expectedGrowthIn30Days": "15-25%"
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

/**
 * Full persona growth map - ARIA's flagship analysis
 */
const fullPersonaGrowthMap = async ({ niche, platform, followerRange, creatorIntent, scrapedData, engagementRate }) => {
  const prompt = `You are ARIA - India's top AI creator intelligence. Generate a complete persona growth map.

Creator:
- Niche: ${niche}
- Platform: ${platform}
- Followers: ${followerRange}
- Engagement: ${engagementRate}%
- Intent: ${creatorIntent}

Respond ONLY with valid JSON (MUST be valid):
{
  "personaSummary": "2-3 sentence overview of creator's position",
  "growthStage": "DISCOVERY|GROWTH|MONETIZATION|SCALE",
  "currentHealthScore": 72,
  "nextMilestone": "50K followers",
  "daysToNextMilestone": 45,
  "archetypeProfile": "Creator archetype and strength areas",
  "immediateActions": [
    "Action 1: description",
    "Action 2: description"
  ],
  "contentStrategy": {
    "themes": ["Theme 1", "Theme 2"],
    "formats": ["Reels", "Carousels"],
    "frequency": "5x/week"
  },
  "growthProjections": {
    "month1": 18000,
    "month3": 25000,
    "month6": 45000
  },
  "riskFactors": ["Risk 1"],
  "opportunityWindows": ["Opportunity 1"],
  "monetizationReadiness": 65,
  "nextSteps": ["Step 1", "Step 2"]
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

// ============ UPGRADED EXISTING FUNCTIONS (with archetype param) ============

const generateContent = async ({ trendTitle, platform, niche, followerRange, songTitle, tone = 'casual', language = 'hinglish', archetype }) => {
  const prompt = `You are India's top social media content strategist for ${archetype || 'creator'}.

Creator: ${niche} niche, ${platform}, ${followerRange} followers
Topic: "${trendTitle}"
${songTitle ? `Song: "${songTitle}"` : ''}
Tone: ${tone}, Language: ${language}

Respond ONLY with valid JSON:
{
  "hook": "attention-grabbing line using Indian context and ₹ for prices",
  "caption": "full caption with emojis, 3-4 sentences, culturally relevant",
  "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8"],
  "bestTimeToPost": "Day · HH:MM PM IST",
  "contentFormat": "Reel|Carousel|Stories",
  "expectedEngagement": "High saves, Medium comments",
  "thumbnailText": "bold thumbnail text",
  "cta": "call to action"
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

const generateHooks = async ({ topic, platform, niche, followerRange, archetype }) => {
  const prompt = `Generate 5 hooks for Indian ${niche} ${archetype || 'creator'} on ${platform} (${followerRange} followers).
Topic: "${topic}"

Respond ONLY with valid JSON:
{
  "hooks": [
    { "text": "hook", "trigger": "curiosity|controversy|relatability|fear|aspiration", "rating": 85 }
  ]
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

const rewriteHook = async ({ hook, platform, niche, archetype }) => {
  const prompt = `Rewrite this hook 5 stronger ways for Indian ${niche} ${archetype || 'creator'} on ${platform}:
"${hook}"

Respond ONLY with valid JSON:
{
  "rewrites": [
    { "text": "hook", "improvement": "why better", "rating": 90 }
  ]
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
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

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

const analyseContent = async ({ caption, platform, niche, archetype }) => {
  const prompt = `Analyze this ${platform} content for a ${niche} ${archetype || 'creator'}:
"${caption}"

Respond ONLY with valid JSON:
{
  "hookEffectiveness": 85,
  "emotionalTrigger": "aspiration",
  "callToAction": "Identified",
  "estimatedReach": "High",
  "recommendations": ["Rec 1"],
  "score": 82
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

const generateTrendInsights = async ({ niche, platform, followerRange, archetype, liveTrendsContext }) => {
  const prompt = `You are ARIA. Generate trend insights for a ${niche} ${archetype || 'creator'} on ${platform} (${followerRange} followers).
${liveTrendsContext ? `Live market context: ${liveTrendsContext}` : ''}

Respond ONLY with valid JSON:
{
  "trends": [
    {
      "title": "trend name",
      "description": "why it matters",
      "badge": "HOT|RISING|STABLE",
      "searchVolume": 45000,
      "velocity": 85,
      "opportunityScore": 92,
      "recommendation": "How to leverage",
      "expiresIn": "3 days"
    }
  ]
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

const generateSongInsights = async ({ niche, platform, archetype }) => {
  const prompt = `You are ARIA. Generate song insights for trending audio clips for ${niche} creators on ${platform}.
Archetype: ${archetype || 'general'}

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
      "recommendation": "How to use"
    }
  ]
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

const generateRateCard = async ({ followers, engagement, niche, platform, archetype }) => {
  const prompt = `You are ARIA. Generate sponsorship rate card for a ${niche} ${archetype || 'creator'}.

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
}`

  const message = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  })

  return parseJSON(message.choices[0].message.content)
}

// ─── Internal ARIA caller — used by radar.service.js ──────────────────────
const _callGroq = async (prompt, { maxTokens = 1000, useLlama = true, maxRetries = 3 } = {}) => {
  const model = useLlama
    ? 'llama-3.3-70b-versatile'
    : (process.env.GROQ_MODEL || 'mixtral-8x7b-32768');

  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: 'system',
            content: 'You are ARIA — India\'s creator intelligence engine. Always respond with valid JSON only. No preamble, no markdown fences.',
          },
          { role: 'user', content: prompt },
        ],
      }, {
        timeout: 25000, // 25s timeout per attempt
      });

      const content = completion.choices[0].message.content;
      try {
        return parseJSON(content);
      } catch (jsonErr) {
        logger.warn({ jsonErr, attempt, content: content.slice(0, 100) }, 'Groq JSON parse failed');
        lastErr = jsonErr;
        // If it's the last attempt, we throw, otherwise we retry (maybe LLM hallucinated)
      }
    } catch (err) {
      logger.warn({ err: err.message, attempt, model }, 'Groq API call failed');
      lastErr = err;
      
      // Don't retry on certain errors (e.g. auth)
      if (err.status === 401 || err.status === 403) break;
    }

    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  logger.error({ err: lastErr, prompt: prompt.slice(0, 100) }, 'Groq call exhausted all retries');
  throw lastErr || new Error('Groq call failed after retries');
};

// Also add callARIA as an alias (used by old ariaService.js references)
const callARIA = _callGroq;

module.exports = {
  // New ARIA functions
  detectArchetype,
  analyzeGaps,
  generateViralBlueprint,
  fullPersonaGrowthMap,
  // Upgraded existing functions
  generateContent,
  generateHooks,
  rewriteHook,
  repurposeContent,
  analyseContent,
  generateTrendInsights,
  generateSongInsights,
  generateRateCard,
  // Real data ARIA caller
  _callGroq,
  callARIA,
}
