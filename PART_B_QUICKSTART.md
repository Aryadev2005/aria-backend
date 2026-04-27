# TrendAI Part B - Quick Start Guide

## ⚡ 5-Minute Setup

### 1. Install Dependencies
```bash
npm install
pip install instaloader
```

### 2. Set Environment Variables
```bash
export GROQ_API_KEY=gsk_xxxxxxxxxxxx
export REDIS_URL=redis://localhost:6379
export DATABASE_URL=postgresql://user:pass@host/db
export SCRAPE_ENABLED=true
export TRENDS_ENABLED=true
export SONGS_ENABLED=true
export WORKER_CONCURRENCY=2
```

### 3. Run Migrations (if needed)
```bash
npm run db:migrate
```

### 4. Start Server
```bash
npm run dev
```

Workers will auto-start. Check logs:
```
✓ BullMQ scheduled: trends refresh every 6 hours
✓ BullMQ scheduled: songs refresh every 2 hours
✓ Trend worker started
✓ Song worker started
✓ Scrape worker started
✓ 🚀 TrendAI Backend is live
```

---

## 🧪 Verify Installation

### Test 1: Check Redis Queues
```bash
redis-cli
> KEYS *refresh*
> KEYS *scrape*
```
Should see: `trend-refresh:*`, `song-refresh:*`, `profile-scrape:*`

### Test 2: Query Live Data
```bash
# In psql or any SQL client
SELECT COUNT(*) FROM live_trends;
SELECT COUNT(*) FROM live_songs;

# Should see data within 5 minutes of startup
```

### Test 3: Trigger Manual Job
```bash
# Option A: Wait 6 hours for automatic job
# Option B: Use Node.js to trigger manually

node -e "
const { trendQueue } = require('./src/config/queue');
trendQueue.add('fetch-india-trends', {}).then(() => console.log('Job queued'));
"
```

### Test 4: Check Scrape Worker
```bash
# Send authenticated request to trigger scrape
curl -X POST http://localhost:3000/api/v1/analytics/scrape \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"handle":"cristiano","platform":"instagram"}'

# Response: Job ID
# Check logs: "Scrape job completed"
```

---

## 📊 Database Verification

```sql
-- Verify trends are being fetched
SELECT COUNT(*), source FROM live_trends GROUP BY source;

-- Verify songs are being fetched
SELECT COUNT(*), source FROM live_songs GROUP BY source;

-- Verify feedback is being collected
SELECT COUNT(*) FROM aria_feedback;

-- Verify scrapes are being saved
SELECT instagram_handle, engagement_rate FROM users WHERE scraped_at IS NOT NULL;
```

---

## 🔍 Troubleshooting

### Problem: No data in live_trends after 5 minutes
```
Check:
1. Are workers running? (Check logs)
2. Is Redis connected? (Check logs)
3. Is Python available? (python3 --version)
4. Check worker-specific logs:
   - Google Trends fetch: logger.warn output
   - Reddit fallback: logger.warn output
```

### Problem: Scrape fails with "Python not found"
```bash
# Fix: Install Python 3
brew install python3  # macOS
apt-get install python3  # Linux

# Verify:
python3 --version
pip3 install instaloader
```

### Problem: Instagram scrape returns "Profile not found"
```
Reason: Handle doesn't exist or Instagram is blocking
Solution: Try a different public profile (e.g., @instagram)
```

### Problem: Workers consuming too much RAM
```bash
# Reduce concurrency in .env
WORKER_CONCURRENCY=1

# Or restart workers
npm run dev  # Restarts all workers
```

---

## 📈 Monitoring

### Watch Live Logs
```bash
npm run dev | grep -E "Trend|Song|Scrape|Worker|Refresh"
```

### Check Worker Status
```bash
# In Redis CLI
redis-cli
> INFO stats

# In PostgreSQL
SELECT COUNT(*) FROM live_trends WHERE expires_at > NOW();
SELECT COUNT(*) FROM live_songs WHERE fetched_at > NOW() - INTERVAL '4 hours';
```

### Check Error Logs
```bash
# Workers log all errors but continue
# Look for lines starting with "error"
npm run dev 2>&1 | grep -i error
```

---

## 🚀 Production Deployment

### Pre-Deployment Checklist
- [ ] All environment variables set
- [ ] Database migrated
- [ ] Redis running with max memory policy
- [ ] Python 3 + instaloader installed
- [ ] Google Trends API responsive
- [ ] Reddit API accessible
- [ ] Spotify charts page accessible

### Deploy
```bash
# 1. Pull latest code
git pull origin main

# 2. Install dependencies
npm install
npm run db:migrate

# 3. Start with process manager (e.g., PM2)
pm2 start src/server.js --name trendai-backend

# 4. Monitor
pm2 logs trendai-backend
```

### Rollback
```bash
# If something breaks
pm2 stop trendai-backend
git revert HEAD
npm install
pm2 restart trendai-backend
```

---

## 🔧 Configuration

### Disable Features (for testing/staging)
```bash
# In .env
TRENDS_ENABLED=false      # Only get trends from Groq
SONGS_ENABLED=false       # Only get songs from Groq
SCRAPE_ENABLED=false      # Disable profile scraping
WORKER_CONCURRENCY=1      # Reduce concurrent scrapes to 1
```

### Adjust Frequencies
```javascript
// In src/config/queue.js, change:
repeat: { every: 6 * 60 * 60 * 1000 }  // 6 hours
// To:
repeat: { every: 1 * 60 * 60 * 1000 }  // 1 hour (for testing)
```

---

## 📚 API Endpoints Added

### Submit Feedback
```
POST /api/v1/trends/feedback
Authorization: Bearer {token}
Content-Type: application/json

{
  "recommendationType": "trend",
  "recommendationData": {"trend": "AI Content Tools"},
  "wasHelpful": true,
  "resultNotes": "Grew 500 followers"
}

Response: { "message": "Feedback received" }
```

### Trigger Profile Scrape (from Part A)
```
POST /api/v1/analytics/scrape
Authorization: Bearer {token}
Content-Type: application/json

{
  "handle": "cristiano",
  "platform": "instagram"
}

Response: { "status": "Scrape job queued" }
```

---

## 🎯 Success Indicators

**Part B is working correctly when:**

✅ After 6 minutes:
- `live_trends` has 6-8 entries
- All entries have niche_tags (auto-tagged)
- All entries have velocity scores (0-100)

✅ After 2 minutes:
- `live_songs` has 10-30 entries
- Songs have language detected
- Songs have chart_change calculated

✅ After scrape request:
- Scrape job appears in Redis queue
- Python script runs successfully
- User table updated with engagement_rate
- ARIA archetype updated

✅ Controllers use live data:
- `/api/v1/trends` returns live_trends data
- `/api/v1/trends/personalized` uses creator archetype
- Dashboard shows real growth projections

---

## 📞 Support

### Common Commands
```bash
# Start dev server with workers
npm run dev

# Just the backend (no auto workers)
node src/server.js

# Individual workers
npm run worker:trends
npm run worker:songs
npm run worker:scrape

# Database migration
npm run db:migrate

# Test specific function
node -e "require('./src/services/scraper.service.js')"
```

### Debug a Single Job
```bash
# Run trend worker manually
NODE_ENV=development npm run worker:trends

# Run song worker manually
NODE_ENV=development npm run worker:songs

# Run scrape worker manually
NODE_ENV=development npm run worker:scrape
```

### Check Python Scraper
```bash
# Test scraper directly
python3 scripts/scrape_instagram.py cristiano

# Should output JSON with followers, posts, etc.
# If error, stderr output explains why
```

---

## 🎓 Key Files to Review

If something breaks, check these files in order:

1. **src/config/queue.js** - BullMQ setup
2. **src/workers/trend.worker.js** - Trend fetching logic
3. **src/workers/song.worker.js** - Song fetching logic
4. **src/services/scraper.service.js** - Scraper wrapper
5. **src/workers/scrape.worker.js** - Scrape processing
6. **src/server.js** - Startup sequence
7. **.env** - Environment variables

---

## 🚀 You're Ready!

TrendAI Part B is now live. ARIA has real data. Go build something amazing!

Questions? Check the full **PART_B_SUMMARY.md** for detailed documentation.

Happy coding! 🎉
