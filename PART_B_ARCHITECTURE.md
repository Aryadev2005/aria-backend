# TrendAI Part B - Implementation Details & Architecture

## 🏗️ System Architecture

### Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         TrendAI Data Pipeline                        │
└──────────────────────────────────────────────────────────────────────┘

TRENDS PIPELINE
══════════════════════════════════════════════════════════════════════

Redis (BullMQ)
    ↓
[Scheduled Job] "fetch-india-trends" (every 6 hours)
    ↓
trend.worker.js
    ├─→ fetchGoogleTrends()
    │   └─ 6 trending searches from India
    │   └ Velocity = 100 - (position * 8)
    │
    ├─→ fetchRedditTrends() [if Google fails]
    │   └─ r/india hot posts (10 max)
    │   └─ Rate limited: 2 second delay
    │
    └─→ FALLBACK_TRENDS [if both fail]
        └─ 8 evergreen categories (never empty)

    ↓ detectNiches() [keyword matching]
    
    ├─ Title: "Fashion styling tips"
    ├─ Keywords: ['fashion', 'style']
    ├─ Tags: ['fashion'] → niche_tags
    └─ Velocity: 85

    ↓

PostgreSQL: live_trends
├─ id: UUID
├─ source: 'google' | 'reddit' | 'fallback'
├─ title: TEXT
├─ search_volume: INTEGER
├─ velocity: 0-100 DECIMAL
├─ niche_tags: TEXT[] ['fashion', 'general']
├─ platform_tags: JSONB
├─ expires_at: NOW() + 6 HOURS
└─ fetched_at: NOW()

    ↓

trend.controller.js
├─→ SELECT * FROM live_trends
│   WHERE expires_at > NOW() AND niche_tags contains 'fashion'
│   ORDER BY velocity DESC
│   
├─ [If enough live data] Return to client
│
└─ [If too stale] Fallback: groqService.generateTrendInsights()


SONGS PIPELINE
══════════════════════════════════════════════════════════════════════

Redis (BullMQ)
    ↓
[Scheduled Job] "fetch-spotify-charts" (every 2 hours)
    ↓
song.worker.js
    ├─→ fetchSpotifyCharts()
    │   ├─ URL: charts.spotify.com/regional-in-daily/latest
    │   ├─ Parse HTML: <script id="__NEXT_DATA__">
    │   ├─ Extract: rank, track, artist, streams, uri
    │   └─ Return: top 30 songs
    │
    ├─→ fetchJioSaavnCharts() [if Spotify fails]
    │   ├─ URL: jiosaavn.com/api.php?...
    │   ├─ Rate limited: 2 second delay
    │   └─ Parse: getFeaturedPlaylists()
    │
    └─→ FALLBACK_SONGS [if both fail]
        └─ 10 hardcoded trending Indian songs

    ↓ For each song:
    
    ├─ detectLanguage("Naatu Naatu")
    │  └─ Returns: 'Telugu'
    │
    ├─ previousMap = DB query (last 4 hours)
    │  └─ If "Song Name|Artist" found
    │     └─ chart_change = oldPosition - newPosition
    │
    ├─ determineLifecycle(position)
    │  ├─ Position 1-10 → 'peak'
    │  ├─ Position 11-30 → 'rising'
    │  └─ Position 31+ → 'early'
    │
    └─ determineSignal(position)
       ├─ Position 1-15 → 'PostNow'
       ├─ Position 16-30 → 'PostSoon'
       └─ Position 31+ → 'Avoid'

    ↓

PostgreSQL: live_songs
├─ id: UUID
├─ source: 'spotify' | 'jiosaavn' | 'fallback'
├─ title: TEXT
├─ artist: TEXT
├─ chart_position: INTEGER
├─ chart_change: INTEGER (prev_pos - current_pos)
├─ streams_today: BIGINT
├─ language: TEXT ['Hindi', 'Telugu', 'Tamil']
├─ raw_data: JSONB { signal, lifecycle }
└─ fetched_at: TIMESTAMPTZ

    ↓

Controllers (song.controller.js)
├─→ SELECT * FROM live_songs
│   WHERE fetched_at > NOW() - INTERVAL '2 hours'
│   ORDER BY chart_position ASC
│
└─ Use signal + lifecycle for creator recommendations


PROFILE SCRAPE PIPELINE
══════════════════════════════════════════════════════════════════════

analytics.controller.js
    ↓
triggerScrape() → enqueueScrapeJob(userId, handle, 'instagram')
    ↓
Redis (BullMQ)
    ↓
scrape.worker.js
    ├─→ scrapeAndSaveProfile(userId, handle, 'instagram')
    │   ├─ Check: Python 3 available?
    │   ├─ Run: python3 scripts/scrape_instagram.py {handle}
    │   └─ Timeout: 60 seconds
    │
    ├─→ Parse JSON output
    │   ├─ followers: 24500
    │   ├─ totalPosts: 145
    │   ├─ posts: [{likes, comments, type, caption, hashtags}]
    │   ├─ postsPerWeek: 3.2
    │   ├─ topHashtags: ['#fashion', '#ootd']
    │   └─ isPrivate: false
    │
    ├─→ buildScrapedSummary(rawData)
    │   ├─ totalPostsAnalyzed: 20
    │   ├─ postTypeMix: "75% reels, 25% photos"
    │   ├─ avgLikes: 1240
    │   ├─ avgComments: 45
    │   ├─ postsPerWeek: 3.2
    │   ├─ avgCaptionLength: 85
    │   ├─ topHashtags: ['#fashion', '#ootd', '#style']
    │   ├─ bestPostType: 'reel'
    │   ├─ worstPostType: 'photo'
    │   └─ followerCount: 24500
    │
    ├─→ computeEngagementRate(posts, followers)
    │   └─ Formula: ((avgLikes + avgComments) / followers) * 100
    │   └─ Result: 5.18% engagement rate
    │
    └─→ Save to users table
        ├─ UPDATE users SET
        │  ├─ scraped_summary = JSON
        │  ├─ scraped_at = NOW()
        │  ├─ engagement_rate = 5.18
        │  └─ instagram_handle = 'cristiano'
        │
        └─ invalidate cache: u:{userId}

    ↓

Trigger ARIA Re-analysis
    ├─→ groqService.detectArchetype({
    │   ├─ niche: 'fitness'
    │   ├─ platform: 'instagram'
    │   ├─ followerRange: '10K-100K'
    │   ├─ creatorIntent: 'Build authority'
    │   └─ scrapedData: { avgLikes, postTypeMix, ... }
    │   })
    │
    └─→ UPDATE users SET
        ├─ archetype = 'INFLUENCER'
        ├─ archetype_label = 'Lifestyle & Fitness'
        ├─ archetype_confidence = 0.92
        ├─ growth_stage = 'established'
        ├─ health_score = 85
        └─ aria_analyzed_at = NOW()

    ↓

dashboard request
    └─→ User sees updated archetype + recommendations


FEEDBACK PIPELINE
══════════════════════════════════════════════════════════════════════

Creator receives ARIA recommendation
    ↓
Creator tries it, tracks results
    ↓
Creator submits feedback
POST /api/v1/trends/feedback
{
  "recommendationType": "trend",
  "recommendationData": {
    "trend": "AI Content Tools",
    "platform": "instagram",
    "expectedGrowth": "500-1000 followers"
  },
  "wasHelpful": true,
  "resultNotes": "Grew 850 followers in 1 week"
}
    ↓
INSERT INTO aria_feedback
├─ user_id: UUID
├─ recommendation_type: 'trend' | 'hook' | 'posting_time'
├─ recommendation_data: JSONB
├─ was_helpful: true
├─ result_notes: TEXT
└─ created_at: NOW()

    ↓

getRecentFeedbackForUser(userId)
    └─ Fetches last 5 feedback entries
    └─ Used by controllers to inject into ARIA prompts
    └─ ARIA learns: "This creator responds well to fitness trends"

```

---

## 🔄 Worker Implementation Details

### Trend Worker Lifecycle

```javascript
// 1. BullMQ calls this every 6 hours
const processTrendJob = async (job) => {
  // 2. Try each source in order
  let allTrends = []
  
  // Attempt 1: Google Trends
  try {
    const trends = await fetchGoogleTrends()
    if (trends) allTrends = [...allTrends, ...trends]
  } catch (err) {
    logger.warn('Google failed, trying Reddit')
  }
  
  // Attempt 2: Reddit (if Google insufficient)
  try {
    if (allTrends.length < 5) {
      const trends = await fetchRedditTrends()
      if (trends) allTrends = [...allTrends, ...trends]
    }
  } catch (err) {
    logger.warn('Reddit failed, using fallback')
  }
  
  // Attempt 3: Fallback (always succeeds)
  if (allTrends.length === 0) {
    allTrends = FALLBACK_TRENDS
  }
  
  // 3. Clean old data
  await sql`DELETE FROM live_trends WHERE fetched_at < NOW() - INTERVAL '6 hours'`
  
  // 4. Transform and insert
  for (const trend of allTrends) {
    const niches = detectNiches(trend.title)
    const velocity = 100 - (trend.position * 8)
    
    await sql`
      INSERT INTO live_trends (...) VALUES (...)
      ON CONFLICT DO NOTHING
    `
  }
  
  // 5. Log success
  logger.info({ count: allTrends.length }, 'Trends refreshed')
}
```

### Song Worker Lifecycle

```javascript
// Similar pattern but with songs
const processSongJob = async (job) => {
  let allSongs = []
  
  // Try Spotify, JioSaavn, fallback
  // ... (same pattern as trends)
  
  // Get previous positions for chart_change
  const previousSongs = await sql`
    SELECT title, artist, chart_position FROM live_songs
    WHERE fetched_at > NOW() - INTERVAL '4 hours'
  `
  
  // For each song, compute chart_change
  for (const song of allSongs) {
    const prevPosition = previousMap.get(`${song.title}|${song.artist}`)
    const chart_change = prevPosition ? prevPosition - song.position : 0
    
    // Detect language
    const language = detectLanguage(song.title, song.artist)
    
    // Determine signal
    const signal = determineSignal(song.position)
    
    await sql`INSERT INTO live_songs (...) VALUES (...)`
  }
}
```

### Scrape Worker Lifecycle

```javascript
const processScrapeJob = async (job) => {
  const { userId, handle, platform } = job.data
  
  // 1. Scrape profile
  const result = await scrapeAndSaveProfile(userId, handle, platform)
  
  // 2. Fetch updated user (with scraped data)
  const user = await sql`SELECT * FROM users WHERE id = ${userId}`
  
  // 3. Trigger ARIA re-analysis
  try {
    const archetype = await groqService.detectArchetype({
      niche: user.niches[0],
      platform: user.primary_platform,
      scrapedData: user.scraped_summary,
    })
    
    await sql`
      UPDATE users SET
        archetype = ${archetype.archetype},
        archetype_label = ${archetype.archetypeLabel},
        health_score = ${archetype.healthScore},
        aria_analyzed_at = NOW()
      WHERE id = ${userId}
    `
  } catch (err) {
    logger.warn('ARIA update failed (non-blocking)')
  }
}
```

---

## 🎯 Key Design Decisions

### 1. Why 3-Tier Fallback?
**Risk**: Google Trends API changes or rate-limits  
**Solution**: Multiple sources + static fallback  
**Benefit**: DB never empty, ARIA always has data

### 2. Why Separate Workers?
**Risk**: If trends fail, songs should still work  
**Solution**: Separate BullMQ queues (trend-refresh, song-refresh)  
**Benefit**: Independent scheduling, isolated error handling

### 3. Why Python for Scraping?
**Risk**: Instagram HTML parsing complex, rate-limiting required  
**Solution**: Use `instaloader` (battle-tested library)  
**Benefit**: Reliable, handles private profiles, rate-limiting built-in

### 4. Why Subprocess Over Direct Integration?
**Risk**: Python dependencies pollute Node environment  
**Solution**: Run Python as subprocess, capture JSON output  
**Benefit**: Process isolation, easy to swap Python for another language

### 5. Why Re-analyze ARIA After Scrape?
**Risk**: Archetype stale if creator changed niche/style  
**Solution**: Trigger detectArchetype() with fresh scraped data  
**Benefit**: Archetype stays fresh, recommendations stay relevant

### 6. Why Velocity Scoring?
**Risk**: How to rank trends? (position 1 vs position 10?)  
**Solution**: Position → 0-100 velocity score  
**Formula**: `velocity = 100 - (position * 8)`  
**Result**: Position 1 = 92, Position 10 = 20

### 7. Why Auto-Tagging?
**Risk**: Trends have no metadata initially  
**Solution**: Keyword matching against NICHE_KEYWORDS map  
**Benefit**: ARIA instantly knows trend's niche

---

## 🔐 Error Handling Strategy

### Level 1: Try/Catch in Worker
```javascript
try {
  const result = await fetchGoogleTrends()
  // Process result
} catch (err) {
  logger.warn('Attempt failed, trying next source')
  // Continues to next attempt
}
```

### Level 2: Worker.on('failed')
```javascript
worker.on('failed', (job, err) => {
  logger.error({ err, jobId: job.id }, 'Job failed')
  // Worker continues running
  // BullMQ retries according to config
})
```

### Level 3: Fallback Data
```javascript
if (allTrends.length === 0) {
  allTrends = FALLBACK_TRENDS
  logger.warn('All sources failed, using fallback')
}
```

### Level 4: Subprocess Error Handling
```javascript
try {
  const { stdout, stderr } = await execAsync(pythonScript)
  if (stderr && !stdout) throw new Error(stderr)
  const data = JSON.parse(stdout)
} catch (err) {
  // Return user-friendly error
  throw new Error('Could not analyze this profile. Make sure it is public.')
}
```

---

## 📊 Data Lifecycle

### live_trends
```
CREATED: fetched_at = NOW()
EXPIRES: expires_at = NOW() + 6 HOURS
DELETED: When fetched_at < NOW() - 6 HOURS
LIFECYCLE: 6 hours
STATUS: Checked on every trends request
```

### live_songs
```
CREATED: fetched_at = NOW()
EXPIRES: Soft expiry (data marked old but not deleted)
DELETED: When fetched_at < NOW() - 2 HOURS
LIFECYCLE: 2-4 hours (checked every 2 hours)
STATUS: Used for current song recommendations
```

### aria_feedback
```
CREATED: created_at = NOW() (when user submits)
EXPIRES: Never (permanent history)
DELETED: Never
LIFECYCLE: Forever (used for ARIA learning)
STATUS: Appended only, never updated
```

### users (scrape fields)
```
UPDATED: scraped_at = NOW() (when scrape completes)
FIELD: scraped_summary = JSON (aggregate stats)
FIELD: engagement_rate = DECIMAL (computed)
FIELD: instagram_handle = TEXT (saved)
LIFECYCLE: Until next scrape
STATUS: Checked on dashboard load
```

---

## 🚀 Performance Considerations

### Memory Usage
- Trend Worker: ~5MB (storing 6-30 trends in memory)
- Song Worker: ~10MB (storing 10-50 songs in memory)
- Scrape Worker x2: ~50MB (2 concurrent Python processes)
- **Total**: ~65MB additional RAM

### CPU Usage
- Trend Worker (every 6h): ~2 seconds at 50% CPU
- Song Worker (every 2h): ~3 seconds at 50% CPU
- Scrape Worker (on-demand): ~30 seconds at 70% CPU per job
- **Impact**: <5% CPU during job execution

### Network Usage
- Trend fetch: ~50KB
- Song fetch: ~100KB
- Profile scrape: ~500KB (20 posts with media links)
- **Per day**: ~500KB (minimal)

### Database I/O
- Delete old trends: 1 query (no WHERE clause = fast)
- Insert new trends: 6-30 queries (batch efficient)
- Update user: 1 query per scrape
- **Impact**: Minimal (indexes on expires_at, fetched_at)

---

## 🧪 Testing Each Component

### Unit Test: detectNiches()
```javascript
const { detectNiches } = require('./trend.worker')

describe('detectNiches', () => {
  test('detects fashion niche', () => {
    const niches = detectNiches('Best fashion styling tips OOTD')
    expect(niches).toContain('fashion')
  })
  
  test('detects multiple niches', () => {
    const niches = detectNiches('Fitness recipes cooking health')
    expect(niches).toEqual(['fitness', 'food'])
  })
  
  test('returns general if no match', () => {
    const niches = detectNiches('xyz abc def')
    expect(niches).toEqual(['general'])
  })
})
```

### Unit Test: computeEngagementRate()
```javascript
const { computeEngagementRate } = require('./scraper.service')

describe('computeEngagementRate', () => {
  test('computes correct engagement rate', () => {
    const posts = [
      { likes: 100, comments: 10 },
      { likes: 200, comments: 20 },
    ]
    const rate = computeEngagementRate(posts, 1000)
    // (100+200+10+20) / 1000 / 2 * 100 = 0.165
    expect(rate).toBeCloseTo(0.165, 2)
  })
})
```

### Integration Test: Full Pipeline
```javascript
describe('Trend Pipeline', () => {
  test('fetches trends, detects niches, stores in DB', async () => {
    // 1. Clear DB
    await sql`DELETE FROM live_trends`
    
    // 2. Run worker job
    await processTrendJob({ id: 'test' })
    
    // 3. Verify DB has data
    const trends = await sql`SELECT * FROM live_trends`
    expect(trends.length).toBeGreaterThan(0)
    
    // 4. Verify each trend has required fields
    trends.forEach(trend => {
      expect(trend.title).toBeTruthy()
      expect(trend.velocity).toBeGreaterThanOrEqual(0)
      expect(trend.velocity).toBeLessThanOrEqual(100)
      expect(trend.niche_tags).toBeTruthy()
    })
  })
})
```

---

## 🔍 Debugging Guide

### If workers don't start
```bash
# Check Redis connection
redis-cli ping
# Should respond: PONG

# Check environment variables
echo $REDIS_URL
echo $DATABASE_URL
echo $GROQ_API_KEY

# Start server with verbose logging
DEBUG=* npm run dev
```

### If trends don't appear in DB
```bash
# Check if job was queued
redis-cli
> LLEN bull:trend-refresh:...

# Check worker logs
npm run dev | grep -i "Trend\|Error"

# Manually trigger job
node -e "
const { processTrendJob } = require('./src/workers/trend.worker');
processTrendJob({ id: 'manual' });
"

# Check job result
redis-cli
> KEYS bull:trend-refresh:*:data
> GET bull:trend-refresh:*:completed:...
```

### If scraper fails
```bash
# Test Python directly
python3 scripts/scrape_instagram.py cristiano

# Check Python path
which python3
python3 --version

# Check instaloader
python3 -m pip list | grep instaloader

# Test scraper subprocess
node -e "
const { execAsync } = require('util').promisify(require('child_process').exec);
execAsync('python3 scripts/scrape_instagram.py cristiano').then(
  ({stdout}) => console.log(JSON.parse(stdout))
).catch(err => console.error(err.message));
"
```

---

## 📈 Monitoring Dashboard (Recommended)

Create a monitoring endpoint:
```javascript
app.get('/admin/workers', async (req, reply) => {
  const trendJobs = await trendQueue.getJobCounts()
  const songJobs = await songQueue.getJobCounts()
  const scrapeJobs = await scrapeQueue.getJobCounts()
  
  const liveData = {
    trends: await sql`SELECT COUNT(*) FROM live_trends WHERE expires_at > NOW()`,
    songs: await sql`SELECT COUNT(*) FROM live_songs WHERE fetched_at > NOW() - INTERVAL '4 hours'`,
    feedback: await sql`SELECT COUNT(*) FROM aria_feedback`,
  }
  
  return success(reply, {
    queues: { trendJobs, songJobs, scrapeJobs },
    liveData,
    workers: getWorkerStatus(),
  })
})
```

---

## 🎓 Lessons & Best Practices

1. **Always have a fallback**: Empty DB is worse than stale data
2. **Independent workers**: Failure in one shouldn't affect others
3. **Graceful degradation**: Worker errors should be logged, not fatal
4. **Proper cleanup**: Delete old data before inserting new
5. **Concurrency limits**: Set reasonable concurrency to prevent resource exhaustion
6. **Error context**: Include job ID, user ID, source in all logs
7. **Timeout protection**: Set timeouts for external API calls
8. **Rate limiting**: Respect API limits (Reddit: 2s delay, Spotify: public access)
9. **Data validation**: Parse JSON, check schema before inserting
10. **Cache invalidation**: Clear cache after data updates

---

This completes Part B. ARIA now has real data. 🚀
