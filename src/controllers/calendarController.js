// trendai-backend/src/controllers/calendarController.js

'use strict';
const ariaService = require('../services/ariaService');
const { getCache, setCache } = require('../services/cacheWrapper');
const { query } = require('../config/database');

const calendarController = {

  // POST /api/v1/calendar/generate
  async generate(request, reply) {
    const { niche, platform, followerRange, month, year } = request.body;
    const userId = request.user?.uid ?? 'anonymous';

    const cacheKey = `calendar:${userId}:${month}:${year}:${niche}:${platform}`;

    try {
      // 1. Check cache first (TTL: 1 hour — calendars don't change often)
      const cached = await getCache(cacheKey);
      if (cached) {
        request.log.info({ cacheKey }, 'Calendar cache hit');
        return reply.send({ success: true, data: cached, fromCache: true });
      }

      // 2. Generate with ARIA
      request.log.info({ niche, platform, month, year }, 'Generating calendar with ARIA');
      const calendar = await ariaService.generateCalendar({
        niche,
        platform,
        followerRange,
        month,
        year,
      });

      // 3. Cache the result (1 hour TTL)
      await setCache(cacheKey, calendar, 3600);

      // 4. Log the event (async — don't await)
      if (userId !== 'anonymous') {
        query(
          `INSERT INTO analytics (user_id, event, platform, niche, metadata, created_at)
           VALUES ($1, 'calendar_generated', $2, $3, $4, NOW())`,
          [userId, platform, niche, JSON.stringify({ month, year })]
        ).catch(err => request.log.error(err, 'Analytics insert failed'));
      }

      return reply.send({ success: true, data: calendar });

    } catch (err) {
      request.log.error(err, 'Calendar generation failed');

      // Return a friendly fallback
      const fallback = ariaService.generateCalendarFallback({ niche, platform, month, year });
      return reply.send({ success: true, data: fallback, isFallback: true });
    }
  },

  // GET /api/v1/calendar/saved
  async getSaved(request, reply) {
    const userId = request.user?.uid;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    try {
      const result = await query(
        `SELECT * FROM content_calendars
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 6`,
        [userId]
      );
      return reply.send({ success: true, data: result });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch saved calendars' });
    }
  },

  // POST /api/v1/calendar/save
  async save(request, reply) {
    const { month, year, calendarData } = request.body;
    const userId = request.user?.uid;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    try {
      await query(
        `INSERT INTO content_calendars (user_id, month, year, calendar_data, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, month, year)
         DO UPDATE SET calendar_data = EXCLUDED.calendar_data, created_at = NOW()`,
        [userId, month, year, JSON.stringify(calendarData)]
      );
      return reply.send({ success: true, message: 'Calendar saved' });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to save calendar' });
    }
  },
};

module.exports = calendarController;
