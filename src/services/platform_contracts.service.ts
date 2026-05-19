// src/services/platform_contracts.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Platform Contracts — hard rules per platform, enforced in code not prompts.
// Based on 2025–2026 algorithm research:
//   Instagram Reels: 3s retention = #1 ranking signal, 7–15s optimal completion
//   YouTube Shorts:  two-phase algorithm, search-driven, 60s max
//   YouTube Video:   watch time %, re-hook at 2–3min drop-off point
//   TikTok:         13–60s optimal, keyword-rich captions up to 4000 chars
// ══════════════════════════════════════════════════════════════════════════════

export interface PlatformContract {
  platform: string;
  hookWindowSeconds: number;      // Max seconds for hook to land
  maxSections: number;            // Hard cap on section count for short-form
  minSections: number;
  captionMaxChars: number;
  captionStyle: "short" | "medium" | "long" | "keyword_rich";
  ctaPlacement: "end_only" | "mid_and_end" | "end_with_comment_bait";
  optimalDurationSeconds: [number, number]; // [min, max] for best performance
  rehookIntervalSeconds: number;  // Re-hook every N seconds for long content
  hashtagCount: [number, number]; // [min, max]
  titleMaxChars?: number;         // YouTube only
  keywordTitle: boolean;          // Should title be search-optimised?
  scriptInstructions: string;     // Injected into every section prompt
}

export const PLATFORM_CONTRACTS: Record<string, PlatformContract> = {
  instagram: {
    platform: "instagram",
    hookWindowSeconds: 3,
    maxSections: 4,
    minSections: 3,
    captionMaxChars: 300,
    captionStyle: "short",
    ctaPlacement: "end_with_comment_bait",
    optimalDurationSeconds: [7, 60],
    rehookIntervalSeconds: 15,
    hashtagCount: [8, 12],
    keywordTitle: false,
    scriptInstructions:
      "Instagram Reels. Hook must land in 3 seconds. Algorithm rewards completion rate — every word must earn its place. Short sentences. Natural Hinglish if it fits. End with ONE action: comment, follow, or save.",
  },

  youtube_short: {
    platform: "youtube_short",
    hookWindowSeconds: 5,
    maxSections: 5,
    minSections: 3,
    captionMaxChars: 500,
    captionStyle: "keyword_rich",
    ctaPlacement: "end_only",
    optimalDurationSeconds: [30, 60],
    rehookIntervalSeconds: 20,
    hashtagCount: [3, 5],
    titleMaxChars: 100,
    keywordTitle: true,
    scriptInstructions:
      "YouTube Shorts. Two-phase algorithm — seed audience first, then exploit phase. Search-driven discovery. Hook must work without sound (85% of views are silent). End with subscribe CTA. Title and first line must share keywords.",
  },

  youtube: {
    platform: "youtube",
    hookWindowSeconds: 30,   // 30s to establish value promise
    maxSections: 999,        // No cap — chapter-based
    minSections: 5,
    captionMaxChars: 5000,
    captionStyle: "long",
    ctaPlacement: "mid_and_end",
    optimalDurationSeconds: [480, 1800], // 8–30 min sweet spot
    rehookIntervalSeconds: 90,           // Re-hook every 90s for long-form
    hashtagCount: [3, 5],
    titleMaxChars: 100,
    keywordTitle: true,
    scriptInstructions:
      "YouTube long-form. Watch time % is the #1 ranking signal. Plant 2–3 open curiosity loops in first 90 seconds. Hard re-hook before the 2–3 minute drop-off point. Chapters should each function as a standalone mini-video with their own hook and payoff.",
  },

  tiktok: {
    platform: "tiktok",
    hookWindowSeconds: 2,    // TikTok is fastest — 2 seconds
    maxSections: 4,
    minSections: 3,
    captionMaxChars: 4000,
    captionStyle: "keyword_rich",
    ctaPlacement: "end_with_comment_bait",
    optimalDurationSeconds: [13, 60],
    rehookIntervalSeconds: 10,
    hashtagCount: [5, 10],
    keywordTitle: false,
    scriptInstructions:
      "TikTok. Fastest scroll velocity of any platform. Hook in 2 seconds or the video is dead. High energy, fast pace. Authenticity over polish. Duet/stitch bait in CTA performs well.",
  },

  story: {
    platform: "story",
    hookWindowSeconds: 2,
    maxSections: 3,
    minSections: 2,
    captionMaxChars: 0,      // No caption for stories
    captionStyle: "short",
    ctaPlacement: "end_only",
    optimalDurationSeconds: [5, 15],
    rehookIntervalSeconds: 999,
    hashtagCount: [0, 3],
    keywordTitle: false,
    scriptInstructions:
      "Instagram Story. 15 seconds max per frame. Single message per frame. Direct, personal tone. Poll/question stickers in CTA increase retention.",
  },
};

export function getPlatformContract(platform: string, format?: string): PlatformContract {
  // Map format names to contract keys
  if (format === "video" || platform === "youtube") {
    return PLATFORM_CONTRACTS.youtube;
  }
  if (format === "story") return PLATFORM_CONTRACTS.story;
  if (platform === "tiktok") return PLATFORM_CONTRACTS.tiktok;
  if (platform === "youtube_short" || format === "short") return PLATFORM_CONTRACTS.youtube_short;
  return PLATFORM_CONTRACTS.instagram; // default
}