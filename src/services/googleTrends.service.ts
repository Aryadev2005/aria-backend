import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

// India-specific niche keywords to fetch trends for
export const INDIA_TREND_KEYWORDS = [
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

export interface GoogleTrend {
  title: string;
  search_volume: number;
  velocity: number;
  niche_tags: string[];
  platform_tags?: string[];
  raw_data?: any;
}

/**
 * Fetch real Google Trends data for India via Python pytrends
 * Returns array of { title, search_volume, velocity, niche_tags }
 */
export const fetchGoogleTrends = async (): Promise<GoogleTrend[] | null> => {
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

  } catch (err: any) {
    logger.warn({ err: err.message }, 'Google Trends fetch failed — falling back to YouTube');
    return null;
  }
};

/**
 * Fetch trending searches in India (rising queries)
 * Returns top 20 daily trending searches
 */
export const fetchTrendingSearches = async (): Promise<any[] | null> => {
  const scriptPath = path.join(__dirname, '../../scripts/fetch_trending_searches.py');

  try {
    const { stdout } = await execFileAsync(
      'python3',
      [scriptPath],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
    );

    const data = JSON.parse(stdout);
    return data.trending || null;

  } catch (err: any) {
    logger.warn({ err: err.message }, 'Trending searches fetch failed');
    return null;
  }
};
