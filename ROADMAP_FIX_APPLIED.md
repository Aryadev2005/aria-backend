# Roadmap Controller & Service Fixes Applied

## Summary
Updated `src/controllers/roadmap.controller.ts` and `src/services/roadmap.service.ts` to pass actual creator data (real numbers, follower count, engagement rate, performance metrics) to the AI prompt instead of generic bucket values.

---

## FILE 1: `src/controllers/roadmap.controller.ts` ✅

### Changes Made:
1. **Expanded `USER_SELECT` constant** (lines 16-31)
   - Added: `follower_count` — the actual number (e.g., 7081)
   - Added: `instagram_handle`, `youtube_handle` — for @handle reference
   - Added: `tone_profile`, `bio` — creator's actual voice data
   - Result: AI now receives **13 fields** instead of 8 (62% more context)

2. **Reformatted for clarity**
   - Each field on its own line with inline comments explaining what was missing and why it matters

### Impact:
- Controller now fetches all necessary fields from the database
- Service receives complete user context for hyper-personalized roadmap generation

---

## FILE 2: `src/services/roadmap.service.ts` ✅

### Changes Made (lines 273–545):

#### **New Data Extraction (lines 277–289)**
- Unpack `scraped_summary` safely — the richest real data source
- Extract actual metrics:
  - `actualFollowers` — real follower count (e.g., 7,081)
  - `actualER` — engagement rate as a number (e.g., 35.83)
  - `actualPostsPerWeek` — real posting frequency
  - `avgLikes`, `avgComments`, `avgViews` — raw performance numbers
  - `handle` — Instagram or YouTube handle

#### **9 Rich Context Blocks (lines 291–451)**

**Block 1: Creator Identity with Real Numbers**
- Shows actual follower count with Indian locale formatting (e.g., "7,081")
- Displays engagement rate with contextual flags:
  - `> 10%`: "EXCEPTIONAL — far above 3% niche average"
  - `> 5%`: "SIGNIFICANTLY above average"
  - `> 2%`: "above average"
- Posts per week with warnings:
  - `< 1`: "⚠️ CRITICALLY LOW"
  - `< 3`: "below ideal — should be 3-5/week"

**Block 2: Real Performance Numbers**
- Average likes, comments, views per post (actual metrics from Apify scrape)
- Post type mix (what formats they actually use)
- Best performing format and top hashtags

**Block 3: Voice Portrait**
- ARIA's deep understanding of this creator
- Content territory, topics, audience, tone, formats, constraints

**Block 4: ARIA Memory**
- Observed patterns over time with confidence scores

**Block 5: Content History**
- Last N pieces created in-app

**Block 6: ARIA Analysis**
- Handles both structured paths (keyStrengths/strengths, keyGaps/gaps, etc.)
- Graceful fallback to ariaMessage if no structured data
- Shows archetype, strengths, gaps, opportunities

**Block 7: Time Context**
- Days since last roadmap, posts created since
- Smart messaging based on activity level

**Block 8: Strategic Lens**
- This month's focus and weekly bias

**Block 9: Wildcard Trend**
- Current niche-matched trend for timeliness hook

#### **Critical Diagnostic Summary (lines 453–469)**
- Injected last for emphasis and opening anchoring
- References actual numbers:
  - If ER > 10%: "EXCEPTIONAL engagement rate of X% — this is their single biggest asset"
  - If posts/week < 1: "CRITICAL BOTTLENECK — algorithm needs 3-4 posts/week"
  - If high ER but low followers: "High engagement but algorithm hasn't discovered them yet"

#### **Hyper-Personalized Prompt (lines 471–545)**
- **New tone:** "HYPER-PERSONALISED" (not just "PERSONALISED")
- **New rule 1:** "Reference the creator's actual follower count and engagement rate by number"
- **New rule 2:** "If posts/week < 1, Week 1's ENTIRE focus must be on posting frequency"
- **New rule 3:** "If engagement rate > 10%, every action must leverage this asset"
- **New rule 9:** "Every howTo must be executable with a phone, alone, in India"

- **Enhanced JSON schema:**
  - `currentSituation` now requires: "referencing their ACTUAL numbers"
  - Example given: "With 7,081 followers and a 35.83% engagement rate, you are..."
  - `milestones.target` uses: actualFollowers with Indian locale (e.g., "10,000 followers")
  - All actions reference actual content/numbers/bottleneck

---

## Expected Behavior After Fix

### Before:
```
currentSituation: "You are an emerging creator with moderate follower range..."
coreChallenge: "Growing your audience organically..."
```

### After:
```
currentSituation: "With 7,081 followers and a 35.83% engagement rate, you're one of the highest-engagement creators in your tier — but posting only 0.2x per week means the algorithm is not distributing your content. This is your single biggest bottleneck."
coreChallenge: "You need to post 3-5 times per week minimum to let the algorithm work with your exceptional engagement rate."
```

---

## Cache Busting — MANDATORY Before Testing

The Redis cache still holds the old generic roadmap for each user. You **must** bust it before testing:

### Option A: Redis CLI
```bash
redis-cli DEL roadmap:<user-id>
# e.g., redis-cli DEL roadmap:clkxyz123
```

### Option B: Hit the refresh endpoint
```bash
GET /api/v1/analytics/roadmap/refresh
# Returns a fresh roadmap with new data
```

### Option C: Add diagnostic logging (recommended)
Add this right before `_callGroq` call in `roadmap.service.ts`:

```typescript
logger.info({
  userId,
  followers: actualFollowers,
  er: actualER,
  postsPerWeek: actualPostsPerWeek,
  hasVoicePortrait: !!voicePortrait,
  contextBlockCount: contextBlocks.length,
}, 'roadmap: prompt context summary');
```

This will log what data is being passed to the AI, confirming the fix is working.

---

## Testing Checklist

- [ ] Restart backend: `npm run dev`
- [ ] Clear Redis cache for test user: `redis-cli DEL roadmap:<user-id>`
- [ ] Call `/api/v1/analytics/roadmap?force=true`
- [ ] Verify roadmap starts with **actual numbers**: "With X followers and Y% engagement rate..."
- [ ] Verify Week 1 focus aligns with actual metrics (e.g., posting frequency if < 1x/week)
- [ ] Verify milestones reference actual follower count
- [ ] Verify all actions reference scraped_summary metrics (likes, comments, views, post types)

---

## Files Modified

1. ✅ `/Users/aryadevchatterjee/Documents/aria/aria-backend/src/controllers/roadmap.controller.ts`
   - Lines 16–31: Expanded `USER_SELECT`

2. ✅ `/Users/aryadevchatterjee/Documents/aria/aria-backend/src/services/roadmap.service.ts`
   - Lines 273–545: Complete context block rebuild with real data extraction

---

## Impact on Roadmap Generation

- **Specificity:** Roadmaps now reference creator's actual data instead of generic descriptions
- **Actionability:** AI can tailor Week 1 focus to real bottlenecks (e.g., low posting frequency)
- **Monetization Ready:** Includes real metrics needed for brand pitches
- **India Context:** Uses Indian number formatting and IST timezone awareness
- **Diagnostic Power:** Critical diagnostics block anchors AI reasoning to actual facts
