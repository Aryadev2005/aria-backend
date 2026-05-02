/**
 * ARIA — Instagram Provider (Facebook Login for Business)
 *
 * Auth flow:
 *  1. Redirect → Facebook OAuth dialog
 *  2. Exchange code → short-lived FB User token
 *  3. Exchange → long-lived FB User token (60 days)
 *  4. GET /me/accounts → list Facebook Pages
 *  5. GET /{page-id}?fields=instagram_business_account → get IGBA ID + Page token
 *  6. Store Page access token (never expires) + IGBA ID
 *
 * All data calls use graph.facebook.com/{version}/{ig-user-id}/...
 */

import axios from "axios";

// ── Constants ─────────────────────────────────────────────────────────────────
export const FB_GRAPH_BASE = "https://graph.facebook.com/v22.0";
const FB_AUTH_URL = "https://www.facebook.com/dialog/oauth";

// All permissions needed for full Instagram data access
// instagram_basic          → profile, media
// instagram_manage_insights→ account + media insights
// instagram_manage_comments→ read/delete comments
// instagram_content_publish→ (optional) publish
// pages_show_list          → list FB pages the user manages
// pages_read_engagement    → read page engagement data
export const FB_SCOPES = [
  "instagram_basic",
  "instagram_manage_insights",
  "instagram_manage_comments",
  "pages_show_list",
  "pages_read_engagement",
].join(",");

function getFacebookAppId(): string {
  return process.env.FACEBOOK_APP_ID || process.env.INSTAGRAM_APP_ID || "";
}

function getFacebookAppSecret(): string {
  return (
    process.env.FACEBOOK_APP_SECRET || process.env.INSTAGRAM_APP_SECRET || ""
  );
}

function getRedirectUri(): string {
  const base = (process.env.BACKEND_URL || "http://localhost:3000").replace(
    /\/+$/,
    "",
  );
  return `${base}/api/v1/integrations/instagram/callback`;
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface InstagramUserProfile {
  /** Instagram Business Account ID — use for all Graph API calls */
  user_id: string;
  username: string;
  followers_count: number;
  media_count: number;
  biography: string;
  website: string;
  name: string;
  profile_picture_url: string;
  /** The Facebook Page ID that owns this Instagram account */
  page_id: string;
  page_name: string;
}

export interface InstagramOAuthResult {
  /** Long-lived Facebook User token (60 days) */
  accessToken: string;
  /** Page access token — NEVER expires. Prefer this for API calls. */
  pageAccessToken: string;
  /** Facebook Page ID */
  pageId: string;
  /** Instagram Business Account ID — used as {ig-user-id} in all calls */
  igUserId: string;
  expiresAt: Date | null;
  profile: InstagramUserProfile;
  permissions: string[];
}

export interface IGMedia {
  id: string;
  caption?: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" | "REELS";
  media_url?: string;
  thumbnail_url?: string;
  permalink: string;
  timestamp: string;
  like_count: number;
  comments_count: number;
  shortcode: string;
  is_shared_to_feed?: boolean;
  media_product_type?: string;
}

export interface IGMediaInsights {
  id: string;
  impressions: number;
  reach: number;
  engagement: number;
  saved: number;
  shares?: number;
  total_interactions?: number;
  video_views?: number;
  ig_reels_video_view_total_time?: number;
  ig_reels_avg_watch_time?: number;
}

export interface IGAccountInsights {
  follower_count?: number;
  reach?: number;
  impressions?: number;
  profile_views?: number;
  website_clicks?: number;
  accounts_engaged?: number;
}

export interface IGAudienceDemographics {
  audience_city?: Record<string, number>;
  audience_country?: Record<string, number>;
  audience_gender_age?: Record<string, number>;
  audience_locale?: Record<string, number>;
}

export interface IGFullAnalytics {
  profile: InstagramUserProfile;
  recentMedia: IGMedia[];
  mediaInsights: IGMediaInsights[];
  accountInsights: IGAccountInsights;
  demographics: IGAudienceDemographics;
  computedStats: {
    avgLikes: number;
    avgComments: number;
    avgEngagementRate: number;
    avgImpressions: number;
    avgReach: number;
    avgSaved: number;
    topHashtags: string[];
    postingFrequency: string;
    bestPostType: string;
    reelCount: number;
    imageCount: number;
    carouselCount: number;
    totalPostsAnalyzed: number;
  };
}

// ── Step 1: Generate Auth URL ─────────────────────────────────────────────────
export function generateInstagramAuthUrl(
  userId: string,
  flow: "register" | "onboarding" | "dashboard" = "dashboard",
): string {
  const appId = getFacebookAppId();
  if (!appId) {
    throw new Error(
      "FACEBOOK_APP_ID (or INSTAGRAM_APP_ID) is not set in environment variables",
    );
  }

  const state = Buffer.from(
    JSON.stringify({ userId, ts: Date.now(), flow }),
  ).toString("base64");

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: getRedirectUri(),
    scope: FB_SCOPES,
    response_type: "code",
    state,
  });

  return `${FB_AUTH_URL}?${params.toString()}`;
}

// ── Step 2: Short-lived token ─────────────────────────────────────────────────
async function exchangeCodeForShortToken(code: string): Promise<string> {
  const appId = getFacebookAppId();
  const appSecret = getFacebookAppSecret();

  const res = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
    params: {
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: getRedirectUri(),
      code,
    },
    timeout: 10000,
  });

  const token = res.data?.access_token;
  if (!token)
    throw new Error(`Code exchange failed: ${JSON.stringify(res.data)}`);
  return token;
}

// ── Step 3: Long-lived token (60 days) ────────────────────────────────────────
async function exchangeForLongLivedToken(
  shortToken: string,
): Promise<{ token: string; expiresAt: Date }> {
  const appId = getFacebookAppId();
  const appSecret = getFacebookAppSecret();

  const res = await axios.get(`${FB_GRAPH_BASE}/oauth/access_token`, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
    timeout: 10000,
  });

  const token = res.data?.access_token;
  const expiresIn = res.data?.expires_in || 5184000;
  if (!token)
    throw new Error(
      `Long-lived token exchange failed: ${JSON.stringify(res.data)}`,
    );

  return {
    token,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

// ── Step 4: Get FB Pages ──────────────────────────────────────────────────────
async function getUserPages(
  userToken: string,
): Promise<
  Array<{ id: string; name: string; access_token: string; tasks: string[] }>
> {
  const res = await axios.get(`${FB_GRAPH_BASE}/me/accounts`, {
    params: {
      fields: "id,name,access_token,tasks",
      access_token: userToken,
    },
    timeout: 10000,
  });

  const pages = res.data?.data || [];
  if (pages.length === 0) {
    throw new Error(
      "No Facebook Pages found. The Instagram Business account must be linked to a Facebook Page. " +
        "Go to Instagram Settings → Account → Linked Accounts → Facebook.",
    );
  }

  return pages;
}

// ── Step 5: Get IGBA ID from a page ──────────────────────────────────────────
async function getIGBAFromPage(
  pageId: string,
  pageAccessToken: string,
): Promise<{
  igUserId: string;
  username: string;
  followersCount: number;
  mediaCount: number;
  biography: string;
  website: string;
  name: string;
  profilePictureUrl: string;
}> {
  const res = await axios.get(`${FB_GRAPH_BASE}/${pageId}`, {
    params: {
      fields:
        "instagram_business_account{id,username,followers_count,media_count,biography,website,name,profile_picture_url}",
      access_token: pageAccessToken,
    },
    timeout: 10000,
  });

  const igba = res.data?.instagram_business_account;
  if (!igba?.id) {
    throw new Error(
      `Facebook Page "${pageId}" has no linked Instagram Business/Creator Account. ` +
        "Make sure the Instagram account is set to Business or Creator and is linked to this Page.",
    );
  }

  return {
    igUserId: igba.id,
    username: igba.username || "",
    followersCount: igba.followers_count || 0,
    mediaCount: igba.media_count || 0,
    biography: igba.biography || "",
    website: igba.website || "",
    name: igba.name || "",
    profilePictureUrl: igba.profile_picture_url || "",
  };
}

// ── Main OAuth completion ─────────────────────────────────────────────────────
export async function completeInstagramOAuth(
  code: string,
): Promise<InstagramOAuthResult> {
  if (!getFacebookAppId() || !getFacebookAppSecret()) {
    throw new Error(
      "FACEBOOK_APP_ID/FACEBOOK_APP_SECRET (or INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET) are required",
    );
  }

  const shortToken = await exchangeCodeForShortToken(code);
  const { token: longToken, expiresAt } =
    await exchangeForLongLivedToken(shortToken);

  // Get granted permissions
  const permissionsRes = await axios
    .get(`${FB_GRAPH_BASE}/me/permissions`, {
      params: { access_token: longToken },
      timeout: 8000,
    })
    .catch(() => ({ data: { data: [] } }));
  const permissions: string[] = (permissionsRes.data?.data || [])
    .filter((p: any) => p.status === "granted")
    .map((p: any) => p.permission as string);

  const pages = await getUserPages(longToken);

  let lastError: Error | null = null;
  for (const page of pages) {
    try {
      const igba = await getIGBAFromPage(page.id, page.access_token);

      return {
        accessToken: longToken,
        pageAccessToken: page.access_token,
        pageId: page.id,
        igUserId: igba.igUserId,
        expiresAt,
        permissions,
        profile: {
          user_id: igba.igUserId,
          username: igba.username,
          followers_count: igba.followersCount,
          media_count: igba.mediaCount,
          biography: igba.biography,
          website: igba.website,
          name: igba.name,
          profile_picture_url: igba.profilePictureUrl,
          page_id: page.id,
          page_name: page.name,
        },
      };
    } catch (err: any) {
      lastError = err;
      continue;
    }
  }

  throw (
    lastError ||
    new Error("No Instagram Business Account found across Facebook Pages.")
  );
}

// ── Token Utilities ───────────────────────────────────────────────────────────
/** Page tokens never expire. FB User token expires in ~60 days. */
export function instagramTokenIsExpired(tokenExpiresAt: Date | null): boolean {
  if (!tokenExpiresAt) return false;
  return tokenExpiresAt.getTime() < Date.now();
}

export function instagramTokenNeedsRefresh(
  tokenExpiresAt: Date | null,
): boolean {
  if (!tokenExpiresAt) return false;
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
  return tokenExpiresAt.getTime() < Date.now() + tenDaysMs;
}

/**
 * Refresh a long-lived FB User token.
 * Page tokens don't need refreshing.
 */
export async function refreshFacebookUserToken(
  longLivedToken: string,
): Promise<{ token: string; expiresAt: Date }> {
  return exchangeForLongLivedToken(longLivedToken);
}

/**
 * Parse stored token JSON and return a valid access token for API calls.
 * Stored format: { page_token, user_token, page_id, ig_user_id }
 * Page token is preferred (never expires).
 */
export async function getValidInstagramToken(
  storedToken: string,
  tokenExpiresAt: Date | null,
  onRefreshed?: (
    newTokenJson: string,
    newExpiresAt: Date | null,
  ) => Promise<void>,
): Promise<{ token: string; igUserId: string; pageId: string }> {
  let parsed: {
    page_token?: string;
    user_token?: string;
    page_id?: string;
    ig_user_id?: string;
  };

  try {
    parsed = JSON.parse(storedToken);
  } catch {
    // Legacy plain token — treat as page token, no ig_user_id known
    parsed = { page_token: storedToken };
  }

  // Page token never expires — always prefer it
  if (parsed.page_token) {
    return {
      token: parsed.page_token,
      igUserId: parsed.ig_user_id || "",
      pageId: parsed.page_id || "",
    };
  }

  // User token path — check expiry
  if (!parsed.user_token) throw new Error("No token available");

  if (!instagramTokenIsExpired(tokenExpiresAt)) {
    return {
      token: parsed.user_token,
      igUserId: parsed.ig_user_id || "",
      pageId: parsed.page_id || "",
    };
  }

  // Expired — refresh
  const { token: newToken, expiresAt: newExpiry } =
    await refreshFacebookUserToken(parsed.user_token);
  const newJson = JSON.stringify({ ...parsed, user_token: newToken });
  if (onRefreshed) await onRefreshed(newJson, newExpiry);

  return {
    token: newToken,
    igUserId: parsed.ig_user_id || "",
    pageId: parsed.page_id || "",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA FETCHING — Everything below fetches real Instagram data
// All calls use graph.facebook.com/{version}/{ig-user-id}/...
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch full profile details for an IGBA.
 */
export async function fetchIGProfile(
  igUserId: string,
  accessToken: string,
): Promise<Partial<InstagramUserProfile>> {
  const res = await axios.get(`${FB_GRAPH_BASE}/${igUserId}`, {
    params: {
      fields:
        "id,username,name,biography,website,followers_count,media_count,profile_picture_url",
      access_token: accessToken,
    },
    timeout: 10000,
  });

  return {
    user_id: res.data.id,
    username: res.data.username || "",
    name: res.data.name || "",
    biography: res.data.biography || "",
    website: res.data.website || "",
    followers_count: res.data.followers_count || 0,
    media_count: res.data.media_count || 0,
    profile_picture_url: res.data.profile_picture_url || "",
  };
}

/**
 * Fetch recent media with full fields including captions, hashtags, likes, comments.
 * Returns up to `limit` posts (max 100 per request).
 */
export async function fetchRecentMedia(
  igUserId: string,
  accessToken: string,
  limit = 25,
): Promise<IGMedia[]> {
  const fields = [
    "id",
    "caption",
    "media_type",
    "media_url",
    "thumbnail_url",
    "permalink",
    "timestamp",
    "like_count",
    "comments_count",
    "shortcode",
    "is_shared_to_feed",
    "media_product_type",
  ].join(",");

  const res = await axios.get(`${FB_GRAPH_BASE}/${igUserId}/media`, {
    params: {
      fields,
      limit: Math.min(limit, 100),
      access_token: accessToken,
    },
    timeout: 15000,
  });

  return res.data?.data || [];
}

/**
 * Fetch insights for a single media object.
 * Handles Reels vs regular posts (different available metrics).
 */
export async function fetchMediaInsights(
  mediaId: string,
  mediaType: string,
  accessToken: string,
): Promise<IGMediaInsights> {
  // Metric sets differ by media type
  let metrics: string[];

  if (mediaType === "REELS" || mediaType === "VIDEO") {
    metrics = [
      "impressions",
      "reach",
      "total_interactions",
      "saved",
      "shares",
      "ig_reels_video_view_total_time",
      "ig_reels_avg_watch_time",
    ];
  } else if (mediaType === "CAROUSEL_ALBUM") {
    metrics = [
      "impressions",
      "reach",
      "engagement",
      "saved",
      "shares",
      "total_interactions",
    ];
  } else {
    // IMAGE
    metrics = [
      "impressions",
      "reach",
      "engagement",
      "saved",
      "shares",
      "total_interactions",
    ];
  }

  try {
    const res = await axios.get(`${FB_GRAPH_BASE}/${mediaId}/insights`, {
      params: {
        metric: metrics.join(","),
        access_token: accessToken,
      },
      timeout: 10000,
    });

    const data: any[] = res.data?.data || [];
    const result: IGMediaInsights = {
      id: mediaId,
      impressions: 0,
      reach: 0,
      engagement: 0,
      saved: 0,
      shares: 0,
      total_interactions: 0,
    };

    for (const item of data) {
      const val = item.values?.[0]?.value ?? item.value ?? 0;
      (result as any)[item.name] = val;
    }

    return result;
  } catch {
    // Insights not available for some media (e.g., old posts, stories)
    return { id: mediaId, impressions: 0, reach: 0, engagement: 0, saved: 0 };
  }
}

/**
 * Fetch account-level insights (reach, impressions, profile views, follower growth).
 * period can be 'day', 'week', 'month', 'lifetime'
 */
export async function fetchAccountInsights(
  igUserId: string,
  accessToken: string,
  period: "day" | "week" | "month" = "month",
): Promise<IGAccountInsights> {
  // Note: some metrics deprecated in v21+ (profile_views, website_clicks time-series)
  // accounts_engaged and reach are current as of v22
  const metrics = [
    "reach",
    "impressions",
    "accounts_engaged",
    "total_interactions",
  ];

  try {
    const res = await axios.get(`${FB_GRAPH_BASE}/${igUserId}/insights`, {
      params: {
        metric: metrics.join(","),
        period,
        access_token: accessToken,
      },
      timeout: 10000,
    });

    const result: IGAccountInsights = {};
    for (const item of res.data?.data || []) {
      const val = item.values?.[item.values.length - 1]?.value ?? 0;
      (result as any)[item.name] = val;
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Fetch audience demographics (city, country, gender/age breakdown).
 * Requires instagram_manage_insights permission.
 * Only available for accounts with 100+ followers.
 */
export async function fetchAudienceDemographics(
  igUserId: string,
  accessToken: string,
): Promise<IGAudienceDemographics> {
  const breakdowns = [
    { metric: "follower_demographics", breakdown: "city" },
    { metric: "follower_demographics", breakdown: "country" },
    { metric: "follower_demographics", breakdown: "age,gender" },
  ];

  const result: IGAudienceDemographics = {};

  for (const { metric, breakdown } of breakdowns) {
    try {
      const res = await axios.get(`${FB_GRAPH_BASE}/${igUserId}/insights`, {
        params: {
          metric,
          period: "lifetime",
          breakdown,
          access_token: accessToken,
        },
        timeout: 10000,
      });

      const data =
        res.data?.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
      const mapped: Record<string, number> = {};
      for (const item of data) {
        const key =
          item.dimension_values?.join("_") || item.dimension_value || "unknown";
        mapped[key] = item.value || 0;
      }

      if (breakdown === "city") result.audience_city = mapped;
      else if (breakdown === "country") result.audience_country = mapped;
      else if (breakdown === "age,gender") result.audience_gender_age = mapped;
    } catch {
      // Demographics may not be available for smaller accounts
      continue;
    }
  }

  return result;
}

/**
 * Fetch comments on a specific media post.
 */
export async function fetchMediaComments(
  mediaId: string,
  accessToken: string,
  limit = 50,
): Promise<
  Array<{ id: string; text: string; timestamp: string; username: string }>
> {
  try {
    const res = await axios.get(`${FB_GRAPH_BASE}/${mediaId}/comments`, {
      params: {
        fields: "id,text,timestamp,username",
        limit,
        access_token: accessToken,
      },
      timeout: 10000,
    });

    return res.data?.data || [];
  } catch {
    return [];
  }
}

/**
 * Extract hashtags from caption text.
 */
function extractHashtags(caption: string): string[] {
  if (!caption) return [];
  const matches = caption.match(/#\w+/g) || [];
  return matches.map((h) => h.toLowerCase().replace("#", ""));
}

/**
 * Compute aggregate stats from media array.
 */
function computeStats(
  media: IGMedia[],
  insights: IGMediaInsights[],
): IGFullAnalytics["computedStats"] {
  if (!media.length) {
    return {
      avgLikes: 0,
      avgComments: 0,
      avgEngagementRate: 0,
      avgImpressions: 0,
      avgReach: 0,
      avgSaved: 0,
      topHashtags: [],
      postingFrequency: "unknown",
      bestPostType: "unknown",
      reelCount: 0,
      imageCount: 0,
      carouselCount: 0,
      totalPostsAnalyzed: 0,
    };
  }

  const insightMap = new Map(insights.map((i) => [i.id, i]));

  const totalLikes = media.reduce((s, m) => s + (m.like_count || 0), 0);
  const totalComments = media.reduce((s, m) => s + (m.comments_count || 0), 0);
  const totalImpressions = insights.reduce(
    (s, i) => s + (i.impressions || 0),
    0,
  );
  const totalReach = insights.reduce((s, i) => s + (i.reach || 0), 0);
  const totalSaved = insights.reduce((s, i) => s + (i.saved || 0), 0);

  const avgLikes = Math.round(totalLikes / media.length);
  const avgComments = Math.round(totalComments / media.length);
  const avgImpressions = insights.length
    ? Math.round(totalImpressions / insights.length)
    : 0;
  const avgReach = insights.length
    ? Math.round(totalReach / insights.length)
    : 0;
  const avgSaved = insights.length
    ? Math.round(totalSaved / insights.length)
    : 0;

  // Engagement rate = (likes + comments) / followers — computed at call site
  // Here we use per-post engagement relative to reach
  const avgEngagementRate =
    avgReach > 0
      ? parseFloat((((avgLikes + avgComments) / avgReach) * 100).toFixed(2))
      : 0;

  // Top hashtags
  const hashtagCounts: Record<string, number> = {};
  for (const m of media) {
    for (const tag of extractHashtags(m.caption || "")) {
      hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
    }
  }
  const topHashtags = Object.entries(hashtagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag]) => tag);

  // Post type counts
  const reelCount = media.filter(
    (m) => m.media_type === "REELS" || m.media_product_type === "REELS",
  ).length;
  const carouselCount = media.filter(
    (m) => m.media_type === "CAROUSEL_ALBUM",
  ).length;
  const imageCount = media.filter((m) => m.media_type === "IMAGE").length;

  // Best post type by avg likes
  const typePerformance: Record<string, { totalLikes: number; count: number }> =
    {};
  for (const m of media) {
    const t = m.media_type || "IMAGE";
    if (!typePerformance[t]) typePerformance[t] = { totalLikes: 0, count: 0 };
    typePerformance[t].totalLikes += m.like_count || 0;
    typePerformance[t].count += 1;
  }
  const bestPostType =
    Object.entries(typePerformance).sort(
      (a, b) => b[1].totalLikes / b[1].count - a[1].totalLikes / a[1].count,
    )[0]?.[0] || "IMAGE";

  // Posting frequency
  let postingFrequency = "unknown";
  if (media.length >= 2) {
    const oldest = new Date(media[media.length - 1].timestamp);
    const newest = new Date(media[0].timestamp);
    const daySpan = Math.max(
      1,
      (newest.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24),
    );
    const postsPerWeek = (media.length / daySpan) * 7;
    if (postsPerWeek >= 7) postingFrequency = "daily";
    else if (postsPerWeek >= 4) postingFrequency = "5x/week";
    else if (postsPerWeek >= 2) postingFrequency = "3x/week";
    else if (postsPerWeek >= 1) postingFrequency = "1x/week";
    else postingFrequency = "less than weekly";
  }

  return {
    avgLikes,
    avgComments,
    avgEngagementRate,
    avgImpressions,
    avgReach,
    avgSaved,
    topHashtags,
    postingFrequency,
    bestPostType,
    reelCount,
    imageCount,
    carouselCount,
    totalPostsAnalyzed: media.length,
  };
}

/**
 * Full analytics fetch — profile + media + insights + demographics.
 * This is the main entry point for profile.service.ts.
 */
export async function fetchFullIGAnalytics(
  igUserId: string,
  accessToken: string,
  mediaLimit = 25,
): Promise<IGFullAnalytics> {
  // Fetch profile + recent media in parallel
  const [profileData, recentMedia] = await Promise.all([
    fetchIGProfile(igUserId, accessToken),
    fetchRecentMedia(igUserId, accessToken, mediaLimit),
  ]);

  // Fetch media insights in batches of 5 (respect rate limits)
  const mediaInsights: IGMediaInsights[] = [];
  const batchSize = 5;

  for (let i = 0; i < Math.min(recentMedia.length, 20); i += batchSize) {
    const batch = recentMedia.slice(i, i + batchSize);
    const batchInsights = await Promise.all(
      batch.map((m) => fetchMediaInsights(m.id, m.media_type, accessToken)),
    );
    mediaInsights.push(...batchInsights);

    // Small delay to avoid rate limiting
    if (i + batchSize < recentMedia.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Fetch account insights + demographics in parallel (non-fatal)
  const [accountInsights, demographics] = await Promise.allSettled([
    fetchAccountInsights(igUserId, accessToken, "month"),
    fetchAudienceDemographics(igUserId, accessToken),
  ]).then((results) => [
    results[0].status === "fulfilled" ? results[0].value : {},
    results[1].status === "fulfilled" ? results[1].value : {},
  ]);

  const computedStats = computeStats(recentMedia, mediaInsights);

  // Override engagementRate with followers-based calculation if we have it
  if (profileData.followers_count && profileData.followers_count > 0) {
    const engRate =
      ((computedStats.avgLikes + computedStats.avgComments) /
        profileData.followers_count) *
      100;
    computedStats.avgEngagementRate = parseFloat(engRate.toFixed(2));
  }

  return {
    profile: profileData as InstagramUserProfile,
    recentMedia,
    mediaInsights,
    accountInsights: accountInsights as IGAccountInsights,
    demographics: demographics as IGAudienceDemographics,
    computedStats,
  };
}

/**
 * Build the token JSON blob to store in account_connections.encrypted_token.
 * Always store this structure so getValidInstagramToken can parse it.
 */
export function buildTokenPayload(opts: {
  pageToken: string;
  userToken: string;
  pageId: string;
  igUserId: string;
}): string {
  return JSON.stringify({
    page_token: opts.pageToken,
    user_token: opts.userToken,
    page_id: opts.pageId,
    ig_user_id: opts.igUserId,
  });
}
