import { User } from '../types/user';

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

export const getPlatformContext = (user: User) => {
  const platform    = user.primary_platform || (user as any).primaryPlatform || 'instagram';
  const isInstagram = platform === 'instagram';
  const isYouTube   = platform === 'youtube';

  return {
    platform,
    isInstagram,
    isYouTube,
    handle:         isInstagram ? user.instagram_handle : user.youtube_handle,
    niche:          (user.niches as any)?.[0] || 'general',
    archetype:      user.archetype   || null,          // null = incomplete profile
    followerRange:  user.follower_range || (user as any).followerRange || '1K–10K',
    engagementRate: (user as any).engagement_rate || (user as any).engagementRate || 4,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM PROMPT CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

export const buildPlatformPromptContext = (user: User): string => {
  const ctx = getPlatformContext(user);

  if (ctx.isYouTube) {
    return `Platform: YouTube
Handle: @${ctx.handle || 'unknown'}
Content type: Long-form videos + YouTube Shorts
Monetisation: AdSense CPM + brand deals + memberships
Script format: Hook → Context → Core (5 lessons) → Proof → CTA
Best timing: Upload day matters more than time. Thu–Sat best.
Audio: Mood-matched royalty-free instrumentals. No trending audio — kills credibility.
Brand deals: Strategic — pitch pre-season. Watch time + CPM are the leverage.`;
  }

  return `Platform: Instagram
Handle: @${ctx.handle || 'unknown'}
Content type: Reels + Stories + Carousels
Monetisation: Brand deals + affiliate + paid partnerships
Script format: Hook (3s) → Value (15s) → CTA (5s)
Best timing: Fri–Sat 7:30 PM IST for most niches
Audio: Trending Bollywood audio can be the content for dancers. Mood-matched for others.
Brand deals: Reactive — pitch within 72hrs of a viral post. D2C brands, beauty, fashion.`;
};

// ─────────────────────────────────────────────────────────────────────────────
// TIMING WINDOWS  (all times in IST)
// ─────────────────────────────────────────────────────────────────────────────

/** Hardcoded IST posting windows keyed by archetype × platform */
export const getPlatformTimingWindows = (archetype: string, platform: string): string[] => {
  const INSTAGRAM_WINDOWS: Record<string, string[]> = {
    TRENDSETTER:  ['Fri 7:30 PM', 'Sat 8:00 PM', 'Wed 7:00 PM'],
    EDUCATOR:     ['Sun 6:00 PM', 'Tue 8:00 PM', 'Thu 7:30 PM'],
    ENTERTAINER:  ['Fri 7:00 PM', 'Sat 8:00 PM', 'Wed 9:00 PM'],
    STORYTELLER:  ['Sat 7:00 PM', 'Sun 10:00 AM', 'Thu 8:00 PM'],
    CONNECTOR:    ['Sat 10:00 AM', 'Sun 11:00 AM', 'Tue 7:30 PM'],
    EXPERT:       ['Thu 8:00 PM', 'Mon 8:00 PM', 'Sat 9:00 AM'],
    HUSTLER:      ['Mon 7:00 AM', 'Tue 8:00 PM', 'Thu 7:00 PM'],
    ATHLETE:      ['Sat 7:00 AM', 'Wed 6:30 PM', 'Mon 7:00 AM'],
    CHEF:         ['Sun 12:00 PM', 'Fri 6:30 PM', 'Wed 7:00 PM'],
    PERFORMER:    ['Fri 8:00 PM', 'Sat 9:00 PM', 'Wed 7:30 PM'],
  };

  const YOUTUBE_WINDOWS: Record<string, string[]> = {
    TRENDSETTER:  ['Sat 12:00 PM', 'Fri 3:00 PM', 'Wed 5:00 PM'],
    EDUCATOR:     ['Thu 6:00 PM', 'Sun 10:00 AM', 'Tue 7:00 PM'],
    ENTERTAINER:  ['Fri 4:00 PM', 'Sat 2:00 PM', 'Wed 5:00 PM'],
    STORYTELLER:  ['Sat 11:00 AM', 'Thu 7:00 PM', 'Sun 3:00 PM'],
    CONNECTOR:    ['Sun 10:00 AM', 'Sat 11:00 AM', 'Thu 6:00 PM'],
    EXPERT:       ['Thu 7:00 PM', 'Mon 6:00 PM', 'Sat 10:00 AM'],
    HUSTLER:      ['Mon 6:00 PM', 'Thu 7:00 PM', 'Sat 10:00 AM'],
    ATHLETE:      ['Sat 8:00 AM', 'Wed 5:00 PM', 'Mon 6:00 PM'],
    CHEF:         ['Sun 11:00 AM', 'Fri 5:00 PM', 'Wed 6:00 PM'],
    PERFORMER:    ['Fri 5:00 PM', 'Sat 3:00 PM', 'Wed 6:00 PM'],
  };

  const windows = platform === 'youtube' ? YOUTUBE_WINDOWS : INSTAGRAM_WINDOWS;
  // Fallback: broad high-traffic windows instead of silently giving niche advice
  return windows[archetype] || ['Fri 7:30 PM', 'Sun 6:00 PM', 'Wed 7:00 PM'];
};

// ─────────────────────────────────────────────────────────────────────────────
// IST → UTC SLOT CONVERSION  (server-side, deterministic)
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/**
 * Parse an IST slot string like "Fri 7:30 PM" and return the next UTC Date
 * when that slot occurs (always in the future, within the next 7 days).
 *
 * IST = UTC+5:30, so we subtract 5h30m to convert to UTC.
 */
export const parseISTSlotToNextUTC = (slot: string): Date | null => {
  try {
    // e.g. "Fri 7:30 PM"  or  "Sat 12:00 PM"
    const match = slot.match(/^(\w{3})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i);
    if (!match) return null;

    const [, dayStr, hourStr, minStr, meridiem] = match;
    const targetDay = DAY_MAP[dayStr.toLowerCase()];
    if (targetDay === undefined) return null;

    let hour = parseInt(hourStr, 10);
    const min = parseInt(minStr, 10);
    if (meridiem.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (meridiem.toUpperCase() === 'AM' && hour === 12) hour = 0;

    // IST offset = +5h30m = 330 minutes ahead of UTC
    // slot in UTC = slot_IST - 5h30m
    const totalISTMinutes = hour * 60 + min;
    const totalUTCMinutes = totalISTMinutes - 330; // may go negative (previous day)

    let utcHour = Math.floor(((totalUTCMinutes % 1440) + 1440) % 1440 / 60);
    let utcMin  = ((totalUTCMinutes % 1440) + 1440) % 1440 % 60;

    // If IST time crosses midnight backwards, UTC day is one behind
    const dayOffset = totalUTCMinutes < 0 ? -1 : 0;
    let utcDay = (targetDay + dayOffset + 7) % 7;

    const now = new Date();
    const nowUTCDay = now.getUTCDay();
    let daysUntil = (utcDay - nowUTCDay + 7) % 7;

    // Build the candidate UTC date
    const candidate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysUntil,
      utcHour,
      utcMin,
      0,
      0,
    ));

    // If the candidate is in the past (same day but earlier time), push 7 days forward
    if (candidate.getTime() <= now.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() + 7);
    }

    return candidate;
  } catch {
    return null;
  }
};

/**
 * Given an IST slot string, returns how many hours until the next occurrence.
 * Returns 0 on parse failure so the UI degrades gracefully.
 */
export const computeNextSlotHoursAway = (slot: string): number => {
  const next = parseISTSlotToNextUTC(slot);
  if (!next) return 0;
  const diffMs = next.getTime() - Date.now();
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60)));
};

// ─────────────────────────────────────────────────────────────────────────────
// BANNED BRAND CATEGORIES  (injected into brand alert prompt)
// ─────────────────────────────────────────────────────────────────────────────

export const BANNED_BRAND_CATEGORIES = [
  'gambling', 'betting', 'fantasy sports with real money',
  'alcohol', 'tobacco', 'cryptocurrency trading platforms',
  'loan sharks or predatory lending', 'adult content',
  'MLM or pyramid schemes',
] as const;
