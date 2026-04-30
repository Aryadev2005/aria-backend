# TrendAI Groq Integration - Final Deployment Checklist

## ✅ PART A: GROQ INTEGRATION - COMPLETE

### Phase 1: Code Integration ✅
- [x] Created `src/services/ai/groq.service.js` (400 lines)
  - [x] 4 new ARIA functions (detectArchetype, analyzeGaps, generateViralBlueprint, fullPersonaGrowthMap)
  - [x] 8 upgraded existing functions (all accept archetype parameter)
  - [x] Proper error handling with logger
  - [x] JSON parsing with fallback

- [x] Updated `src/controllers/content.controller.js`
  - [x] Changed import: claudeService → groqService
  - [x] All 4 functions pass archetype parameter
  - [x] Fully backward compatible

- [x] Updated `src/controllers/trend.controller.js`
  - [x] Changed import: claudeService → groqService
  - [x] Enhanced getTrends() with live_trends fallback
  - [x] Enhanced getPersonalizedTrends() with archetype + live context
  - [x] Updated getOpportunityWindows() with archetype
  - [x] Updated getViralRadar() with archetype
  - [x] New submitFeedback() function added

- [x] Updated `src/controllers/analytics.controller.js`
  - [x] New getDashboard() using ARIA fullPersonaGrowthMap()
  - [x] Auto-detects and persists archetype
  - [x] New getArchetype() function
  - [x] New triggerScrape() function

- [x] Fixed `src/routes/trend.routes.js`
  - [x] Corrected to use trendController (was userController)
  - [x] Added all trend endpoints
  - [x] Added POST /feedback endpoint

- [x] Updated `src/routes/analytics.routes.js`
  - [x] Added GET /archetype endpoint
  - [x] Added POST /scrape endpoint

- [x] Updated `package.json`
  - [x] Removed @anthropic-ai/sdk
  - [x] Added groq-sdk ^0.7.0

### Phase 2: Database Schema ✅
- [x] Created `prisma/migrations (Prisma-managed)`
  - [x] 15 new columns added to users table
  - [x] Created aria_feedback table
  - [x] Created live_trends table
  - [x] Created live_songs table
  - [x] Created performance indexes
  - [x] All migrations use IF NOT EXISTS (idempotent)

### Phase 3: Documentation ✅
- [x] Created `INTEGRATION_SUMMARY.md`
  - [x] Overview of all changes
  - [x] Verification checklist
  - [x] Files modified list

- [x] Created `GROQ_QUICKSTART.md`
  - [x] Installation steps
  - [x] Environment setup
  - [x] Testing examples
  - [x] Troubleshooting guide

- [x] Created `BEFORE_AFTER.md`
  - [x] Side-by-side code comparisons
  - [x] Architecture evolution
  - [x] Summary table

- [x] Created `FILE_MANIFEST.md`
  - [x] Complete file tree
  - [x] Statistics
  - [x] Deployment steps

### Phase 4: Code Quality ✅
- [x] All files pass linting (no errors detected)
- [x] No breaking changes
- [x] Fully backward compatible
- [x] Proper error handling throughout
- [x] Logger integration in all services

---

## 🚀 Pre-Deployment Checklist

### Environment
- [ ] Node.js 18+ installed
- [ ] npm 9+ installed
- [ ] PostgreSQL 13+ running
- [ ] Redis running
- [ ] Firebase credentials configured

### Configuration
- [ ] `.env` file created
- [ ] `GROQ_API_KEY` set (from https://console.groq.com)
- [ ] `GROQ_MODEL` set (optional, defaults to mixtral-8x7b-32768)
- [ ] Database credentials configured
- [ ] Redis connection configured

### Dependencies
- [ ] `npm install` completed successfully
- [ ] `groq-sdk` ^0.7.0 installed
- [ ] All dependencies installed without errors

### Database
- [ ] PostgreSQL connection working
- [ ] Existing migration 001 & 002 applied
- [ ] Migration 003 ready to apply

---

## 📋 Deployment Steps

### Step 1: Prepare
```bash
# Clone/pull latest code
cd /Users/aryadevchatterjee/Documents/trendai-backend

# Verify Node version
node --version  # Should be 18+

# Verify npm version
npm --version   # Should be 9+
```

### Step 2: Configure
```bash
# Copy .env.example to .env (if not exists)
cp .env.example .env  # or create manually

# Edit .env and add:
GROQ_API_KEY=gsk_xxxxxxxxxxxx
GROQ_MODEL=mixtral-8x7b-32768  # optional
```

### Step 3: Install
```bash
# Install dependencies
npm install

# Verify groq-sdk installed
npm ls groq-sdk  # Should show ^0.7.0
```

### Step 4: Migrate Database
```bash
# Run migrations
npx prisma migrate deploy

# Verify migration succeeded
# Check PostgreSQL for new columns in users table:
# - archetype, archetype_label, archetype_confidence, etc.
# Check for new tables:
# - aria_feedback, live_trends, live_songs
```

### Step 5: Verify
```bash
# Start development server
npm run dev

# In another terminal, test health endpoint
curl http://localhost:3000/health

# Expected response:
# {
#   "status": "healthy",
#   "timestamp": "2026-04-26T...",
#   "uptime": 2.5,
#   "version": "1.0.0"
# }
```

### Step 6: Test Integration
```bash
# Test public endpoint (no auth needed)
curl http://localhost:3000/api/v1/trends

# Test auth endpoint (requires Firebase token)
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/v1/analytics/dashboard

# Test new archetype endpoint
curl -H "Authorization: Bearer <token>" \
  http://localhost:3000/api/v1/analytics/archetype
```

---

## 🧪 Integration Testing

### Manual Tests (All Should Pass)

#### Test 1: Content Generation with Archetype
```bash
POST /api/v1/content/generate
{
  "trendTitle": "Sustainable Fashion",
  "platform": "instagram",
  "niche": "fashion"
}
# Should use user.archetype in request to Groq
```

#### Test 2: Personalized Trends
```bash
GET /api/v1/trends/personalized
# Should return trends with user's archetype considered
```

#### Test 3: Dashboard Auto-Detects Archetype
```bash
GET /api/v1/analytics/dashboard
# First call: Should detect archetype and return 202 or full result
# Second call: Should use cached archetype
# DB should have archetype, growth_stage, tone_profile populated
```

#### Test 4: Feedback Submission
```bash
POST /api/v1/trends/feedback
{
  "recommendationType": "trend",
  "recommendationData": {"trendId": "123"},
  "wasHelpful": true,
  "resultNotes": "Great!"
}
# Should store in aria_feedback table
```

#### Test 5: Trigger Scrape (Queues Job)
```bash
POST /api/v1/analytics/scrape
{
  "handle": "fashionblogger",
  "platform": "instagram"
}
# Should return 202 Accepted
```

---

## 📊 Monitoring After Deployment

### Check Server Health
```bash
# Verify server is running
curl http://localhost:3000/health

# Check logs for errors
tail -f logs/*.log

# Monitor Groq API calls
# Watch for:
# - API response times
# - Error rates
# - Token usage
```

### Verify Database Changes
```sql
-- Check new users columns
SELECT archetype, growth_stage, tone_profile, aria_analyzed_at 
FROM users LIMIT 5;

-- Check aria_feedback table
SELECT * FROM aria_feedback;

-- Check live_trends table (should be empty until workers start)
SELECT * FROM live_trends;

-- Check live_songs table (should be empty until workers start)
SELECT * FROM live_songs;
```

### Monitor Performance
```bash
# Track response times
curl -w "\nResponse time: %{time_total}s\n" \
  http://localhost:3000/api/v1/trends

# Monitor Groq API rate limits
# Check GROQ_API_KEY usage: https://console.groq.com/admin/usage
```

---

## ⚠️ Troubleshooting

### Issue: "groq-sdk not found"
**Solution:**
```bash
npm install groq-sdk@^0.7.0
npm ls groq-sdk
```

### Issue: "GROQ_API_KEY is missing or invalid"
**Solution:**
```bash
# Verify .env file
cat .env | grep GROQ_API_KEY

# Get new key from: https://console.groq.com
# Update .env and restart server
```

### Issue: "Database migration failed"
**Solution:**
```bash
# Check PostgreSQL connection
psql $DATABASE_URL -c "SELECT 1"

# Run migration again
npx prisma migrate deploy

# Check migration status
psql $DATABASE_URL -c "\d users" | grep archetype
```

### Issue: "Archetype not detected"
**Solution:**
```bash
# Check logs for detectArchetype errors
tail logs/error.log | grep archetype

# Verify Groq API is working
# Test directly: curl https://api.groq.com/health

# Wait 5-10 seconds and retry
```

### Issue: "Dashboard returns cached old data"
**Solution:**
```bash
# Clear Redis cache
redis-cli FLUSHDB

# Or restart server
npm run dev
```

---

## 🔄 Rollback Plan

If you need to rollback:

### Quick Rollback
```bash
# 1. Stop server
# 2. Revert package.json
git checkout package.json
npm install

# 3. Revert controllers
git checkout src/controllers/

# 4. Restart server
npm run dev
```

### Database Rollback
```sql
-- If needed, rollback migration 003
-- (Keep archive data for reference)
ALTER TABLE users DROP COLUMN IF EXISTS archetype;
ALTER TABLE users DROP COLUMN IF EXISTS archetype_label;
-- etc.

DROP TABLE IF EXISTS aria_feedback;
DROP TABLE IF EXISTS live_trends;
DROP TABLE IF EXISTS live_songs;
```

---

## ✅ Post-Deployment Checklist

After deployment, verify:

- [ ] Server started without errors
- [ ] Health endpoint returns 200
- [ ] Database migration completed
- [ ] New columns visible in users table
- [ ] New tables created (aria_feedback, live_trends, live_songs)
- [ ] Public trends endpoint works
- [ ] Auth required endpoints return 401 without token
- [ ] Dashboard returns ARIA analysis
- [ ] Archetype properly detected and saved
- [ ] Feedback endpoint stores data
- [ ] Scrape endpoint returns 202 Accepted
- [ ] Logs show no errors
- [ ] Groq API responding correctly
- [ ] Redis cache working
- [ ] Database queries optimized (use indexes)

---

## 📞 Support & Debugging

### Enable Debug Logging
```bash
# In .env
LOG_LEVEL=debug

# Or use:
NODE_DEBUG=* npm run dev
```

### Test Groq Connection
```javascript
// Create test file: test-groq.js
const Groq = require('groq-sdk')
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

groq.chat.completions.create({
  model: 'mixtral-8x7b-32768',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Hello!' }]
}).then(r => console.log(r.choices[0].message.content))
.catch(e => console.error(e))

// Run:
node test-groq.js
```

### Monitor API Usage
```bash
# Check Groq dashboard: https://console.groq.com/admin/usage
# View:
# - Requests per minute
# - Average latency
# - Error rate
# - Token usage
```

---

## 🎯 Success Criteria

**PART A is complete when:**

1. ✅ All files deployed without errors
2. ✅ Database migration successful
3. ✅ All new endpoints responding correctly
4. ✅ Groq API integration working
5. ✅ Archetype detection functional
6. ✅ Feedback system recording data
7. ✅ No breaking changes to existing API
8. ✅ Logs show no critical errors
9. ✅ Performance acceptable (< 500ms per request)
10. ✅ All tests passing

---

## 📅 Timeline

| Phase | Duration | Status |
|-------|----------|--------|
| Planning | Done | ✅ |
| Development | Done | ✅ |
| Testing | Ready | ⏳ |
| Staging Deploy | Ready | ⏳ |
| Production Deploy | Ready | ⏳ |
| Monitoring | Ready | ⏳ |

---

## 🚀 Next: PART B - BullMQ Workers

After PART A is confirmed working:

1. Create `src/workers/trend.worker.js`
   - Fetches live trends from market sources
   - Populates `live_trends` table

2. Create `src/workers/song.worker.js`
   - Fetches trending songs/audio
   - Populates `live_songs` table

3. Update Queue Configuration
   - Set up BullMQ queues
   - Configure job schedules

4. Implement Social Scraping
   - Instagram handle scraping
   - YouTube channel scraping

---

**Version**: TrendAI Backend v2.0 (Groq Integration)
**Last Updated**: April 26, 2026
**Status**: ✅ **READY FOR DEPLOYMENT**

**Deployment Owner**: [Your Name]
**Deployment Date**: [To be filled]
**Deployment Approved By**: [To be filled]

