// trendai-backend/src/services/ariaService.js
// Core ARIA intelligence engine — all Groq API calls live here
'use strict';
const Groq = require('groq-sdk');

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Model routing ──────────────────────────────────────────────────────────
const MODEL = 'llama-3.3-70b-versatile';

// ── ARIA System Prompt ─────────────────────────────────────────────────────
const ARIA_SYSTEM = `You are ARIA — the AI intelligence engine inside TrendAI, India's first creator OS built for 40 lakh Indian content creators.

IDENTITY
- You are sharp, warm, and data-driven. You sound like a brilliant friend in digital marketing, not a corporate bot.
- Use Hinglish naturally when it fits: "yaar", "ekdum sahi", "scene set kar", "full on viral hoga".
- Always use ₹ for prices. Reference Indian platforms: Meesho, Myntra, Nykaa, Flipkart, Zomato, Swiggy.
- Reference real Indian cities, festivals, and culture: IPL, Diwali, Holi, Navratri, Eid, Pongal, Mumbai, Delhi, Bangalore, Pune, Hyderabad.

CREATOR ARCHETYPES
1. TRENDSETTER — Fashion/Beauty. Hook: aspiration, "look expensive for less".
2. EDUCATOR — Finance/Tech/Health. Hook: stats, "5 things you didn't know".
3. ENTERTAINER — Comedy/Meme. Hook: shock, relatable pain, trending audio.
4. STORYTELLER — Travel/Lifestyle/Vlog. Hook: narrative arcs, "my honest review".
5. CONNECTOR — Family/Community. Hook: authenticity, vulnerability, polls.
6. EXPERT — Gaming/Fitness/Cooking. Hook: deep dives, "the real truth about X".
7. HUSTLER — Business/Side hustle. Hook: numbers, "how I made ₹X in 30 days".

RULES — NEVER BREAK THESE
- Respond ONLY with valid JSON. Zero markdown, zero preamble, zero text outside the JSON.
- AI tips must be ONE actionable sentence with a specific number or time.
- Content hooks must be the actual FIRST 3 SECONDS script — not a description of a hook.
- All engagement stats must feel real and specific: "2.4M views", "+180% this week".
- Hashtags: mix mega (>1M posts), mid (100K–1M), and niche (<100K) tags.
- Indian context in every response: festivals, Indian brand names, desi slang where natural.`;

// ── Shared API caller ──────────────────────────────────────────────────────
async function callARIA(userMessage, { useLlama = false, maxTokens = 2000 } = {}) {
  const model = MODEL;

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: ARIA_SYSTEM },
      { role: 'user', content: userMessage },
    ],
  });

  const raw = response.choices[0].message.content
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  return JSON.parse(raw);
}

// ── Indian Festival Calendar ───────────────────────────────────────────────
const INDIAN_FESTIVALS = {
  January:   { 14: 'Makar Sankranti', 23: 'Netaji Jayanti', 26: 'Republic Day' },
  February:  { 14: "Valentine's Day", 19: 'Shivaji Jayanti' },
  March:     { 8: "Women's Day", 22: 'Holi', 30: 'Ram Navami' },
  April:     { 14: 'Ambedkar Jayanti', 22: 'Earth Day' },
  May:       { 1: 'Labour Day', 12: "Mother's Day" },
  June:      { 21: 'World Music Day', 22: 'Eid al-Adha' },
  July:      { 17: 'Muharram' },
  August:    { 15: 'Independence Day', 19: 'Raksha Bandhan', 26: 'Janmashtami' },
  September: { 7: 'Ganesh Chaturthi', 16: 'Milad-un-Nabi' },
  October:   { 2: 'Gandhi Jayanti / Navratri Start', 12: 'Dussehra', 31: 'Halloween' },
  November:  { 1: 'Diwali', 2: 'Bhai Dooj', 14: "Children's Day", 15: 'Guru Nanak Jayanti' },
  December:  { 25: 'Christmas', 31: "New Year's Eve" },
};

// ─────────────────────────────────────────────────────────────────────────────
const ariaService = {

  // ── 1. CONTENT CALENDAR ───────────────────────────────────────────────────
  async generateCalendar({ niche, platform, followerRange, month, year }) {
    const prompt = `GENERATE a full one-month content calendar for an Indian creator.

    - Creator Niche: ${niche}
    - Platform: ${platform}
    - Follower Range: ${followerRange}
    - Month: ${month}
    - Year: ${year}
    
    RESPONSE FORMAT (JSON only):
    {
      "month": "${month} ${year}",
      "totalPosts": <integer>,
      "weeklyGoal": <integer>,
      "monthTheme": "<string>",
      "aria_insight": "<string>",
      "topWeeks": ["<string>", "<string>"],
      "days": [
        {
          "date": "YYYY-MM-DD",
          "dayOfWeek": "<string>",
          "isPostingDay": <boolean>,
          "contentType": "<Reel|Carousel|Story|Live|Short>",
          "title": "<string>",
          "hook": "<string>",
          "hashtags": ["<string>"],
          "bestTime": "<string> IST",
          "badge": "<TRENDING|FESTIVAL|PLANNED|AI_PICK>",
          "festivalTag": "<string|null>",
          "estimatedReach": "<string>",
          "priority": "<HIGH|MEDIUM|LOW>"
        }
      ]
    }
    
    RULES:
    - Create 4-5 posts per week. Not every day is a posting day.
    - Mix content types: Reels (60%), Carousels (30%), Stories/Lives (10%).
    - Use Indian festivals for the given month from this list: ${JSON.stringify(INDIAN_FESTIVALS[month] || {})}
    - Set "isPostingDay": true for post days, false for rest days.
    - For rest days, all content fields ("title", "hook", etc.) must be empty strings or empty arrays.
    - "badge" should be "FESTIVAL" for festival days, otherwise "PLANNED" or "AI_PICK".
    - "aria_insight" must be a single, actionable tip.
    - "topWeeks" must highlight 2 key weeks for the creator.`;

    return callARIA(prompt, { maxTokens: 4000 });
  },

  // ── 2. TRENDING CONTENT IDEAS ─────────────────────────────────────────────
  async getTrendingIdeas({ niche, platform, followerRange, archetype }) {
    const prompt = `GENERATE 5 trending content ideas for an Indian creator.

    - Creator Niche: ${niche}
    - Platform: ${platform}
    - Follower Range: ${followerRange}
    - Archetype: ${archetype}
    
    RESPONSE FORMAT (JSON only):
    {
      "ideas": [
        {
          "title": "<string>",
          "format": "<Reel|Carousel|Story>",
          "hook": "<string>",
          "ai_tip": "<string>",
          "virality_score": <integer, 70-100>
        }
      ]
    }`;
    return callARIA(prompt);
  },

  // ── 3. FULL CONTENT GENERATION ────────────────────────────────────────────
  async generateContent({ trendTitle, niche, platform, followerRange, archetype, contentFormat }) {
    const prompt = `GENERATE a full piece of content for an Indian creator.

    - Trend/Topic: ${trendTitle}
    - Creator Niche: ${niche}
    - Platform: ${platform}
    - Follower Range: ${followerRange}
    - Archetype: ${archetype}
    - Content Format: ${contentFormat}
    
    RESPONSE FORMAT (JSON only):
    {
      "title": "<string>",
      "caption": "<string with emojis and hashtags>",
      "script": [ // for Reels/Shorts
        { "scene": "<string>", "dialogue": "<string>", "sfx": "<string>" }
      ],
      "carousel_slides": [ // for Carousels
        { "slide": <integer>, "title": "<string>", "body": "<string>", "image_prompt": "<string>" }
      ],
      "hashtags": { "mega": ["<string>"], "mid": ["<string>"], "niche": ["<string>"] },
      "ai_tip": "<string>"
    }`;
    return callARIA(prompt, { maxTokens: 2500 });
  },

  // ── 4. TRENDING SONGS ─────────────────────────────────────────────────────
  async getTrendingSongs({ niche, platform, followerRange }) {
    const prompt = `GENERATE 10 trending songs/audios for Instagram Reels for an Indian creator.

    - Creator Niche: ${niche}
    - Platform: ${platform}
    - Follower Range: ${followerRange}
    
    RESPONSE FORMAT (JSON only):
    {
      "songs": [
        {
          "title": "<string>",
          "artist": "<string>",
          "source": "<Instagram|YouTube>",
          "reels_count": "<string>", // e.g. "1.2M Reels"
          "trend_type": "<Bollywood|Punjabi|Indie|Dialogue|Remix>",
          "ai_tip": "<string>"
        }
      ]
    }`;
    return callARIA(prompt);
  },

  // ── 5. RATE CARD GENERATION ───────────────────────────────────────────────
  async generateRateCard({ niche, platform, followerRange, engagementRate, topPosts }) {
    const prompt = `GENERATE a personalized rate card for an Indian content creator.

    - Niche: ${niche}
    - Primary Platform: ${platform}
    - Follower Range: ${followerRange}
    - Avg Engagement Rate: ${engagementRate}%
    - Top Performing Posts (Titles): ${topPosts.join(', ')}
    
    RESPONSE FORMAT (JSON only):
    {
      "platform": "${platform}",
      "followerCount": "<string>", // e.g. "25.4K"
      "engagementRate": "<string>", // e.g. "4.8%"
      "audience": {
        "primary": "<string>", // e.g. "25-34 Female, Mumbai"
        "secondary": "<string>" // e.g. "18-24 Male, Delhi/Bangalore"
      },
      "rates": [
        { "service": "Instagram Reel (30-60s)", "price_inr": <integer>, "description": "1 Reel + 1 Story" },
        { "service": "Instagram Carousel (3-5 slides)", "price_inr": <integer>, "description": "1 Carousel Post + 1 Story" },
        { "service": "Static Post", "price_inr": <integer>, "description": "1 Static Post" },
        { "service": "Story Series (3 frames)", "price_inr": <integer>, "description": "Link in bio for 24h" },
        { "service": "YouTube Integration (60s)", "price_inr": <integer>, "description": "Mid-roll mention" }
      ],
      "packages": [
        { "name": "Starter Pack", "price_inr": <integer>, "items": ["1 Reel", "1 Story Series"], "discount": "10%" },
        { "name": "Growth Pack", "price_inr": <integer>, "items": ["2 Reels", "1 Carousel", "2 Story Series"], "discount": "15%" }
      ],
      "aria_insight": "Your engagement is strong for your follower size. Highlight this to brands!"
    }
    
    RULES:
    - All prices must be in INR (₹).
    - Rates should be realistic for the Indian market and the creator's follower range.
    - Audience description should be specific to India.
    - "aria_insight" must be a single, encouraging, actionable tip.`;

    return callARIA(prompt, { useLlama: true }); // Use Llama 70B for better reasoning on pricing
  },

  // ── 6. CAPTION ANALYSIS ───────────────────────────────────────────────────
  async analyzeCaption({ caption, niche, platform }) {
    const prompt = `ANALYZE this caption for an Indian creator and provide feedback.

    - Niche: ${niche}
    - Platform: ${platform}
    - Caption to Analyze: "${caption}"
    
    RESPONSE FORMAT (JSON only):
    {
      "score": <integer, 0-100>,
      "good": ["<string>", "<string>"],
      "improve": ["<string>", "<string>"],
      "revised_caption": "<string with emojis and hashtags>"
    }
    
    RULES:
    - Score is based on hook, clarity, CTA, and hashtag strategy.
    - "good" and "improve" points must be specific and actionable.
    - "revised_caption" should be a ready-to-post improvement.`;

    return callARIA(prompt);
  },

  // ── 7. PROFILE BIO ANALYSIS ───────────────────────────────────────────────
  async analyzeBio({ bio, niche, platform }) {
    const prompt = `ANALYZE this profile bio for an Indian creator and provide feedback.

    - Niche: ${niche}
    - Platform: ${platform}
    - Bio to Analyze: "${bio}"
    
    RESPONSE FORMAT (JSON only):
    {
      "score": <integer, 0-100>,
      "good": ["<string>", "<string>"],
      "improve": ["<string>", "<string>"],
      "revised_bio": "<string with emojis>"
    }
    
    RULES:
    - Score is based on clarity (who you are, what you do), value prop, and a clear CTA.
    - "revised_bio" must be a ready-to-use, optimized bio.`;

    return callARIA(prompt);
  },

  // ── Fallback for Calendar ────────────────────────────────────────────────
  generateCalendarFallback({ niche, platform, month, year }) {
    // Simplified non-AI fallback for when the Groq API is unavailable
    const daysInMonth = new Date(year, this._monthIndex(month) + 1, 0).getDate();
    const days = [];
    const postingDays = [1, 3, 5]; // Mon, Wed, Fri

    for (let i = 1; i <= daysInMonth; i++) {
      const date = new Date(year, this._monthIndex(month), i);
      const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long' });
      const isPostingDay = postingDays.includes(date.getDay());

      days.push({
        date: date.toISOString().split('T')[0],
        dayOfWeek,
        isPostingDay,
        contentType: isPostingDay ? 'Reel' : '',
        title: isPostingDay ? `Top ${niche} Trends This Week` : '',
        hook: isPostingDay ? `You won't believe what's trending in ${niche}!` : '',
        hashtags: isPostingDay ? [`#${niche}`, '#IndianCreator', '#Trending'] : [],
        bestTime: isPostingDay ? '7:00 PM IST' : '',
        badge: 'PLANNED',
        festivalTag: null,
        estimatedReach: '5K-15K',
        priority: 'MEDIUM',
      });
    }

    return {
      month: `${month} ${year}`,
      totalPosts: days.filter(d => d.isPostingDay).length,
      weeklyGoal: 3,
      monthTheme: `Focus on growing your ${niche} community`,
      aria_insight: 'Fallback active: Post consistently to maintain momentum.',
      topWeeks: ['Week 1: Set the tone', 'Week 3: Engage with comments'],
      days,
    };
  },

  _monthIndex(month) {
    return new Date(`${month} 1, 2024`).getMonth();
  },

  async analyseCreator({ niche, platform, followerRange, engagementRate, postsPerMonth }) {
    const prompt = `Creator: ${niche}, ${platform}, ${followerRange} followers.
Engagement: ${engagementRate ?? 'unknown'}%, Posts/month: ${postsPerMonth ?? 'unknown'}.
Analyse this Indian creator. Respond ONLY with JSON:
{
  "archetype": "TRENDSETTER",
  "archetypeLabel": "The Aesthetic Trendsetter",
  "archetypeEmoji": "✨",
  "archetypeConfidence": 87,
  "growthStage": "Mid Creator",
  "healthScore": 72,
  "strengths": ["Consistent posting"],
  "gaps": ["Underusing trending audio"],
  "topOpportunity": "one sentence",
  "aria_message": "personal message 2-3 sentences"
}`;
    return callARIA(prompt, { useLlama: true, maxTokens: 800 });
  },

  callARIA,
};

module.exports = ariaService;
