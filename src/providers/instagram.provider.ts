/**
 * ARIA — Instagram OAuth Provider
 * Extracted and adapted from Postiz (AGPL-3.0)
 * Uses Instagram Graph API via Facebook OAuth — no SDK needed
 */

const INSTAGRAM_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
].join(',');

const FB_OAUTH_BASE = 'https://www.facebook.com/v18.0/dialog/oauth';
const FB_TOKEN_URL = 'https://graph.facebook.com/v18.0/oauth/access_token';
const IG_GRAPH_BASE = 'https://graph.instagram.com';

function getRedirectUri(): string {
  return `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/v1/integrations/instagram/callback`;
}

export function generateInstagramAuthUrl(userId: string): string {
  const state = Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString('base64');
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID!,
    redirect_uri: getRedirectUri(),
    scope: INSTAGRAM_SCOPES,
    response_type: 'code',
    state,
  });
  return `${FB_OAUTH_BASE}?${params.toString()}`;
}

export async function exchangeInstagramCode(code: string): Promise<{ access_token: string; user_id?: string }> {
  const res = await fetch(FB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID!,
      client_secret: process.env.INSTAGRAM_APP_SECRET!,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(),
      code,
    }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(`Instagram code exchange failed: ${data.error.message || JSON.stringify(data.error)}`);
  return data;
}

export async function exchangeToLongLivedToken(shortLivedToken: string): Promise<{ access_token: string; expires_in: number }> {
  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: process.env.INSTAGRAM_APP_SECRET!,
    access_token: shortLivedToken,
  });
  const res = await fetch(`${IG_GRAPH_BASE}/access_token?${params.toString()}`);
  const data = await res.json() as any;
  if (data.error) throw new Error(`Long-lived token exchange failed: ${data.error.message}`);
  return data;
}

export interface InstagramProfile {
  igUserId: string;
  username: string;
  accountType: string;
  mediaCount: number;
}

export async function getInstagramProfile(accessToken: string): Promise<InstagramProfile> {
  const params = new URLSearchParams({
    fields: 'id,username,account_type,media_count',
    access_token: accessToken,
  });
  const res = await fetch(`${IG_GRAPH_BASE}/me?${params.toString()}`);
  const data = await res.json() as any;
  if (data.error) throw new Error(`Instagram profile fetch failed: ${data.error.message}`);
  return { igUserId: data.id, username: data.username || '', accountType: data.account_type || 'UNKNOWN', mediaCount: data.media_count || 0 };
}

export async function refreshInstagramToken(longLivedToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: longLivedToken });
  const res = await fetch(`${IG_GRAPH_BASE}/refresh_access_token?${params.toString()}`);
  const data = await res.json() as any;
  if (data.error) throw new Error(`Instagram token refresh failed: ${data.error.message}`);
  return { accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000) };
}

export function instagramTokenNeedsRefresh(tokenExpiresAt: Date | null): boolean {
  if (!tokenExpiresAt) return false;
  return tokenExpiresAt.getTime() < Date.now() + 10 * 24 * 60 * 60 * 1000;
}

export function instagramTokenIsExpired(tokenExpiresAt: Date | null): boolean {
  if (!tokenExpiresAt) return false;
  return tokenExpiresAt.getTime() < Date.now();
}

export async function getValidInstagramToken(
  storedToken: string,
  tokenExpiresAt: Date | null,
  onRefreshed?: (newToken: string, newExpiresAt: Date) => Promise<void>
): Promise<string> {
  if (instagramTokenIsExpired(tokenExpiresAt)) throw new Error('Instagram token expired — user must reconnect');
  if (instagramTokenNeedsRefresh(tokenExpiresAt)) {
    const { accessToken, expiresAt } = await refreshInstagramToken(storedToken);
    if (onRefreshed) await onRefreshed(accessToken, expiresAt);
    return accessToken;
  }
  return storedToken;
}

export interface InstagramOAuthResult {
  accessToken: string;
  expiresAt: Date;
  profile: InstagramProfile;
}

export async function completeInstagramOAuth(code: string): Promise<InstagramOAuthResult> {
  const shortLived = await exchangeInstagramCode(code);
  const longLived = await exchangeToLongLivedToken(shortLived.access_token);
  const profile = await getInstagramProfile(longLived.access_token);
  return { accessToken: longLived.access_token, expiresAt: new Date(Date.now() + longLived.expires_in * 1000), profile };
}

export async function getInstagramRecentMedia(accessToken: string, limit = 12): Promise<any[]> {
  const params = new URLSearchParams({
    fields: 'id,caption,media_type,timestamp,like_count,comments_count,permalink',
    limit: String(limit),
    access_token: accessToken,
  });
  const res = await fetch(`${IG_GRAPH_BASE}/me/media?${params.toString()}`);
  const data = await res.json() as any;
  if (data.error) return [];
  return (data.data || []).map((item: any) => ({
    id: item.id, caption: item.caption || '', mediaType: item.media_type || '',
    timestamp: item.timestamp || '', likeCount: item.like_count || 0,
    commentsCount: item.comments_count || 0, permalink: item.permalink || '',
  }));
}
