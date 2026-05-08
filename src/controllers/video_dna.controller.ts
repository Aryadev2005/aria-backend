import { FastifyRequest, FastifyReply } from 'fastify';
import axios from 'axios';
import OpenAI from 'openai';
import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { success, errors } from '../utils/response';
import { logger } from '../utils/logger';
import { User } from '../types';
import type { MetadataStream } from '../types/videoIntelligence.types';
import { runVideoIntelligence } from '../services/videoIntelligence.service';
import { runCompetitorGapAnalysis } from '../services/competitorGap.service';

const YT_KEY  = process.env.YOUTUBE_API_KEY;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────
const formatCount = (n: string | number): string => {
  const num = typeof n === 'string' ? parseInt(n, 10) : n;
  if (isNaN(num)) return '0';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000)     return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
};

const formatDuration = (iso: string): string => {
  const match = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '—';
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0');
  const s = parseInt(match[3] || '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const formatDate = (iso: string): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const parseDurationToSeconds = (iso: string): number => {
  const match = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return parseInt(match[1] || '0') * 3600 + parseInt(match[2] || '0') * 60 + parseInt(match[3] || '0');
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Fetch YouTube metadata
// ─────────────────────────────────────────────────────────────────────────────
const fetchYouTubeMetadata = async (videoId: string): Promise<MetadataStream> => {
  const cacheKey = `yt_meta_v2:${videoId}`;
  const cached = await cache.get(cacheKey).catch(() => null);
  if (cached) return cached as MetadataStream;

  const response = await axios.get(`${YT_BASE}/videos`, {
    params: { key: YT_KEY, id: videoId, part: 'snippet,statistics,contentDetails' },
    timeout: 10_000,
  });

  const items = response.data?.items;
  if (!items?.length) throw new Error('Video not found or is private');

  const v       = items[0];
  const snippet = v.snippet;
  const stats   = v.statistics;
  const content = v.contentDetails;

  const views    = parseInt(stats.viewCount   ?? '0');
  const likes    = parseInt(stats.likeCount   ?? '0');
  const comments = parseInt(stats.commentCount ?? '0');

  const metadata: MetadataStream = {
    videoId,
    title:          snippet.title,
    description:    (snippet.description ?? '').slice(0, 500),
    tags:           (snippet.tags ?? []).slice(0, 20),
    publishedAt:    formatDate(snippet.publishedAt),
    duration:       parseDurationToSeconds(content.duration),
    viewCount:      views,
    likeCount:      likes,
    commentCount:   comments,
    engagementRate: views > 0 ? parseFloat(((likes + comments) / views * 100).toFixed(2)) : 0,
    thumbnailUrl:   snippet.thumbnails?.high?.url ?? snippet.thumbnails?.medium?.url ?? '',
    channelId:      snippet.channelId,
    channelName:    snippet.channelTitle,
    categoryId:     snippet.categoryId ?? '22',
  };

  await cache.set(cacheKey, metadata, 7200);
  return metadata;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/video-dna/analyse
// ─────────────────────────────────────────────────────────────────────────────
export const analyseVideo = async (req: FastifyRequest, reply: FastifyReply) => {
  const user    = req.user as User;
  const { videoId } = req.body as { videoId: string };

  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return errors.validation(reply, 'Invalid YouTube video ID');
  }

  const userId = user.id;

  logger.info({ videoId, userId }, 'Video DNA analysis started');

  // Fetch full user profile for personalised analysis
  const fullUser = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      id: true, archetype: true, niches: true,
      primary_platform: true, follower_range: true, engagement_rate: true,
    },
  });

  // Fetch YouTube metadata
  let metadata: MetadataStream;
  try {
    metadata = await fetchYouTubeMetadata(videoId);
  } catch (ytErr: any) {
    logger.warn({ ytErr: ytErr.message, videoId }, 'YouTube API failed');
    if (ytErr.message.includes('not found') || ytErr.message.includes('private')) {
      return errors.notFound(reply, 'Video');
    }
    return errors.serviceDown(reply, 'YouTube API');
  }

  // Run full intelligence pipeline
  let report;
  try {
    report = await runVideoIntelligence({
      metadata,
      user: fullUser ?? { id: userId },
    });
  } catch (err: any) {
    logger.error({ err: err.message, videoId }, 'Video Intelligence pipeline failed');
    return errors.serviceDown(reply, 'ARIA Intelligence Engine');
  }

  // Persist (fire-and-forget)
  (prisma as any).video_dna_analyses.upsert({
    where:  { user_id_video_id: { user_id: userId, video_id: videoId } },
    update: {
      result_data:       report,
      heatmap_data:      { hasHeatmap: report.hasHeatmap },
      analysis_version:  'v2',
      processing_ms:     report.processingMs,
      analysed_at:       new Date(),
    },
    create: {
      user_id:           userId,
      video_id:          videoId,
      video_title:       metadata.title,
      channel_name:      metadata.channelName,
      result_data:       report,
      heatmap_data:      { hasHeatmap: report.hasHeatmap },
      analysis_version:  'v2',
      processing_ms:     report.processingMs,
      analysed_at:       new Date(),
    },
  }).catch((e: any) => logger.warn({ e }, 'Video DNA persist failed'));

  return success(reply, report);
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/video-dna/history
// ─────────────────────────────────────────────────────────────────────────────
export const getHistory = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    const rows = await (prisma as any).video_dna_analyses.findMany({
      where:   { user_id: user.id },
      orderBy: { analysed_at: 'desc' },
      take:    20,
      select: {
        video_id:       true,
        video_title:    true,
        channel_name:   true,
        result_data:    true,
        analysed_at:    true,
        analysis_version: true,
      },
    });

    return success(reply, rows.map((r: any) => ({
      videoId:         r.video_id,
      videoTitle:      r.video_title,
      channelName:     r.channel_name,
      score:           r.result_data?.overallScore,
      verdict:         r.result_data?.scoreVerdict,
      thumbnailUrl:    r.result_data?.thumbnailUrl,
      analysedAt:      r.analysed_at,
      analysisVersion: r.analysis_version,
    })));
  } catch (err) {
    logger.error({ err }, 'Video DNA history failed');
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/video-dna/competitor-gap
// ─────────────────────────────────────────────────────────────────────────────
export const getCompetitorGap = async (req: FastifyRequest, reply: FastifyReply) => {
  const user        = req.user as User;
  const { niche }   = req.body as { niche: string };

  if (!niche?.trim()) return errors.validation(reply, 'niche is required');

  try {
    const report = await runCompetitorGapAnalysis(niche, user.id);
    return success(reply, report);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Competitor gap analysis failed');
    return errors.serviceDown(reply, 'Competitor Gap Analysis');
  }
};
