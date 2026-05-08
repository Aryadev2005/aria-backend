import axios from 'axios';
import * as cheerio from 'cheerio';
import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';
import type { HeatmapData, HeatmapPoint } from '../types/videoIntelligence.types';

// ─────────────────────────────────────────────────────────────────────────────
// YouTube Replay Heatmap Scraper
// YouTube embeds heatmap data as a JSON blob inside the page's ytInitialData.
// We scrape the watch page HTML and extract the "heatMarkers" array.
// ─────────────────────────────────────────────────────────────────────────────

const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/**
 * Extracts heatmap data from YouTube watch page HTML.
 * YouTube encodes "heatMarkers" inside ytInitialData as a JSON blob.
 */
const extractHeatmapFromHtml = (html: string, videoId: string, duration: number): HeatmapData | null => {
  try {
    // Extract ytInitialData JSON blob
    const match = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s)
      || html.match(/ytInitialData\s*=\s*(\{.+?\});/s);

    if (!match) {
      logger.warn({ videoId }, 'ytInitialData not found in YouTube page');
      return null;
    }

    const ytData = JSON.parse(match[1]);

    // Navigate the nested structure to find heatMarkers
    // Path: playerOverlays > playerOverlayRenderer > decoratedPlayerBarRenderer > 
    //       playerBarRenderer > timedMarkerDecorations > heatMarkers
    let heatMarkers: any[] = [];

    const findHeatMarkers = (obj: any, depth = 0): boolean => {
      if (depth > 20 || !obj || typeof obj !== 'object') return false;
      if (Array.isArray(obj)) {
        return obj.some(item => findHeatMarkers(item, depth + 1));
      }
      if (obj.heatMarkers && Array.isArray(obj.heatMarkers)) {
        heatMarkers = obj.heatMarkers;
        return true;
      }
      return Object.values(obj).some(v => findHeatMarkers(v, depth + 1));
    };

    findHeatMarkers(ytData);

    if (heatMarkers.length === 0) {
      logger.info({ videoId }, 'No heatmap markers found (video may not have enough views)');
      return buildEmptyHeatmap(videoId, duration);
    }

    // Parse markers into our format
    const points: HeatmapPoint[] = heatMarkers.map((marker: any) => {
      const raw = marker.heatMarkerRenderer || marker;
      const timeRange = raw.timeRangeStartMillis ?? 0;
      const intensity = Math.round((raw.markerDurationMillis ?? 0) > 0
        ? Math.min(100, (raw.heatMarkerIntensityScoreNormalized ?? 0) * 100)
        : 0);

      return {
        timestamp: Math.round(timeRange / 1000),
        intensity,
        isDropOff: intensity < 30,
        isRewatch: intensity > 80,
      };
    }).sort((a, b) => a.timestamp - b.timestamp);

    const avgIntensity = points.length > 0
      ? Math.round(points.reduce((s, p) => s + p.intensity, 0) / points.length)
      : 50;

    const peakPoint = points.reduce((best, p) => p.intensity > best.intensity ? p : best, points[0] ?? { timestamp: 0, intensity: 0 });

    return {
      videoId,
      points,
      avgIntensity,
      dropOffTimestamps: points.filter(p => p.isDropOff).map(p => p.timestamp),
      rewatchTimestamps: points.filter(p => p.isRewatch).map(p => p.timestamp),
      peakMoment: peakPoint.timestamp,
      scrapedAt: new Date().toISOString(),
    };

  } catch (err) {
    logger.warn({ err, videoId }, 'Heatmap extraction failed — using empty heatmap');
    return buildEmptyHeatmap(videoId, duration);
  }
};

const buildEmptyHeatmap = (videoId: string, duration: number): HeatmapData => ({
  videoId,
  points: [],
  avgIntensity: 50,
  dropOffTimestamps: [],
  rewatchTimestamps: [],
  peakMoment: Math.round(duration * 0.3), // assume 30% mark
  scrapedAt: new Date().toISOString(),
});

/**
 * Fetch and cache YouTube heatmap for a video.
 * Cache TTL: 6 hours (heatmaps don't change rapidly)
 */
export const fetchHeatmap = async (videoId: string, durationSeconds: number): Promise<HeatmapData> => {
  const cacheKey = `heatmap:${videoId}`;

  // 1. Redis cache
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return cached as HeatmapData;
  } catch (_) {}

  // 2. Postgres cache
  try {
    const dbRow = await (prisma as any).video_heatmaps.findUnique({
      where: { video_id: videoId },
    });
    if (dbRow && new Date(dbRow.expires_at) > new Date()) {
      const data = dbRow.heatmap_data as HeatmapData;
      await cache.set(cacheKey, data, 3600);
      return data;
    }
  } catch (_) {}

  // 3. Scrape YouTube
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await axios.get(url, {
      headers: SCRAPE_HEADERS,
      timeout: 15000,
    });

    const heatmapData = extractHeatmapFromHtml(response.data, videoId, durationSeconds);
    const result = heatmapData ?? buildEmptyHeatmap(videoId, durationSeconds);

    // Store in Postgres
    await (prisma as any).video_heatmaps.upsert({
      where: { video_id: videoId },
      update: { heatmap_data: result as any, scraped_at: new Date(), expires_at: new Date(Date.now() + 6 * 3600_000) },
      create: { video_id: videoId, heatmap_data: result as any, scraped_at: new Date(), expires_at: new Date(Date.now() + 6 * 3600_000) },
    }).catch((e: any) => logger.warn({ e }, 'Heatmap DB save failed'));

    await cache.set(cacheKey, result, 3600);
    return result;

  } catch (err: any) {
    logger.warn({ err: err.message, videoId }, 'Heatmap scrape failed — using empty');
    return buildEmptyHeatmap(videoId, durationSeconds);
  }
};
