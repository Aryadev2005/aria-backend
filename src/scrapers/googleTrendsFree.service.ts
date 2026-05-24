// src/scrapers/googleTrendsFree.service.ts
// Native Google Trends scraper — zero API key, zero Apify
// Uses two undocumented but stable public endpoints:
//   1. dailytrends — top 20 searches for a country today
//   2. realtimetrends — live trending news stories globally

import axios from 'axios';
import { logger } from '../utils/logger';
import type { GeoTarget } from '../config/geo.config';

const JITTER = (min = 800, max = 2500) =>
  new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));

// ── Types ──────────────────────────────────────────────────────────────────

export interface DailyTrend {
  query:          string;
  trafficRaw:     string;   // e.g. "200K+"
  trafficNum:     number;   // parsed approximation
  geo:            string;   // ISO country code
  geoName:        string;
  relatedQueries: string[];
  articles:       { title: string; source: string; url: string }[];
  fetchedAt:      Date;
}

export interface RealtimeTrend {
  title:      string;
  entityNames: string[];
  articles:   { title: string; source: string; url: string }[];
  fetchedAt:  Date;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseTraffic(raw: string): number {
  if (!raw) return 0;
  const clean = raw.replace(/[^0-9KkMm+]/g, '');
  if (clean.includes('M') || clean.includes('m')) return parseFloat(clean) * 1_000_000;
  if (clean.includes('K') || clean.includes('k')) return parseFloat(clean) * 1_000;
  return parseInt(clean) || 0;
}

function stripPrefix(text: string): string {
  // Google prepends ")]}',\n" to all trend API responses
  return text.replace(/^\)]\}',?\n?/, '').trim();
}

// ── dailytrends endpoint ───────────────────────────────────────────────────

export async function scrapeDailyTrends(geo: GeoTarget): Promise<DailyTrend[]> {
  const url = `https://trends.google.com/trends/api/dailytrends` +
    `?hl=${geo.hl}&tz=${geo.tz}&geo=${geo.code}&ns=15`;

  try {
    const resp = await axios.get(url, {
      timeout: 15_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TrendAI/2.0)',
        'Accept-Language': geo.hl,
        'Accept': 'application/json, text/plain, */*',
      },
    });

    const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    const json = JSON.parse(stripPrefix(raw));
    const days: any[] = json?.default?.trendingSearchesDays ?? [];
    if (!days.length) return [];

    const searches: any[] = days[0]?.trendingSearches ?? [];
    const now = new Date();

    return searches.map((s: any): DailyTrend => {
      const relatedQueries = (s.relatedQueries ?? []).map((q: any) => q.query?.query ?? q.query ?? '').filter(Boolean);
      const articles = (s.articles ?? []).slice(0, 3).map((a: any) => ({
        title:  a.title  ?? '',
        source: a.source ?? '',
        url:    a.url    ?? '',
      }));
      const trafficRaw = s.formattedTraffic ?? '0';

      return {
        query:          s.title?.query ?? '',
        trafficRaw,
        trafficNum:     parseTraffic(trafficRaw),
        geo:            geo.code,
        geoName:        geo.name,
        relatedQueries: relatedQueries.slice(0, 5),
        articles,
        fetchedAt:      now,
      };
    }).filter(t => t.query.length > 0);

  } catch (err: any) {
    logger.warn({ geo: geo.code, err: err.message }, 'googleTrendsFree: dailytrends failed');
    return [];
  }
}

// ── realtimetrends endpoint ────────────────────────────────────────────────
// Global only — returns trending news stories with entity extraction

export async function scrapeRealtimeTrends(): Promise<RealtimeTrend[]> {
  const url = `https://trends.google.com/trends/api/realtimetrends` +
    `?hl=en-US&tz=0&cat=all&fi=0&fs=0&geo=US&ri=300&rs=20&sort=0`;

  try {
    const resp = await axios.get(url, {
      timeout: 15_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TrendAI/2.0)',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    const raw = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    const json = JSON.parse(stripPrefix(raw));
    const stories: any[] = json?.storySummaries?.trendingStories ?? [];
    const now = new Date();

    return stories.map((s: any): RealtimeTrend => {
      const entityNames = (s.entityNames ?? []).slice(0, 5);
      const articles = (s.articles ?? []).slice(0, 3).map((a: any) => ({
        title:  a.articleTitle ?? '',
        source: a.source       ?? '',
        url:    a.url          ?? '',
      }));
      const title = s.title ?? entityNames[0] ?? '';

      return { title, entityNames, articles, fetchedAt: now };
    }).filter(t => t.title.length > 0);

  } catch (err: any) {
    logger.warn({ err: err.message }, 'googleTrendsFree: realtimeTrends failed');
    return [];
  }
}

// ── Batch scrape multiple geos with jitter ────────────────────────────────

export async function scrapeAllGeos(geos: GeoTarget[]): Promise<{
  trends: DailyTrend[];
  realtime: RealtimeTrend[];
}> {
  const allTrends: DailyTrend[] = [];

  for (const geo of geos) {
    const results = await scrapeDailyTrends(geo);
    allTrends.push(...results);
    await JITTER(600, 1800); // polite delay between countries
  }

  const realtime = await scrapeRealtimeTrends();

  return { trends: allTrends, realtime };
}
