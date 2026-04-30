import { User } from '../types/user';

/**
 * Get platform-aware context for any ARIA service call
 * Use this in every controller instead of raw user.primary_platform
 */
export const getPlatformContext = (user: User) => {
  const platform    = user.primary_platform || (user as any).primaryPlatform || 'instagram';
  const isInstagram = platform === 'instagram';
  const isYouTube   = platform === 'youtube';

  return {
    platform,
    isInstagram,
    isYouTube,
    handle:       isInstagram ? user.instagram_handle : user.youtube_handle,
    niche:        (user.niches as any)?.[0] || 'general',
    archetype:    user.archetype   || 'EDUCATOR',
    followerRange: user.follower_range || (user as any).followerRange || '1K–10K',
    engagementRate: (user as any).engagement_rate || (user as any).engagementRate || 4,
  };
};

/**
 * Build platform-specific Groq prompt context string
 * Inject this into any ARIA prompt that needs platform awareness
 */
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

/**
 * Platform-specific timing windows
 */
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
  return windows[archetype] || windows.EDUCATOR;
};
