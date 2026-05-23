// ── Thumbnail Intelligence System — Shared Types ────────────────────────────────

/**
 * Visual analysis results from thumbnail vision model
 * Mirrors and extends RawSignals thumbnail metrics with detailed vision analysis
 */
export interface ThumbnailVisionAnalysis {
  // Text Detection
  hasText: boolean;
  textContent: string[]; // words visible on thumbnail
  
  // Color Analysis
  dominantColors: string[]; // hex codes, top 3 colors
  
  // Face Detection & Expression
  faceDetected: boolean;
  faceCount: number;
  expressionType: 'shock' | 'smile' | 'serious' | 'none' | 'other';
  
  // Quality Metrics (mirror RawSignals)
  clutter: number; // 1–5 (mirrors RawSignals.thumbnailClutter)
  titleSync: number; // 1–10 (mirrors RawSignals.thumbnailTitleSync)
  
  // Emotional & Cultural Signals
  emotionalValence: 'positive' | 'negative' | 'neutral';
  arrowOrCircle: boolean; // common Indian YouTube pattern for attention-grabbing
  
  // Brand Consistency
  brandConsistency: number; // 1–5
  
  // Confidence & Issues
  analysisConfidence: number; // 0–1
  issues: string[]; // specific problems found (e.g., "text too small", "low contrast")
  strengths: string[]; // specific strengths found (e.g., "high face visibility", "bold colors")
}

/**
 * Single thumbnail variant for A/B/C testing
 * Represents one design concept with its visual and textual elements
 */
export interface ThumbnailVariant {
  id: 'a' | 'b' | 'c';
  concept: string; // one-sentence description of the variant (e.g., "shocked face with arrow pointing up")
  colorPalette: string[]; // 3 hex codes for the primary color scheme
  textOverlay: string; // main text that appears on thumbnail
  hookLine: string; // matches the script hook for consistency
  imagePrompt: string; // DALL-E prompt if visual generation added later
  rationale: string; // why this variant works (e.g., "high contrast for mobile viewers")
}

/**
 * A/B/C test container for thumbnail variants
 * Manages rotation, tracking, and winner determination
 */
export interface ThumbnailABTest {
  id: string;
  studioSessionId?: string; // optional link to studio_scripts
  videoId?: string; // YouTube video ID if live video (for real CTR tracking)
  variants: ThumbnailVariant[];
  activeVariant: 'a' | 'b' | 'c'; // currently showing variant
  rotationStartedAt?: string; // ISO string
  rotationEndsAt?: string; // ISO string
  status: 'draft' | 'rotating' | 'decided';
  winner?: string; // 'a' | 'b' | 'c' after rotation ends
}

/**
 * CTR data point for a variant during rotation
 */
export interface VariantCTRMetric {
  variant: 'a' | 'b' | 'c';
  ctr: number; // 0.00–100.00
  clickCount: number;
  impressionCount: number;
}

/**
 * Thumbnail analysis result linked to a video DNA report
 * Stored in video_dna_analyses.thumbnail_analysis JSONB
 */
export interface ThumbnailAnalysisResult {
  videoId: string;
  analysis: ThumbnailVisionAnalysis;
  variantTested?: ThumbnailVariant; // if A/B tested
  ctrs?: VariantCTRMetric[]; // performance metrics if live
  generatedAt: string; // ISO timestamp
}

/**
 * Rival Watch configuration for a user
 * Stores bookmarked competitor handles for Gap 3 analysis
 * Stored in users.rival_watch_handles (TEXT[] in DB)
 */
export interface RivalWatchConfig {
  handles: string[]; // up to 3 competitor YouTube handles
  notifyOnNewThumbnail?: boolean; // alert user when rival updates thumbnail
  notifyOnThumbnailTrend?: boolean; // alert when rival's thumbnail pattern changes
  lastNotifiedAt?: string; // ISO timestamp
}
