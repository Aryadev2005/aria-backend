// src/scrapers/finnhub.service.ts
// Finnhub free tier: 60 req/min
// Used for finance/business/investing niche creators only
// Endpoints used: /news (market news), /news?category=general

import axios from 'axios';
import { logger } from '../utils/logger';

const API_KEY = process.env.FINNHUB_API_KEY;
const BASE    = 'https://finnhub.io/api/v1';

export interface FinnhubNewsItem {
  headline:  string;
  source:    string;
  url:       string;
  summary:   string;
  datetime:  number; // unix timestamp
  category:  string;
  sentiment: number | null; // -1 to 1 if available
}

export async function scrapeFinnhubMarketNews(): Promise<FinnhubNewsItem[]> {
  if (!API_KEY) {
    logger.warn('FINNHUB_API_KEY not set — skipping');
    return [];
  }

  const categories = ['general', 'forex', 'crypto', 'merger'];
  const allItems: FinnhubNewsItem[] = [];
  const seen = new Set<string>();

  for (const category of categories) {
    try {
      const resp = await axios.get(`${BASE}/news`, {
        timeout: 8_000,
        params: { category, token: API_KEY },
      });

      const items: any[] = Array.isArray(resp.data) ? resp.data : [];

      for (const item of items.slice(0, 15)) {
        const headline = (item.headline ?? '').trim();
        if (!headline || seen.has(headline)) continue;
        seen.add(headline);

        allItems.push({
          headline,
          source:    item.source   ?? 'unknown',
          url:       item.url      ?? '',
          summary:   item.summary  ?? '',
          datetime:  item.datetime ?? Math.floor(Date.now() / 1000),
          category,
          sentiment: item.sentiment ?? null,
        });
      }

      await new Promise(r => setTimeout(r, 300));

    } catch (err: any) {
      logger.warn({ category, err: err.message }, 'finnhub: market news failed');
    }
  }

  return allItems;
}
