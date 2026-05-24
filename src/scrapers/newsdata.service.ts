// src/scrapers/newsdata.service.ts
// NewsData.io — free tier: 200 credits/day = 2,000 articles
// We use ~30 credits per full run (6 categories × 5 pages max)
// Endpoint: https://newsdata.io/api/1/latest

import axios from 'axios';
import { logger } from '../utils/logger';
import { deriveNicheTags } from '../utils/nicheTagger';

const API_KEY = process.env.NEWSDATA_API_KEY;
const BASE    = 'https://newsdata.io/api/1/latest';

// Map NewsData categories to creator niches
const CATEGORY_NICHE_MAP: Record<string, string[]> = {
  entertainment: ['entertainment', 'music', 'fashion', 'beauty'],
  technology:    ['tech', 'gaming'],
  health:        ['fitness', 'health', 'beauty'],
  sports:        ['sports', 'fitness'],
  business:      ['finance'],
  lifestyle:     ['lifestyle', 'travel', 'food', 'parenting'],
  science:       ['education', 'tech'],
  food:          ['food'],
  tourism:       ['travel'],
  education:     ['education'],
};

export interface NewsItem {
  title:      string;
  source:     string;
  url:        string;
  category:   string;
  language:   string;
  country:    string[];
  publishedAt: string;
  nicheTags:  string[];
}

export async function scrapeNewsData(categories = Object.keys(CATEGORY_NICHE_MAP)): Promise<NewsItem[]> {
  if (!API_KEY) {
    logger.warn('NEWSDATA_API_KEY not set — skipping');
    return [];
  }

  const allItems: NewsItem[] = [];
  const seen = new Set<string>();

  for (const category of categories) {
    try {
      const resp = await axios.get(BASE, {
        timeout: 10_000,
        params: {
          apikey:   API_KEY,
          category: category,
          language: 'en',
          size:     10,
        },
      });

      const results: any[] = resp.data?.results ?? [];
      const nicheTags = CATEGORY_NICHE_MAP[category] ?? ['general'];

      for (const item of results) {
        const title = (item.title ?? '').trim();
        if (!title || seen.has(title)) continue;
        seen.add(title);

        allItems.push({
          title,
          source:      item.source_id ?? item.source_name ?? 'unknown',
          url:         item.link ?? '',
          category,
          language:    item.language ?? 'en',
          country:     Array.isArray(item.country) ? item.country : [item.country ?? 'unknown'],
          publishedAt: item.pubDate ?? new Date().toISOString(),
          nicheTags,
        });
      }

      // Polite delay between categories
      await new Promise(r => setTimeout(r, 500));

    } catch (err: any) {
      logger.warn({ category, err: err.message }, 'newsdata: category fetch failed');
    }
  }

  return allItems;
}
