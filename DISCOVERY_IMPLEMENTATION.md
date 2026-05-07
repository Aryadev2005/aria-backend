# DISCOVERY SYSTEM - IMPLEMENTATION PROGRESS

## COMPLETED ✅

### PART 1 — DATABASE MIGRATION
- [x] Created migration file: `prisma/migrations/discovery_unified/migration.sql`
- [x] Updated `prisma/schema.prisma` with:
  - [x] Updated `live_trends` model with new columns:
    - `platform_raw_score` (DECIMAL)
    - `content_format` (TEXT)
    - `override_reason` (TEXT)
    - `is_override` (BOOLEAN)
  - [x] Added `scrape_health` model
  - [x] Added `trend_interactions` model
  - [x] Added relation to `users` model

**Next step**: Run `npx prisma db push && npx prisma generate`

### PART 2 — UNIFIED SCORING ENGINE
- [x] Created `src/services/discovery/scoring.service.ts`
  - [x] `computeYouTubeVelocity()` - YouTube score formula
  - [x] `computeRedditScore()` - Reddit hotness + friction detection
  - [x] `computeTikTokVelocity()` - TikTok engagement + share breakout
  - [x] `computePinterestScore()` - Pinterest saves/clicks + intent detection
  - [x] `computeGoogleSlope()` - Google Trends slope + breakout detection
  - [x] `normaliseScore()` - Unified 0-100 normalization
  - [x] `makeVelocityDecision()` - Velocity gate + override logic
  - [x] `detectContentFormat()` - Format detection (short_form, long_form, etc)

### PART 3 — SCRAPE HEALTH SERVICE
- [x] Created `src/services/discovery/scrape-health.service.ts`
  - [x] `markScrapeRunning()` - Start of scrape
  - [x] `markScrapeSuccess()` - Success with result count check
  - [x] `markScrapeFailed()` - Failure with consecutive count
  - [x] `isSourceHealthy()` - Health check before overwrite
  - [x] `extendSourceData()` - Extend expiry on failure

### PART 4 — DISCOVERY WORKER (PARTIAL)
- [x] Created `src/workers/discovery.worker.ts`
  - [x] YouTube scraper (mostPopular + search.list)
  - [x] Reddit scraper (via Apify)
  - [x] TikTok/Pinterest/Google stubs
  - [x] Cleanup and pre-warm functions
  - [x] Main job processor
  - [x] Worker lifecycle (start/stop)

**NOTE**: TikTok, Pinterest, Google scrapers need full implementation from the spec

## TODO ⏳

### PART 5 — UPDATE VIRAL IDEAS SERVICE
- [ ] Find and update `generateViralIdeas()` in `src/services/viralIdeas.service.ts`
- [ ] Replace signal-fetching section with new RAG + direct DB fallback
- [ ] Update prompt building with new context

### PART 6 — TREND INTERACTIONS CONTROLLER
- [ ] Add `recordTrendInteraction` controller to `src/controllers/trend.controller.ts`
- [ ] Add route to `src/routes/trend.routes.ts`

### PART 7 — FRONTEND INTEGRATION
- [ ] Add `useRecordTrendInteraction` hook to `src/hooks/useApi.js`
- [ ] Wire up interactions in `src/pages/dashboard/Discover.jsx`

### FINAL STEPS
- [ ] Environment variables configuration
- [ ] Discovery worker schedule (12 hours)
- [ ] Verify Apify actor IDs
- [ ] Raw table schemas (tiktok_raw, pinterest_raw, google_trends_raw)
- [ ] embedNewTrends() function if missing
- [ ] First run validation

## NOTES
- Discovery worker runs every 12 hours
- YouTube + Reddit run every 12 hours
- TikTok/Pinterest/Google run every 24h (staggered via scrape_health)
- All pass through unified scoring before live_trends
- Velocity threshold = 3 (0-100 scale)
- Qualitative overrides for high friction/intent/breakout signals
