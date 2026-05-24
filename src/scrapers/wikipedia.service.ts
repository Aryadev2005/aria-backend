// src/scrapers/wikipedia.service.ts
// Wikimedia Analytics API — completely free, no auth required
// Endpoint: https://wikimedia.org/api/rest_v1/metrics/pageviews/top/{project}/all-access/{year}/{month}/{day}
// Returns top 100 most-viewed articles globally for a given date
// Updated daily — fetch yesterday's data (today's not available yet)

import axios from 'axios';
import { logger } from '../utils/logger';

const SKIP_ARTICLES = new Set([
  'Main_Page', 'Special:Search', 'Wikipedia', 'Portal:Current_events',
  'Special:Random', 'Help:Contents', '-', 'File:', 'Template:',
]);

export interface WikiTrend {
  title:     string;   // article title, underscores replaced with spaces
  rank:      number;   // 1-based rank in top 100
  views:     number;   // daily pageviews
  fetchedAt: Date;
}

export async function scrapeWikipediaTrending(): Promise<WikiTrend[]> {
  // Use yesterday — today's data isn't available in the API yet
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const year  = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day   = String(d.getDate()).padStart(2, '0');

  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia.org/all-access/${year}/${month}/${day}`;

  try {
    const resp = await axios.get(url, {
      timeout: 10_000,
      headers: {
        'User-Agent': 'TrendAI/2.0 (contact: your-email@domain.com)',
        'Accept': 'application/json',
      },
    });

    const articles: any[] = resp.data?.items?.[0]?.articles ?? [];
    const now = new Date();

    return articles
      .filter(a => {
        const title: string = a.article ?? '';
        if (!title || title.length < 3) return false;
        if (SKIP_ARTICLES.has(title)) return false;
        if (title.startsWith('Special:') || title.startsWith('Wikipedia:') ||
            title.startsWith('Help:') || title.startsWith('File:') ||
            title.startsWith('Template:') || title.startsWith('Portal:')) return false;
        return true;
      })
      .slice(0, 50)
      .map((a, i): WikiTrend => ({
        title:     (a.article ?? '').replace(/_/g, ' '),
        rank:      i + 1,
        views:     a.views ?? 0,
        fetchedAt: now,
      }));

  } catch (err: any) {
    logger.warn({ err: err.message }, 'wikipedia: scrape failed');
    return [];
  }
}
