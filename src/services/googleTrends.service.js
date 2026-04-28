// src/services/googleTrends.service.js
// Real Google Trends data via pytrends Python package
// No API key required — uses Google Trends public endpoint
// Called by trend.worker.js every 6 hours via BullMQ

'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const { logger } = require('../utils/logger');

const execFileAsync = promisify(execFile);

// India-specific niche keywords to fetch trends for
const INDIA_TREND_KEYWORDS = [
  // Creator niches
  'instagram reels',
  'youtube shorts india',
  'content creator india',
  // Fashion
  'myntra fashion',
  'nykaa beauty',
  // Finance
  'zerodha trading',
  'mutual funds india',
  // Food
  'street food india',
  'zomato food',
  // Fitness
  'gym workout india',
  'yoga india',
  // Tech
  'smartphone india',
  'ai tools india',
  // Entertainment
  'bollywood',
  'ipl cricket',
  // Business
  'startup india',
  'side hustle india',
];

/**
 * Fetch real Google Trends data for India via Python pytrends
 * Returns array of { title, search_volume, velocity, niche_tags }
 */
const fetchGoogleTrends = async () => {
  const scriptPath = path.join(__dirname, '../../scripts/fetch_google_trends.py');

  try {
    logger.info('Fetching real Google Trends via pytrends...');

    const { stdout, stderr } = await execFileAsync(
      'python3',
      [scriptPath],
      { timeout: 60000, maxBuffer: 5 * 1024 * 1024 }
    );

    if (stderr && !stdout) {
      logger.warn({ stderr }, 'pytrends script warning');
    }

    const data = JSON.parse(stdout);

    if (data.error) {
      logger.warn({ error: data.error }, 'pytrends returned error');
      return null;
    }

    logger.info({ count: data.trends?.length }, 'Google Trends fetched successfully');
    return data.trends || null;

  } catch (err) {
    logger.warn({ err: err.message }, 'Google Trends fetch failed — falling back to YouTube');
    return null;
  }
};

/**
 * Fetch trending searches in India (rising queries)
 * Returns top 20 daily trending searches
 */
const fetchTrendingSearches = async () => {
  const scriptPath = path.join(__dirname, '../../scripts/fetch_trending_searches.py');

  try {
    const { stdout } = await execFileAsync(
      'python3',
      [scriptPath],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
    );

    const data = JSON.parse(stdout);
    return data.trending || null;

  } catch (err) {
    logger.warn({ err: err.message }, 'Trending searches fetch failed');
    return null;
  }
};

module.exports = { fetchGoogleTrends, fetchTrendingSearches, INDIA_TREND_KEYWORDS };
