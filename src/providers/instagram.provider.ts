export interface InstagramUserProfile {
  user_id: string;
  username: string;
  followers_count: number;
}

export interface InstagramOAuthResult {
  accessToken: string;
  expiresAt: Date;
  profile: InstagramUserProfile;
  permissions?: any;
}

const IG_AUTH_URL = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const IG_LONG_LIVED_TOKEN_URL = 'https://graph.instagram.com/access_token';
const IG_GRAPH_BASE = 'https://graph.instagram.com/v25.0';

function getRedirectUri(): string {
  const base = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/api/v1/integrations/instagram/callback`;
}

export function generateInstagramAuthUrl(userId: string): string {
  if (!process.env.INSTAGRAM_APP_ID) {
    throw new Error('INSTAGRAM_APP_ID is not set in environment variables');
  }
  const state = Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString('base64');
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    redirect_uri: getRedirectUri(),
    scope: 'instagram_business_basic',
    response_type: 'code',
    state,
  });
  return `${IG_AUTH_URL}?${params.toString()}`;
}

export async function completeInstagramOAuth(code: string): Promise<InstagramOAuthResult> {
  if (!process.env.INSTAGRAM_APP_ID || !process.env.INSTAGRAM_APP_SECRET) {
    throw new Error('INSTAGRAM credentials missing');
  }

  // 1. Code exchange
  const shortLivedRes = await fetch(IG_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID,
      client_secret: process.env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: getRedirectUri(),
      code,
    }),
  });
  
  const rawData = await shortLivedRes.json() as any;
  const shortLived = (rawData.data && Array.isArray(rawData.data)) ? rawData.data[0] : rawData;
  
  if (!shortLived || !shortLived.access_token) {
    throw new Error(`Code exchange failed: ${JSON.stringify(rawData)}`);
  }
  
  const shortAccessToken = shortLived.access_token;

  // 2. Long-lived token
  const llParams = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: process.env.INSTAGRAM_APP_SECRET,
    access_token: shortAccessToken,
  });
  
  const llRes = await fetch(`${IG_LONG_LIVED_TOKEN_URL}?${llParams.toString()}`);
  const llData = await llRes.json() as any;
  
  if (llData.error) {
    throw new Error(`Long-lived exchange failed: ${llData.error.message || JSON.stringify(llData.error)}`);
  }
  
  const longAccessToken = llData.access_token;
  const expiresIn = llData.expires_in || 5184000; // default 60 days
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  // 3. Get profile
  const profileParams = new URLSearchParams({
    fields: 'id,username,followers_count',
    access_token: longAccessToken,
  });
  
  const profileRes = await fetch(`${IG_GRAPH_BASE}/me?${profileParams.toString()}`);
  const profileData = await profileRes.json() as any;
  
  if (profileData.error) {
    throw new Error(`Profile fetch failed: ${profileData.error.message}`);
  }

  return {
    accessToken: longAccessToken,
    expiresAt,
    profile: {
      user_id: String(profileData.id),
      username: profileData.username || '',
      followers_count: profileData.followers_count || 0,
    },
    permissions: shortLived.permissions || null,
  };
}

export function instagramTokenIsExpired(tokenExpiresAt: Date | null): boolean {
  if (!tokenExpiresAt) return false;
  return tokenExpiresAt.getTime() < Date.now();
}

export function instagramTokenNeedsRefresh(tokenExpiresAt: Date | null): boolean {
  if (!tokenExpiresAt) return false;
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
  return tokenExpiresAt.getTime() < Date.now() + tenDaysMs;
}

export async function refreshInstagramToken(longLivedToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const params = new URLSearchParams({
    grant_type: 'ig_refresh_token',
    access_token: longLivedToken,
  });
  const res = await fetch(`${IG_LONG_LIVED_TOKEN_URL}?${params.toString()}`);
  const data = await res.json() as any;
  
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error.message}`);
  }
  
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + (data.expires_in || 5184000) * 1000),
  };
}

export async function getValidInstagramToken(
  storedToken: string,
  tokenExpiresAt: Date | null,
  onRefreshed?: (newToken: string, newExpiresAt: Date) => Promise<void>
): Promise<string> {
  if (instagramTokenIsExpired(tokenExpiresAt)) {
    throw new Error('Instagram token expired');
  }
  if (instagramTokenNeedsRefresh(tokenExpiresAt)) {
    const { accessToken, expiresAt } = await refreshInstagramToken(storedToken);
    if (onRefreshed) await onRefreshed(accessToken, expiresAt);
    return accessToken;
  }
  return storedToken;
}

export async function getInstagramRecentMedia(
  accessToken: string,
  igUserId: string,
  limit = 12
): Promise<any[]> {
  const params = new URLSearchParams({
    fields: 'id,caption,media_type,timestamp,permalink',
    limit: String(limit),
    access_token: accessToken,
  });
  
  const res = await fetch(`${IG_GRAPH_BASE}/${igUserId}/media?${params.toString()}`);
  const data = await res.json() as any;
  
  if (data.error || !data.data) return [];
  
  return (data.data as any[]).map(item => ({
    id: item.id || '',
    caption: item.caption || '',
    mediaType: item.media_type || '',
    timestamp: item.timestamp || '',
    permalink: item.permalink || '',
  }));
}
