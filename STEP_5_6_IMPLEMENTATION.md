# Step 5 & 6 Implementation Complete ✅

## Overview

Steps 5 and 6 complete the personalisation loop. Step 5 replaces generic growth predictions with truly personalised roadmaps. Step 6 closes the suggestion feedback loop so ARIA learns from creator responses.

---

## What Changed — Complete Implementation

### **New Files Created** (3 files)

#### File 1: `src/services/suggestion.service.ts`

**Purpose:** Manages the suggestion loop lifecycle.

**Key Functions:**

1. **`getDueSuggestions(userId)`** — Fetches suggestions that need follow-up (at least 3 days old, not yet sent)
2. **`recordSuggestionFeedback(suggestionId, userId, outcome, notes)`** — Records whether creator followed/ignored/partially followed a suggestion
3. **`markSuggestionsAsSent(suggestionIds)`** — Marks suggestions as delivered
4. **`getSuggestionStats(userId)`** — Returns follow-through rate and top-followed suggestion types

**Data Flow:**
- When ARIA makes a suggestion → `_extractAndStoreSuggestions` detects it and stores to `aria_suggestions` table
- 3+ days pass → `getDueSuggestions` finds it as due
- ARIA sees it in system prompt and naturally follows up → "Hey, did you try that posting time?"
- Creator responds → `recordSuggestionFeedback` records outcome
- Outcome is written back to memory → next suggestions are smarter

---

#### File 2: `src/services/roadmap.service.ts`

**Purpose:** Generates truly personalised growth roadmaps using everything ARIA knows.

**Key Function:**

```typescript
export async function generatePersonalisedRoadmap(
  userId: string,
  user: any,
): Promise<RoadmapResult>
```

**What It Does:**

1. **Parallel loads** voice portrait, memory, and recent content history
2. **Extracts insights** from memory (what ARIA has observed)
3. **Builds context blocks** with:
   - Creator identity (archetype, platform, follower range, growth stage)
   - Voice portrait (tone, vocabulary, energy, constraints, formats)
   - Memory observations (what they return to, confidence levels)
   - Recent content history (what they've actually made)
   - ARIA profile analysis (strengths, gaps, opportunities)
   - Scraped platform data (real engagement patterns)
4. **Calls Groq** with deeply personalised prompt (not generic advice)
5. **Returns roadmap** with:
   - Current situation (specific to this creator)
   - Core challenge (THE thing holding them back)
   - Weekly plan with specific actions for their constraints
   - Milestones with realistic timelines
   - Content strategy (formats, frequency, best times, topic pillars)
   - Growth projection (conservative vs optimistic)
   - Immediate action (24-hour focus)

**Caching:** 6 hours TTL. Invalidated whenever voice portrait is rebuilt.

**Key Difference from Old `getGrowthPrediction`:**
- **Old:** Generic advice based only on follower_range, engagement_rate, archetype
- **New:** Specific advice using voice portrait, memory, content history, platform data, and constraints

---

#### File 3: `src/controllers/roadmap.controller.ts`

**Endpoints:**

1. `GET /api/v1/analytics/roadmap` — Get personalised roadmap (cached)
2. `GET /api/v1/analytics/roadmap/refresh` — Force refresh bypassing cache

Both use `generatePersonalisedRoadmap` service, handle caching, and return full user context.

---

### **Existing Files Updated** (4 files)

#### File 1: `src/agent/aria_agent.ts`

**Change 1: Replaced `_extractAndStoreSuggestions`**

- **Old:** Only detected day-of-week mentions using regex
- **New:** Uses Groq to extract all actionable suggestions:
  - Posting times
  - Hook formats
  - Topic ideas
  - Posting frequency
  - Hashtag strategies
  - Collaborations
  - Format changes

**Process:**
1. ARIA makes response
2. Groq prompt extracts concrete suggestions from response
3. Each suggestion stored with `follow_up_at` (3-7 days out)
4. Added to `aria_suggestions` table with type, content, and timing

**Change 2: Load pending suggestions in system prompt**

```typescript
// Was:
const [memory, voicePortrait] = await Promise.allSettled([
  getMemory(user.id),
  getVoicePortrait(user.id),
]);
const systemPrompt = buildARIASystemPrompt({
  ...
  pendingSuggestions: [],  // ← Hardcoded empty!
});

// Now:
const [memoryResult, voicePortraitResult, pendingSuggestionsResult] = 
  await Promise.allSettled([
    getMemory(user.id),
    getVoicePortrait(user.id),
    getDueSuggestions(user.id),  // ← Real suggestions!
  ]);
const systemPrompt = buildARIASystemPrompt({
  ...
  pendingSuggestions: resolvedPendingSuggestions,  // ← Used!
});
```

Now when a creator returns to ARIA 3 days after a suggestion, ARIA sees it in the system prompt and naturally asks about it.

---

#### File 2: `src/workers/voice.worker.ts`

**Change:** After voice portrait is built, invalidate roadmap cache

```typescript
const portrait = await buildVoicePortrait(userId);
if (portrait) {
  built++;
  // ← NEW LINE
  await invalidateRoadmapCache(userId);  // Roadmap uses new voice portrait next request
}
```

This ensures roadmaps always reflect the latest voice portrait.

---

#### File 3: `src/routes/analytics.routes.ts`

**Added Routes:**

```typescript
app.get("/roadmap", { preHandler: [authenticateFirebase] }, 
  roadmapController.getPersonalisedRoadmap);
app.get("/roadmap/refresh", { preHandler: [authenticateFirebase] }, 
  roadmapController.refreshRoadmap);
```

Now the frontend can fetch personalised roadmaps at `/api/v1/analytics/roadmap`.

---

#### File 4: `src/routes/brain.routes.ts`

**Added Route:**

```typescript
app.post("/suggestion-feedback", {
  preHandler: [authenticateFirebase],
  schema: {
    body: {
      type: "object",
      required: ["suggestionId", "outcome"],
      properties: {
        suggestionId: { type: "string" },
        outcome: { type: "string", enum: ["followed", "ignored", "partially"] },
        notes: { type: "string", maxLength: 500 },
      },
    },
  },
}, async (req, reply) => {
  const user = req.user as User;
  const { suggestionId, outcome, notes } = req.body as any;

  await recordSuggestionFeedback(suggestionId, user.id, outcome, notes);
  return success(reply, { recorded: true });
});
```

Frontend can now report feedback on suggestions. This:
1. Updates suggestion status (acted/ignored/partial)
2. Writes outcome back to memory
3. Boosts confidence in suggestion types the creator acts on

---

## How It Works End-to-End

### Scenario: Creator "Priya" (Budget Fashion, Faceless, Hinglish)

#### Day 1: Priya Asks ARIA for a Roadmap

**Request:** `GET /api/v1/analytics/roadmap`

**What Happens:**
1. Service loads voice portrait (built weekly from memory)
2. Service loads memory (what ARIA has observed)
3. Service loads last 20 content pieces
4. Service builds context with all this data
5. Groq generates roadmap specific to Priya
6. Roadmap is cached for 6 hours
7. Response includes:

```json
{
  "currentSituation": "Your budget-fashion content is performing well but your posting dropped from 4 Reels per week to 2 last month. Given that you film at home and work solo, the sustainable pace for you is 3 Reels per week rather than pushing for 4.",
  "coreChallenge": "Consistency without burnout — finding a sustainable rhythm that works with your solo setup",
  "weeklyPlan": {
    "week1": {
      "focus": "Establish sustainable 3-per-week rhythm with your core haul format",
      "actions": [
        {
          "action": "Film 2 hauls this week (Meesho finds under ₹300)",
          "why": "Your last 3 hauls averaged 12% engagement. This is your strongest format.",
          "howTo": "Use your phone, home background, 15-min filming window",
          "expectedImpact": "Establish rhythm, test consistency impact on algorithm"
        }
      ]
    }
    // ... weeks 2-4
  },
  "milestones": [
    {
      "target": "25K followers",
      "eta": "~45 days at 3 Reels/week consistent",
      "unlocks": "Brand gifting from Meesho, FabAlley, Myntra becomes accessible",
      "triggerAction": "Post 3 Reels every single week for 6 weeks straight"
    }
  ],
  "contentStrategy": {
    "formats": ["Reels", "Carousels"],
    "frequency": "3 Reels per week (e.g., Wed, Fri, Sun)",
    "bestTimes": "7pm-9pm IST (peak college scrolling)",
    "topicPillars": ["Budget hauls (₹100-500)", "Styling hacks for small wardrobes", "Meesho finds"]
  }
}
```

#### Day 2: ARIA Suggests a Specific Action

**Priya:** "I want to start posting more consistently"

**ARIA:** "Great! Let's start with your strongest format — budget hauls. Your Meesho finds videos are getting 12% engagement consistently. I'd suggest posting a haul on **Wednesday at 7pm** — that's when your audience is most active. Film it in the next 3 hours, edit tonight. How does that sound?"

**Behind the scenes:**
1. ARIA response is sent to Groq extraction prompt
2. Extraction prompt finds: posting time suggestion (Wednesday 7pm)
3. Suggestion stored to `aria_suggestions` table:
   ```
   {
     user_id: "priya_id",
     suggestion_type: "posting_time",
     suggestion_data: { content: "Post on Wednesday at 7pm", ... },
     status: "pending",
     follow_up_at: now + 3 days,
     follow_up_sent: false
   }
   ```

#### Day 5: ARIA Follows Up

**Priya returns and says:** "I've been thinking about what to post"

**Behind the scenes:**
1. System loads pending suggestions
2. Finds the "Wednesday 7pm posting" suggestion from Day 2
3. Injects into system prompt: "This creator was suggested to post Meesho hauls on Wednesday at 7pm. It's been 3 days. They may have tried it, ignored it, or forgotten. Natural follow-up opportunity."

**ARIA:** "Hey! Did you end up trying that Wednesday 7pm posting time I mentioned? I'm curious if it helped reach your audience better than your usual posting times."

**Priya:** "Yes! I did post on Wednesday at 7pm and got way more engagement — went from 200 likes to 400 likes!"

**Priya clicks feedback button or tells ARIA directly:** "Yes, I followed that suggestion"

**Behind the scenes:**
1. `recordSuggestionFeedback` is called with outcome: "followed"
2. Suggestion status updated to "acted"
3. Memory is updated:
   - `suggestion_outcome: posting_time_outcome = "followed: worked well"`
   - `responsive_to: posting_time = "follows_this_type"` (confidence boosted)
4. Next time ARIA generates a roadmap, it sees Priya is responsive to posting time suggestions
5. More posting time suggestions get priority in future recommendations

#### Day 30: ARIA's Advice Gets Smarter

**Roadmap Refresh:**
1. Voice portrait was rebuilt (weekly)
2. Roadmap cache was invalidated
3. Priya opens roadmap again
4. Service loads updated memory:
   - Knows Priya followed Wednesday 7pm → posted 3 times that week at 7pm
   - Knows Priya's engagement increased
   - Knows Priya is responsive to posting time suggestions
5. Groq sees all this context and generates Week 4 recommendations that build on what's working

---

## Technical Details

### Data Flow Diagram

```
ARIA Chat → _extractAndStoreSuggestions → aria_suggestions table (pending)
                                                      ↓
                                          3+ days pass
                                                      ↓
Next Chat Load → getDueSuggestions → buildARIASystemPrompt → ARIA naturally follows up
                                                      ↓
                                            Creator responds
                                                      ↓
                                    recordSuggestionFeedback → upsertMemory
                                                      ↓
                                        Memory updated with outcome
                                                      ↓
        Next Roadmap/Chat → Uses updated memory → Smarter suggestions
```

### Caching Strategy

- **Roadmap:** 6 hours TTL (rebuilt when voice portrait updates)
- **Voice Portrait:** 24 hours TTL
- **Memory:** 5 minutes TTL (always fresh)
- **Suggestions:** No cache (DB queries are fast)

### Suggestion Type Detection

Groq extracts these suggestion types:
- `posting_time` — "Post on Wednesday at 7pm"
- `hook_format` — "Try a question hook instead"
- `topic_idea` — "Make a video about [topic]"
- `posting_frequency` — "Post 4 times this week"
- `hashtag_strategy` — "Use these 5 hashtags"
- `collab` — "Collab with a creator in [niche]"
- `format_change` — "Try Carousels instead of Reels"
- `other` — Anything else

Each has a default follow-up window (3-7 days depending on type).

---

## Testing Checklist

- [x] TypeScript builds with zero errors
- [x] `suggestion.service.ts` imports and exports correctly
- [x] `roadmap.service.ts` loads voice, memory, content history in parallel
- [x] `roadmap.controller.ts` handles caching and refresh
- [x] `aria_agent.ts` uses Groq to extract suggestions (not regex)
- [x] `aria_agent.ts` loads pending suggestions into system prompt
- [x] `voice.worker.ts` invalidates roadmap cache after rebuild
- [x] `analytics.routes.ts` registers roadmap endpoints
- [x] `brain.routes.ts` registers suggestion-feedback endpoint
- [x] All functions handle null/missing data gracefully
- [x] `npm run build` passes with zero errors

---

## Next Steps After Deployment

### Immediate (Week 1)
1. **Monitor suggestion accuracy** — Are extracted suggestions actually specific and actionable?
2. **Check feedback loop** — Are creators using the feedback button? Recording outcomes?
3. **Test roadmap personalization** — Does each creator get advice specific to their constraints?

### Short term (Week 2-3)
1. **Track follow-through rates** — What % of suggestions do creators act on? By type?
2. **Analyze memory learning** — Is memory confidence increasing as creators respond?
3. **Check roadmap cache effectiveness** — Is 6-hour TTL working? Too short/long?

### Medium term (Month 2)
1. **A/B test suggestion timing** — Are 3-day follow-ups optimal or should they vary?
2. **Analyze roadmap accuracy** — Did creators actually achieve the 45-day milestone estimates?
3. **Expand suggestion types** — What other actionable suggestions should be extracted?

---

## Files Modified Summary

| File | Type | Changes |
|------|------|---------|
| `src/services/suggestion.service.ts` | New | 145 lines — Full suggestion loop management |
| `src/services/roadmap.service.ts` | New | 180 lines — Personalised roadmap generation |
| `src/controllers/roadmap.controller.ts` | New | 60 lines — Roadmap endpoints |
| `src/agent/aria_agent.ts` | Updated | +30 lines — Groq extraction + pending suggestions |
| `src/workers/voice.worker.ts` | Updated | +2 lines — Roadmap cache invalidation |
| `src/routes/analytics.routes.ts` | Updated | +10 lines — Roadmap routes |
| `src/routes/brain.routes.ts` | Updated | +60 lines — Suggestion feedback endpoint |

**Total:** 7 files touched, 3 new, 4 updated. ~550 lines of new code. Zero breaking changes.

---

## Build Status

✅ **npm run build** — PASSED with zero errors

The backend is ready to deploy.

---

## Integration with Steps 1-4

This implementation completes the full personalisation loop:

- **Step 1:** Observer watches creators and builds memory
- **Step 2:** Memory is reinforced through conversation
- **Step 3:** Voice portrait is synthesized from memory
- **Step 4:** Voice is injected into chat, trends, scripts, BGM
- **Step 5 (NEW):** Roadmap is generated using voice + memory + history
- **Step 6 (NEW):** Suggestions are extracted, followed up, and feedback loops back to memory

Result: A self-improving system where every interaction makes ARIA smarter about this specific creator.
