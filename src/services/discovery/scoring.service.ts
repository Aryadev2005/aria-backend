// src/services/discovery/scoring.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Unified Velocity Scoring Engine
// All platform scores normalise to 0–100 before hitting live_trends
// ══════════════════════════════════════════════════════════════════════════════

export type DiscoverySource = 'youtube' | 'reddit' | 'tiktok' | 'pinterest' | 'google' | 'instagram';

// ── Platform-native score computation ────────────────────────────────────────

export function computeYouTubeVelocity(
  viewCount: number,
  likeCount: number,
  commentCount: number
): number {
  if (viewCount === 0) return 0;
  const viewScore       = Math.min(50, Math.log10(viewCount + 1) * 10);
  const engagementRate  = ((likeCount + commentCount) / viewCount) * 100;
  const engagementScore = Math.min(50, engagementRate * 10);
  return Math.round(viewScore + engagementScore);
}

export function computeRedditScore(
  upvotes: number,
  numComments: number,
  createdAt: Date
): { rawScore: number; isHighFriction: boolean } {
  const epochSeconds = createdAt.getTime() / 1000;
  const hotness = Math.log10(Math.max(1, upvotes)) + epochSeconds / 45000;
  const isHighFriction = numComments > upvotes; // strong discussion signal
  return { rawScore: hotness, isHighFriction };
}

export function computeTikTokVelocity(
  views: number,
  likes: number,
  comments: number,
  shares: number
): { rawScore: number; isShareBreakout: boolean } {
  if (views === 0) return { rawScore: 0, isShareBreakout: false };
  const rawScore = ((likes * 1) + (comments * 3) + (shares * 5)) / (views / 1000);
  const isShareBreakout = shares / views > 0.02; // shares > 2% of views
  return { rawScore, isShareBreakout };
}

export function computePinterestScore(
  saves: number,
  clicks: number,
  impressions: number
): { rawScore: number; isHighIntent: boolean } {
  if (impressions === 0) return { rawScore: 0, isHighIntent: false };
  const rawScore = (saves * 2 + clicks) / impressions;
  const isHighIntent = impressions > 0 && saves / impressions > 0.15;
  return { rawScore, isHighIntent };
}

export function computeGoogleSlope(
  scoreNow: number,
  scorePrev: number,  // 12h ago — 0 if first run
  hoursDiff: number   // typically 12
): { slope: number; isBreakout: boolean } {
  const slope = hoursDiff > 0 ? (scoreNow - scorePrev) / hoursDiff : 0;
  const isBreakout = slope > 5; // > 5 points/hour = BREAKOUT
  return { slope, isBreakout };
}

// ── Normalise to unified 0–100 scale ─────────────────────────────────────────

export function normaliseScore(source: DiscoverySource, rawScore: number): number {
  // Each platform has a different scale — map to 0-100
  const ceilings: Record<DiscoverySource, number> = {
    youtube:   100,   // already 0-100 from our formula
    reddit:    2000,  // hotness scores typically 0-2000
    tiktok:    500,   // engagement velocity can spike high
    pinterest: 1,     // ratio 0-1
    google:    100,   // google trends score 0-100
    instagram: 100,   // same as youtube formula
  };

  const ceiling = ceilings[source] || 100;
  return Math.min(100, Math.round((rawScore / ceiling) * 100));
}

// ── Velocity gate ─────────────────────────────────────────────────────────────
// Returns whether a record should be stored + whether it's an override

export interface VelocityDecision {
  shouldStore:    boolean;
  isOverride:     boolean;
  overrideReason: string | null;
  unifiedScore:   number;
}

export function makeVelocityDecision(params: {
  source:           DiscoverySource;
  rawScore:         number;
  isHighFriction?:  boolean;  // reddit: comments > upvotes
  isShareBreakout?: boolean;  // tiktok: shares > 2% views
  isHighIntent?:    boolean;  // pinterest: saves/impressions > 15%
  isBreakout?:      boolean;  // google: slope > 5/hour
}): VelocityDecision {
  const { source, rawScore, isHighFriction, isShareBreakout, isHighIntent, isBreakout } = params;
  const unifiedScore = normaliseScore(source, rawScore);

  const VELOCITY_THRESHOLD = 3; // unified 0-100 score

  const isViral = unifiedScore > VELOCITY_THRESHOLD;

  // Qualitative override gate
  if (!isViral) {
    if (source === 'reddit' && isHighFriction) {
      return { shouldStore: true, isOverride: true, overrideReason: 'high_friction', unifiedScore };
    }
    if (source === 'tiktok' && isShareBreakout) {
      return { shouldStore: true, isOverride: true, overrideReason: 'share_breakout', unifiedScore };
    }
    if (source === 'pinterest' && isHighIntent) {
      return { shouldStore: true, isOverride: true, overrideReason: 'high_intent', unifiedScore };
    }
    if (source === 'google' && isBreakout) {
      return { shouldStore: true, isOverride: true, overrideReason: 'google_breakout', unifiedScore };
    }
    return { shouldStore: false, isOverride: false, overrideReason: null, unifiedScore };
  }

  return { shouldStore: true, isOverride: false, overrideReason: null, unifiedScore };
}

// ── Content format detection ──────────────────────────────────────────────────

export function detectContentFormat(
  source: DiscoverySource,
  durationIso?: string,   // YouTube ISO 8601 e.g. PT2M30S
  isVideo?: boolean
): 'short_form' | 'long_form' | 'article' | 'post' | 'pin' | 'unknown' {
  if (source === 'youtube') {
    if (!durationIso) return 'unknown';
    // Parse ISO 8601 duration
    const match = durationIso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 'unknown';
    const hours   = parseInt(match[1] || '0');
    const minutes = parseInt(match[2] || '0');
    const seconds = parseInt(match[3] || '0');
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    return totalSeconds <= 60 ? 'short_form' : 'long_form';
  }
  if (source === 'instagram') return isVideo ? 'short_form' : 'post';
  if (source === 'reddit')    return 'article';
  if (source === 'tiktok')    return 'short_form';
  if (source === 'pinterest') return 'pin';
  if (source === 'google')    return 'article';
  return 'unknown';
}
