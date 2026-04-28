// src/workers/trend.worker.js
// ARIA Trend Worker — Real data pipeline
// Sources: Google Trends (pytrends) → YouTube Trending API → Reddit → Fallback
// Runs every 6 hours via BullMQ

'use strict';

const { Worker } = require('bullmq');
const axios = require('axios');
const { getWorkerRedisClient } = require('../config/redis');
const { getDB } = require('../config/database');
const { logger } = require('../utils/logger');
const { fetchGoogleTrends } = require('../services/googleTrends.service');
const { fetchYouTubeTrending } = require('../services/youtubeTrending.service');

// ─── Niche keyword auto-tagger ─────────────────────────────────────────────
const NICHE_KEYWORDS = {
  fashion:     ['fashion', 'outfit', 'ootd', 'style', 'clothing', 'wear', 'dress', 'nykaa', 'myntra'],
  fitness:     ['fitness', 'gym', 'workout', 'health', 'yoga', 'diet', 'weight', 'muscle'],
  food:        ['food', 'recipe', 'cooking', 'restaurant', 'biryani', 'chef', 'eat', 'zomato'],
  cricket:     ['cricket', 'ipl', 'bcci', 'virat', 'rohit', 'match', 'wicket'],
  bollywood:   ['bollywood', 'film', 'movie', 'actor', 'actress', 'song', 'trailer'],
  tech:        ['tech', 'ai', 'startup', 'app', 'phone', 'iphone', 'gadget', 'review'],
  finance:     ['finance', 'stock', 'market', 'investment', 'mutual', 'crypto', 'money', 'zerodha', 'groww'],
  travel:      ['travel', 'trip', 'tour', 'destination', 'hotel', 'flight', 'vacation'],
  education:   ['study', 'exam', 'upsc', 'jee', 'neet', 'college', 'learn', 'tutorial'],
  comedy:      ['funny', 'meme', 'joke', 'comedy', 'viral', 'laugh', 'roast'],
  hustle:      ['startup', 'business', 'entrepreneur', 'side hustle', 'shark tank', 'income'],
};

const FALLBACK_TRENDS = [
  { title: 'Instagram Reels Strategy 2025', search_volume: 450000, velocity: 92, niche_tags: ['general'] },
  { title: 'YouTube Shorts Growth India',   search_volume: 380000, velocity: 88, niche_tags: ['general', 'education'] },
  { title: 'IPL 2025 Content Ideas',        search_volume: 520000, velocity: 95, niche_tags: ['cricket', 'comedy'] },
  { title: 'AI Tools for Creators',         search_volume: 410000, velocity: 90, niche_tags: ['tech', 'education'] },
  { title: 'Faceless YouTube Channel',      search_volume: 350000, velocity: 85, niche_tags: ['hustle', 'general'] },
  { title: 'Myntra Summer Collection',      search_volume: 320000, velocity: 82, niche_tags: ['fashion'] },
  { title: 'Zerodha Options Trading',       search_volume: 290000, velocity: 80, niche_tags: ['finance'] },
  { title: 'Street Food Hyderabad',         search_volume: 280000, velocity: 78, niche_tags: ['food', 'travel'] },
];

const detectNiches = (text = '') => {
  const lower = text.toLowerCase();
  const niches = [];
  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) niches.push(niche);
  }
  return niches.length > 0 ? niches : ['general'];
};

// ─── Reddit India fallback ─────────────────────────────────────────────────
const fetchRedditTrends = async () => {
  try {
    await new Promise(r => setTimeout(r, 2000)); // Rate limit delay
    const response = await axios.get('https://www.reddit.com/r/india/hot.json?limit=10', {
      headers: { 'User-Agent': 'ARIA-TrendAI/1.0' },
      timeout: 10000,
    });
    const posts = response.data?.data?.children || [];
    const trends = posts
      .map((post, idx) => ({
        title:        post.data.title?.slice(0, 120) || '',
        search_volume: post.data.ups || 0,
        velocity:     Math.max(50, 90 - idx * 5),
        niche_tags:   detectNiches(post.data.title),
        source:       'reddit',
      }))
      .filter(t => t.title.length > 5);
    logger.info({ count: trends.length }, 'Reddit trends fetched');
    return trends.length > 0 ? trends : null;
  } catch (err) {
    logger.warn({ err: err.message }, 'Reddit fetch failed');
    return null;
  }
};

// ─── Main job processor ────────────────────────────────────────────────────
const processTrendJob = async (job) => {
  const sql = getDB();
  let allTrends = [];
  const sourceLog = [];

  try {
    logger.info({ jobId: job.id }, 'Trend refresh job started');

    // ── Source 1: Google Trends (pytrends) ──────────────────────────────
    const googleTrends = await fetchGoogleTrends();
    if (googleTrends && googleTrends.length > 0) {
      const mapped = googleTrends.map(t => ({
        title:        t.title,
        search_volume: t.search_volume || 0,
        velocity:     t.velocity || 75,
        niche_tags:   t.niche_tags || detectNiches(t.title),
        source:       'google',
        raw_data:     t,
      }));
      allTrends = allTrends.concat(mapped);
      sourceLog.push(`google:${mapped.length}`);
      logger.info({ count: mapped.length }, 'Google Trends added to pipeline');
    }

    // ── Source 2: YouTube Trending India ────────────────────────────────
    const youtubeTrends = await fetchYouTubeTrending();
    if (youtubeTrends && youtubeTrends.length > 0) {
      allTrends = allTrends.concat(youtubeTrends);
      sourceLog.push(`youtube:${youtubeTrends.length}`);
      logger.info({ count: youtubeTrends.length }, 'YouTube trending added to pipeline');
    }

    // ── Source 3: Reddit fallback (if needed) ───────────────────────────
    if (allTrends.length < 10) {
      const redditTrends = await fetchRedditTrends();
      if (redditTrends) {
        allTrends = allTrends.concat(redditTrends);
        sourceLog.push(`reddit:${redditTrends.length}`);
      }
    }

    // ── Source 4: Static fallback (last resort) ──────────────────────────
    if (allTrends.length === 0) {
      allTrends = FALLBACK_TRENDS.map(t => ({ ...t, source: 'fallback' }));
      sourceLog.push('fallback');
      logger.warn('All real sources failed — using static fallback trends');
    }

    // ── Deduplicate by title ──────────────────────────────────────────────
    const seen = new Set();
    allTrends = allTrends.filter(t => {
      const key = t.title.toLowerCase().slice(0, 40);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── Purge old entries ─────────────────────────────────────────────────
    await sql`
      DELETE FROM live_trends
      WHERE fetched_at < NOW() - INTERVAL '7 hours'
        AND source IN ('google', 'youtube', 'reddit', 'fallback')
    `;

    // ── Insert fresh trends ───────────────────────────────────────────────
    const insertPromises = allTrends.slice(0, 80).map((trend) => {
      const niches   = trend.niche_tags || detectNiches(trend.title);
      const velocity = trend.velocity   || 75;

      return sql`
        INSERT INTO live_trends (
          source, title, search_volume, velocity,
          niche_tags, platform_tags, raw_data,
          fetched_at, expires_at
        ) VALUES (
          ${trend.source},
          ${trend.title.slice(0, 200)},
          ${trend.search_volume || 0},
          ${velocity},
          ${niches},
          ${trend.platform_tags || { instagram: true, youtube: true }},
          ${JSON.stringify(trend.raw_data || {})},
          NOW(),
          NOW() + INTERVAL '7 hours'
        )
        ON CONFLICT DO NOTHING
      `;
    });

    await Promise.all(insertPromises);

    logger.info(
      { total: allTrends.length, sources: sourceLog.join(', '), jobId: job.id },
      'Trend refresh completed'
    );

    return { success: true, trendsInserted: allTrends.length, sources: sourceLog };

  } catch (err) {
    logger.error({ err, jobId: job.id }, 'Trend job failed');
    throw err;
  }
};

// ─── Worker startup ────────────────────────────────────────────────────────
const startTrendWorker = async () => {
  const TRENDS_ENABLED = process.env.TRENDS_ENABLED !== 'false';
  if (!TRENDS_ENABLED) {
    logger.info('Trend worker disabled via TRENDS_ENABLED=false');
    return null;
  }

  const worker = new Worker('trend-refresh', processTrendJob, {
    connection: getWorkerRedisClient(),
    concurrency: 1,
  });

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, result }, 'Trend refresh completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Trend refresh failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Trend worker error');
  });

  logger.info('Trend worker started — sources: Google Trends + YouTube + Reddit');
  return worker;
};

module.exports = { startTrendWorker, processTrendJob };
