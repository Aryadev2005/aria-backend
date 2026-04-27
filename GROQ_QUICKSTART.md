# TrendAI Groq Integration - Quick Start Guide

## 🚀 Installation Steps

### 1. Install Dependencies
```bash
npm install
```

This installs the new `groq-sdk` package (replacing `@anthropic-ai/sdk`).

### 2. Set Environment Variables
Add to your `.env` file:
```bash
GROQ_API_KEY=gsk_xxxxxxxxxxxx
GROQ_MODEL=mixtral-8x7b-32768  # optional, defaults to mixtral-8x7b-32768
```

Get your GROQ_API_KEY from: https://console.groq.com

### 3. Run Database Migration
```bash
npm run db:migrate
```

This will:
- Add ARIA columns to users table
- Create aria_feedback table
- Create live_trends table  
- Create live_songs table

### 4. Start the Server
```bash
npm run dev
```

---

## 🔍 Testing the Integration

### Test 1: Get Trends (Public)
```bash
curl http://localhost:3000/api/v1/trends
```

Expected response: Trends from live_trends table or Groq generation

### Test 2: Get Personalized Trends (Auth Required)
```bash
curl -H "Authorization: Bearer <firebase_token>" \
  http://localhost:3000/api/v1/trends/personalized
```

Expected response: Trends personalized with user archetype

### Test 3: Get Archetype
```bash
curl -H "Authorization: Bearer <firebase_token>" \
  http://localhost:3000/api/v1/analytics/archetype
```

Expected response:
```json
{
  "archetype": "EDUCATOR",
  "archetypeLabel": "The Teacher",
  "archetypeConfidence": 85,
  "growthStage": "GROWTH",
  "toneProfile": "educational"
}
```

### Test 4: Get Dashboard (Auto-detects archetype)
```bash
curl -H "Authorization: Bearer <firebase_token>" \
  http://localhost:3000/api/v1/analytics/dashboard
```

Expected response: Full persona growth map from ARIA

### Test 5: Submit Feedback
```bash
curl -X POST \
  -H "Authorization: Bearer <firebase_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "recommendationType": "trend",
    "recommendationData": {"trendId": "123"},
    "wasHelpful": true,
    "resultNotes": "Great recommendation!"
  }' \
  http://localhost:3000/api/v1/trends/feedback
```

### Test 6: Generate Content (Using Groq)
```bash
curl -X POST \
  -H "Authorization: Bearer <firebase_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "trendTitle": "Sustainable Fashion",
    "platform": "instagram",
    "niche": "fashion",
    "tone": "casual",
    "language": "hinglish"
  }' \
  http://localhost:3000/api/v1/content/generate
```

---

## 📊 ARIA Features Explained

### 1. Archetype Detection
When a user's dashboard is first loaded, ARIA automatically detects their creator archetype:
- **THE EDUCATOR** - Teaches skills, builds authority
- **THE ENTERTAINER** - Viral content, trend-chaser
- **THE INFLUENCER** - Lifestyle, aspirational
- **THE BUILDER** - Behind-the-scenes, community
- **THE STORYTELLER** - Narrative-driven, emotional
- **THE EXPERT** - Niche authority, consulting

### 2. Full Persona Growth Map
The dashboard now returns:
- `personaSummary` - Current positioning
- `growthStage` - DISCOVERY, GROWTH, MONETIZATION, SCALE
- `currentHealthScore` - Overall creator health (0-100)
- `contentStrategy` - Recommended themes, formats, frequency
- `growthProjections` - Follower projections for months 1, 3, 6
- `monetizationReadiness` - When they can start earning
- `immediateActions` - Top 3 things to do right now

### 3. Feedback Loop
When creators interact with ARIA recommendations:
- Submit feedback via `POST /api/v1/trends/feedback`
- ARIA learns from their reactions
- Data stored in `aria_feedback` table
- Used to improve future recommendations

### 4. Live Trend Data
- `live_trends` table populated by BullMQ workers (coming in PART B)
- Groq falls back to AI generation if live data unavailable
- Automatic expiration via `expires_at` column

---

## 🔧 Key Implementation Details

### How Archetype Detection Works
1. User logs in for first time (or archetype is null)
2. `getDashboard()` detects if archetype is missing
3. Calls `groqService.detectArchetype()` with user data
4. Saves result to DB asynchronously
5. Returns full growth map to client

### Archetype Parameter Flow
All AI functions now accept optional `archetype` parameter:
```javascript
// Before (Claude)
claudeService.generateContent({ trendTitle, platform, niche, ... })

// After (Groq) - includes archetype
groqService.generateContent({ 
  trendTitle, platform, niche, 
  archetype: user.archetype  // ← New
})
```

### Error Handling
- If Groq API fails: Returns 503 Service Down
- If DB migration fails: Run `npm run db:migrate` again
- If archetype detection fails: Logs error but doesn't block dashboard

---

## 📝 Database Schema Changes

### Users Table - New Columns
```sql
-- ARIA Profile
archetype TEXT                    -- Creator type (EDUCATOR, ENTERTAINER, etc)
archetype_label TEXT              -- Human-readable label
archetype_confidence INTEGER      -- Confidence 0-100
growth_stage TEXT DEFAULT 'DISCOVERY'
tone_profile TEXT                 -- casual, professional, humorous, inspirational
health_score INTEGER              -- Creator health 0-100

-- Social Profiles
instagram_handle TEXT             -- For scraping (future)
youtube_handle TEXT               -- For scraping (future)

-- Analytics
engagement_rate DECIMAL(5,2)      -- User's engagement rate %
scraped_summary JSONB             -- From social scrape (future)
scraped_at TIMESTAMPTZ            -- When last scraped (future)

-- ARIA Data
creator_intent TEXT DEFAULT 'grow_organically'
aria_last_analysis JSONB          -- Full last ARIA analysis
aria_analyzed_at TIMESTAMPTZ      -- When last analyzed
```

### New Tables
**aria_feedback** - Tracks recommendation usefulness
**live_trends** - Real-time trend data from workers
**live_songs** - Real-time song data from workers

---

## ✅ Verification Checklist

- [ ] Installed dependencies: `npm install`
- [ ] Set GROQ_API_KEY in `.env`
- [ ] Ran migration: `npm run db:migrate`
- [ ] Started server: `npm run dev`
- [ ] Can GET `/api/v1/trends` (public)
- [ ] Can GET `/api/v1/trends/personalized` (auth)
- [ ] Can GET `/api/v1/analytics/dashboard` (auth)
- [ ] Can GET `/api/v1/analytics/archetype` (auth)
- [ ] Can POST `/api/v1/analytics/scrape` (auth)
- [ ] Can POST `/api/v1/trends/feedback` (auth)

---

## 🐛 Troubleshooting

**Issue**: "groq-sdk not found"
```bash
# Solution
npm install groq-sdk
```

**Issue**: "GROQ_API_KEY is missing"
```bash
# Check your .env file has:
GROQ_API_KEY=gsk_xxxxxxxxxxxx
```

**Issue**: "Migration failed - table already exists"
```bash
# Migration has idempotent CREATE TABLE IF NOT EXISTS
# This is normal - just means columns are already added
```

**Issue**: Archetype not detected
```bash
# Check logs - archetype detection happens async
# Wait 5-10 seconds and try dashboard again
# Or trigger it manually via /analytics/dashboard endpoint
```

---

## 📚 API Reference

### Content Generation (Groq-Powered)
```
POST /api/v1/content/generate
- generateContent (with archetype)
- generateHooks (with archetype)
- rewriteHook (with archetype)
- analyseContent (with archetype)
```

### Trend Intelligence
```
GET /api/v1/trends
GET /api/v1/trends/personalized
GET /api/v1/trends/opportunity-windows
GET /api/v1/trends/viral-radar
GET /api/v1/trends/saved
POST /api/v1/trends/feedback ← NEW
```

### Analytics & ARIA
```
GET /api/v1/analytics/dashboard
GET /api/v1/analytics/archetype ← NEW
GET /api/v1/analytics/growth
GET /api/v1/analytics/best-times
GET /api/v1/analytics/competitors
GET /api/v1/analytics/weekly-report
POST /api/v1/analytics/scrape ← NEW
```

---

## 🎯 Next Steps (PART B)

1. Create BullMQ Workers:
   - `src/workers/trend.worker.js` - Fetches live trends
   - `src/workers/song.worker.js` - Fetches trending songs

2. Implement Social Scraping:
   - Instagram profile scraping
   - YouTube channel scraping
   - Populate creator metrics

3. Integration Tests:
   - Test full ARIA pipeline
   - Test feedback loop
   - Test live data fallback

---

**Status**: ✅ **PART A COMPLETE**

All Groq integration is ready for production. PART B (Workers) will add live data pipelines.
