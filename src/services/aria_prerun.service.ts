// src/services/aria_prerun.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// ARIA Pre-Run Tool Executor
// Before ARIA responds, silently runs the most likely tools and injects
// VERIFIED LIVE DATA into the system prompt.
// If a tool returns empty, injects DATA UNAVAILABLE so ARIA never hallucinates.
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';
import type { ARIAIntent } from './aria_intent.service';

export interface PreRunData {
  block: string;      // text block injected into system prompt
  sources: string[];  // which sources returned real data
  empty: string[];    // which sources returned nothing (hallucination guards applied)
}

export async function preRunToolData(
  intent: ARIAIntent,
  userId: string,
  niche: string,
  platform: string,
): Promise<PreRunData> {
  const sources: string[] = [];
  const empty: string[] = [];
  const blocks: string[] = [];

  const shouldFetchTrends   = ['trend_request', 'hook_help', 'script_request'].includes(intent);
  const shouldFetchSongs    = intent === 'song_request';
  const shouldFetchAnalytics = ['analytics_question', 'posting_strategy', 'brand_collab'].includes(intent);

  await Promise.allSettled([
    // ── Live trends ───────────────────────────────────────────────────────────
    shouldFetchTrends ? (async () => {
      try {
        const cacheKey = `prerun:trends:${niche}:${platform}`;
        let trends: any[] | null = await cache.get(cacheKey) as any;

        if (!trends) {
          trends = await (prisma as any).live_trends.findMany({
            where: {
              niche: { contains: niche, mode: 'insensitive' },
              expires_at: { gt: new Date() },
            },
            orderBy: { velocity_score: 'desc' },
            take: 5,
            select: { title: true, source: true, velocity_score: true, growth_signal: true },
          });
          if (trends && trends.length > 0) await cache.set(cacheKey, trends, 300);
        }

        if (trends && trends.length > 0) {
          sources.push('live_trends');
          blocks.push(`══ VERIFIED LIVE TRENDS (fetched right now, use these — do not invent others) ══
${trends.map((t: any, i: number) => `${i + 1}. ${t.title} | Source: ${t.source} | Velocity: ${t.velocity_score ?? 'N/A'} | Signal: ${t.growth_signal ?? 'rising'}`).join('\n')}`);
        } else {
          empty.push('live_trends');
          blocks.push(`══ LIVE TRENDS: DATA UNAVAILABLE ══
The trend database returned no results for "${niche}" right now. DO NOT fabricate trend names, scores, or sources. Instead, ask the creator what topics they've been considering, or suggest general principles.`);
        }
      } catch (err) {
        logger.warn({ err, niche }, 'Pre-run trends fetch failed');
        empty.push('live_trends');
      }
    })() : Promise.resolve(),

    // ── Trending songs ────────────────────────────────────────────────────────
    shouldFetchSongs ? (async () => {
      try {
        const songs = await (prisma as any).live_songs.findMany({
          where: { expires_at: { gt: new Date() }, lifecycle: { in: ['RISING', 'Peak'] } },
          orderBy: { chart_position: 'asc' },
          take: 5,
          select: { title: true, artist: true, lifecycle: true, mood_tags: true, niche_tags: true },
        });

        if (songs && songs.length > 0) {
          sources.push('live_songs');
          blocks.push(`══ VERIFIED TRENDING SONGS (use these exact titles — do not invent songs) ══
${songs.map((s: any, i: number) => `${i + 1}. "${s.title}" by ${s.artist} | Stage: ${s.lifecycle} | Mood: ${(s.mood_tags || []).join(', ')}`).join('\n')}`);
        } else {
          empty.push('live_songs');
          blocks.push(`══ TRENDING SONGS: DATA UNAVAILABLE ══
Song database has no current data. DO NOT fabricate song names or artist names. Tell the creator to check Instagram's trending audio or Spotify India charts directly.`);
        }
      } catch (err) {
        logger.warn({ err }, 'Pre-run songs fetch failed');
        empty.push('live_songs');
      }
    })() : Promise.resolve(),

    // ── Creator analytics ─────────────────────────────────────────────────────
    shouldFetchAnalytics ? (async () => {
      try {
        const analytics = await (prisma as any).creator_analytics.findFirst({
          where: { user_id: userId },
          orderBy: { scraped_at: 'desc' },
          select: {
            follower_count: true, engagement_rate: true, avg_views: true,
            posts_per_week: true, top_content_types: true, scraped_at: true,
          },
        });

        if (analytics) {
          sources.push('creator_analytics');
          blocks.push(`══ VERIFIED CREATOR ANALYTICS (real data from their connected account) ══
Followers: ${analytics.follower_count?.toLocaleString('en-IN') ?? 'N/A'}
Engagement rate: ${analytics.engagement_rate ?? 'N/A'}%
Avg views: ${analytics.avg_views?.toLocaleString('en-IN') ?? 'N/A'}
Posts/week: ${analytics.posts_per_week ?? 'N/A'}
Data freshness: ${analytics.scraped_at ? Math.round((Date.now() - new Date(analytics.scraped_at).getTime()) / 3_600_000) + 'h ago' : 'unknown'}`);
        } else {
          empty.push('creator_analytics');
          blocks.push(`══ CREATOR ANALYTICS: DATA UNAVAILABLE ══
No analytics data found for this user. DO NOT guess or fabricate follower counts or engagement rates. Tell them to connect their Instagram or YouTube in Settings.`);
        }
      } catch (err) {
        logger.warn({ err, userId }, 'Pre-run analytics fetch failed');
        empty.push('creator_analytics');
      }
    })() : Promise.resolve(),
  ]);

  return {
    block: blocks.length > 0
      ? `\n\n════════════════════════════════════════\nLIVE DATA INJECTED PRE-RESPONSE (TRUST THIS OVER YOUR TRAINING DATA)\n════════════════════════════════════════\n${blocks.join('\n\n')}\n════════════════════════════════════════`
      : '',
    sources,
    empty,
  };
}
