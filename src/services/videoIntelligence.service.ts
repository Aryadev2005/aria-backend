import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../utils/logger';
import { cache } from '../config/redis';
import { prisma } from '../config/database';
import type { User } from '../types';
import type { MetadataStream, VideoIntelligenceReport } from '../types/videoIntelligence.types';

import { fetchHeatmap } from './heatmap.service';
import { processAuralStream, processVisualStream } from './tripleStream.service';
import {
  runHookAnalyst,
  runRetentionArchitect,
  runSeoViralStrategist,
  runSemanticRouter,
} from './contentCouncil.service';

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator: runs all 4 agents in the most efficient order possible.
// - Heatmap fetch + Aural + Visual run in parallel (I/O bound)
// - 4 agents run in parallel (AI calls — independent of each other)
// ─────────────────────────────────────────────────────────────────────────────

export interface IntelligenceOptions {
  videoPath?: string;     // local file path if uploaded
  metadata: MetadataStream;
  user: Partial<User>;
}

export const runVideoIntelligence = async ({
  videoPath,
  metadata,
  user,
}: IntelligenceOptions): Promise<VideoIntelligenceReport> => {
  const startTime = Date.now();

  const niche     = (Array.isArray(user.niches) ? user.niches[0] : user.niches) ?? 'general';
  const archetype = user.archetype ?? 'CREATOR';
  const platform  = user.primary_platform ?? 'youtube';

  logger.info({ videoId: metadata.videoId, userId: user.id, hasFile: !!videoPath }, 'Video Intelligence started');

  // ── Phase 1: Parallel I/O ──────────────────────────────────────────────────
  let outputDir: string | null = null;
  if (videoPath) {
    outputDir = path.join(os.tmpdir(), `aria_vi_${user.id}_${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const [heatmap, auralStream, visualStream] = await Promise.allSettled([
    fetchHeatmap(metadata.videoId, metadata.duration),
    videoPath && outputDir
      ? processAuralStream(videoPath, outputDir, metadata.duration)
      : Promise.resolve(null),
    videoPath && outputDir
      ? processVisualStream(videoPath, outputDir, metadata.duration)
      : Promise.resolve(null),
  ]);

  const heatmapData    = heatmap.status    === 'fulfilled' ? heatmap.value    : { videoId: metadata.videoId, points: [], avgIntensity: 50, dropOffTimestamps: [], rewatchTimestamps: [], peakMoment: 0, scrapedAt: new Date().toISOString() };
  const auralData      = auralStream.status === 'fulfilled' ? auralStream.value   : null;
  const visualData     = visualStream.status === 'fulfilled' ? visualStream.value : null;

  // ── Phase 2: Parallel Agent Execution ─────────────────────────────────────
  const [hookResult, retentionResult, seoResult, valueResult] = await Promise.allSettled([
    runHookAnalyst(metadata, auralData, visualData, niche),
    runRetentionArchitect(metadata, auralData, visualData, heatmapData, archetype),
    runSeoViralStrategist(metadata, auralData, visualData, heatmapData, niche),
    runSemanticRouter(metadata, auralData, niche),
  ]);

  const hookAnalysis      = hookResult.status      === 'fulfilled' ? hookResult.value      : fallbackHook();
  const retentionAnalysis = retentionResult.status === 'fulfilled' ? retentionResult.value : fallbackRetention();
  const seoAnalysis       = seoResult.status       === 'fulfilled' ? seoResult.value       : fallbackSeo();
  const valueAnalysis     = valueResult.status     === 'fulfilled' ? valueResult.value     : fallbackValue();

  // ── Phase 3: Cleanup temp files ───────────────────────────────────────────
  if (outputDir) {
    fs.rm(outputDir, { recursive: true, force: true }, () => {});
  }

  // ── Phase 4: Compute overall score ────────────────────────────────────────
  const overallScore = computeOverallScore({
    hookScore:          hookAnalysis.hookScore,
    retentionScore:     retentionAnalysis.retentionScore,
    seoScore:           seoAnalysis.seoScore,
    valueDensityScore:  valueAnalysis.valueDensityScore,
    engagementRate:     metadata.engagementRate,
  });

  const processingMs = Date.now() - startTime;

  const report: VideoIntelligenceReport = {
    // Metadata passthrough
    videoId:        metadata.videoId,
    videoTitle:     metadata.title,
    channelName:    metadata.channelName,
    publishedAt:    metadata.publishedAt,
    duration:       formatDuration(metadata.duration),
    thumbnailUrl:   metadata.thumbnailUrl,
    viewCount:      formatCount(metadata.viewCount),
    likeCount:      formatCount(metadata.likeCount),
    commentCount:   formatCount(metadata.commentCount),
    engagementRate: metadata.engagementRate,

    // Scores
    overallScore,
    scoreVerdict: computeVerdict(overallScore),

    // Agent outputs
    hookAnalysis,
    retentionAnalysis,
    seoViralAnalysis: seoAnalysis,
    valueDensityAnalysis: valueAnalysis,

    // Shorts
    shortsOpportunities: seoAnalysis.shortsTimestamps,

    // Stream summaries
    auralSummary: {
      speakerCount:  auralData?.speakerCount  ?? 0,
      wordCount:     auralData?.wordCount     ?? 0,
      keyPhrases:    auralData?.keyPhrases    ?? [],
      sentimentArc:  computeSentimentArc(auralData),
    },
    visualSummary: {
      talkingHeadPercent: visualData?.talkingHeadPercent ?? 0,
      brollPercent:       visualData?.brollPercent       ?? 0,
      avgCutFrequency:    visualData?.avgCutFrequency    ?? 0,
      highEnergyMoments:  visualData?.highEnergyMoments  ?? [],
    },

    // Meta
    analysisType:  videoPath ? 'deep_multimodal' : 'metadata_only',
    hasHeatmap:    heatmapData.points.length > 0,
    processingMs,
  };

  logger.info({ videoId: metadata.videoId, overallScore, processingMs }, 'Video Intelligence complete');
  return report;
};

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────
const computeOverallScore = (scores: {
  hookScore: number;
  retentionScore: number;
  seoScore: number;
  valueDensityScore: number;
  engagementRate: number;
}): number => {
  // Weighted: Hook 30% | Retention 30% | SEO 20% | Value 20%
  const engBonus = Math.min(10, scores.engagementRate * 2);
  const raw = (
    scores.hookScore * 0.30 +
    scores.retentionScore * 0.30 +
    scores.seoScore * 0.20 +
    scores.valueDensityScore * 0.20
  ) + engBonus;
  return Math.min(100, Math.round(raw));
};

const computeVerdict = (score: number): string => {
  if (score >= 85) return 'Viral Potential';
  if (score >= 70) return 'Strong Performer';
  if (score >= 55) return 'Good Start';
  if (score >= 40) return 'Needs Work';
  return 'Major Overhaul Needed';
};

const computeSentimentArc = (aural: AuralStream | null): string => {
  if (!aural || aural.sentimentFlux.length === 0) return 'Unknown';
  const first = aural.sentimentFlux.slice(0, 3).map(s => s.sentiment);
  const last = aural.sentimentFlux.slice(-3).map(s => s.sentiment);
  const startMood = first.includes('positive') ? 'positive' : first.includes('negative') ? 'negative' : 'neutral';
  const endMood = last.includes('positive') ? 'positive' : last.includes('negative') ? 'negative' : 'neutral';
  return `${startMood} → ${endMood}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Fallbacks (agents are never allowed to crash the response)
// ─────────────────────────────────────────────────────────────────────────────
const fallbackHook = (): HookAnalysis => ({
  hookScore: 50,
  thumbnailTitleAlignment: 50,
  firstFrameStrength: 'Analysis unavailable',
  firstThirtySeconds: 'Analysis unavailable',
  ariaVerdict: 'Hook analysis failed. Upload the video file for deeper analysis.',
  improvements: [],
});

const fallbackRetention = (): RetentionAnalysis => ({
  retentionScore: 50,
  dropOffEvents: [],
  rewatchEvents: [],
  pacingVerdict: 'Retention analysis unavailable.',
  talkingHeadWarning: false,
});

const fallbackSeo = (): SeoViralAnalysis => ({
  seoScore: 50,
  keywordDensity: {},
  missingKeywords: [],
  titleOptimization: '',
  descriptionOptimization: '',
  tagSuggestions: [],
  shortsTimestamps: [],
});

const fallbackValue = (): ValueDensityAnalysis => ({
  valueDensityScore: 50,
  fluffTimestamps: [],
  cheatSheet: [],
  contentSummary: 'Value analysis unavailable.',
  uniqueInsights: [],
  actionableCount: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────────────────────
const formatCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const formatDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

// Import types needed for fallback functions
import type { AuralStream, HookAnalysis, RetentionAnalysis, SeoViralAnalysis, ValueDensityAnalysis } from '../types/videoIntelligence.types';
