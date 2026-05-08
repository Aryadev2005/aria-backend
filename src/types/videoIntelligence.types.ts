// ── Video Intelligence Engine — Shared Types ──────────────────────────────────

export interface HeatmapPoint {
  timestamp: number;      // seconds
  intensity: number;      // 0–100 (replay intensity)
  isDropOff: boolean;
  isRewatch: boolean;
}

export interface HeatmapData {
  videoId: string;
  points: HeatmapPoint[];
  avgIntensity: number;
  dropOffTimestamps: number[];
  rewatchTimestamps: number[];
  peakMoment: number;     // timestamp with highest intensity
  scrapedAt: string;
}

// ── Aural Stream (Whisper) ─────────────────────────────────────────────────────
export interface SpeakerSegment {
  speaker: string;        // "SPEAKER_00", "SPEAKER_01"
  start: number;
  end: number;
  text: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  sentimentScore: number; // -1 to +1
}

export interface AuralStream {
  fullTranscript: string;
  segments: SpeakerSegment[];
  speakerCount: number;
  sentimentFlux: Array<{ timestamp: number; sentiment: string; score: number }>;
  keyPhrases: string[];
  wordCount: number;
  wordsPerMinute: number;
}

// ── Visual Stream (Frame Analysis) ────────────────────────────────────────────
export interface FrameAnalysis {
  timestamp: number;
  frameType: 'talking_head' | 'broll' | 'screen_recording' | 'text_overlay' | 'product_shot';
  ocrText: string[];          // on-screen text detected
  pointsOfInterest: string[]; // products, faces, graphics
  energyScore: number;        // 0–100 visual energy
  isCutPoint: boolean;
}

export interface VisualStream {
  frames: FrameAnalysis[];
  talkingHeadPercent: number;
  brollPercent: number;
  avgCutFrequency: number;     // cuts per second
  highEnergyMoments: number[]; // timestamps
  allOcrText: string[];
  productMentions: string[];
}

// ── Metadata Stream ────────────────────────────────────────────────────────────
export interface MetadataStream {
  videoId: string;
  title: string;
  description: string;
  tags: string[];
  publishedAt: string;
  duration: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  engagementRate: number;
  thumbnailUrl: string;
  channelId: string;
  channelName: string;
  categoryId: string;
}

// ── Agent Outputs ──────────────────────────────────────────────────────────────
export interface HookAnalysis {
  hookScore: number;              // 0–100
  thumbnailTitleAlignment: number; // how well thumb promise matches intro
  firstFrameStrength: string;
  firstThirtySeconds: string;     // transcript of first 30s
  ariaVerdict: string;
  improvements: string[];
}

export interface RetentionAnalysis {
  retentionScore: number;
  dropOffEvents: Array<{
    timestamp: number;
    reason: string;
    audioContext: string;
    visualContext: string;
    fix: string;
  }>;
  rewatchEvents: Array<{
    timestamp: number;
    reason: string;
    whatWorked: string;
  }>;
  pacingVerdict: string;
  talkingHeadWarning: boolean;
}

export interface SeoViralAnalysis {
  seoScore: number;
  keywordDensity: Record<string, number>;
  missingKeywords: string[];
  titleOptimization: string;
  descriptionOptimization: string;
  tagSuggestions: string[];
  shortsTimestamps: Array<{
    start: number;
    end: number;
    caption: string;
    viralScore: number;
    reason: string;
  }>;
}

export interface ValueDensityAnalysis {
  valueDensityScore: number;
  fluffTimestamps: number[];
  cheatSheet: Array<{ point: string; timestamp: number }>;
  contentSummary: string;
  uniqueInsights: string[];
  actionableCount: number;
}

// ── Final Intelligence Report ──────────────────────────────────────────────────
export interface VideoIntelligenceReport {
  // Metadata
  videoId: string;
  videoTitle: string;
  channelName: string;
  publishedAt: string;
  duration: string;
  thumbnailUrl: string;
  viewCount: string;
  likeCount: string;
  commentCount: string;
  engagementRate: number;

  // Scores
  overallScore: number;
  scoreVerdict: string;

  // Agent Results
  hookAnalysis: HookAnalysis;
  retentionAnalysis: RetentionAnalysis;
  seoViralAnalysis: SeoViralAnalysis;
  valueDensityAnalysis: ValueDensityAnalysis;

  // Shorts
  shortsOpportunities: SeoViralAnalysis['shortsTimestamps'];

  // Stream summaries
  auralSummary: {
    speakerCount: number;
    wordCount: number;
    keyPhrases: string[];
    sentimentArc: string;
  };
  visualSummary: {
    talkingHeadPercent: number;
    brollPercent: number;
    avgCutFrequency: number;
    highEnergyMoments: number[];
  };

  // Meta
  analysisType: 'deep_multimodal' | 'metadata_only';
  hasHeatmap: boolean;
  processingMs: number;
}

// ── Competitor Analysis ──────────────────────────────────────────────────────
export interface CompetitorGapReport {
  niche: string;
  videosAnalysed: number;
  topTopics: string[];
  missedTopics: string[];            // Topics NONE of the 10 covered — your opportunity
  overservedTopics: string[];        // Topics everyone covered — avoid
  avgEngagementRate: number;
  titlePatterns: string[];
  opportunityScore: number;          // 0–100: how wide open is this niche?
  scriptTemplate: string;            // AIRA-generated template for the gap
  topVideoIds: string[];
}
