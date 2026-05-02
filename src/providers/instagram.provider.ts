import type { FastifyRequest } from 'fastify';
import { logger } from '../utils/logger';

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

/** Where the user started OAuth — drives post-callback redirect (avoid DB fields missing from client). */
export type InstagramOAuthClientFlow = 'register' | 'settings' | 'onboarding';

const IG_AUTH_URL = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const IG_LONG_LIVED_TOKEN_URL = 'https://graph.instagram.com/access_token';
const IG_GRAPH_BASE = 'https://graph.instagram.com/v25.0';

const DEFAULT_CALLBACK_PATH = '/api/v1/integrations/instagram/callback';

/**
 * Meta may append `#_` to the redirect; strip fragments from the code query value.
 * @see https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
 */
export function sanitizeInstagramAuthCode(code: string): string {
  let c = String(code ?? '').trim();
  const hash = c.indexOf('#');
  if (hash >= 0) c = c.slice(0, hash);
  return c.trim();
}

/**
 * Redirect URI sent to Instagram must match **exactly** one entry under
 * App Dashboard → Instagram → API setup → Business login → OAuth redirect URIs
 * (Meta may add a trailing slash — copy the URI from the dashboard verbatim into env).
 */
export function getInstagramRedirectUri(): string {
  const explicit =
    process.env.INSTAGRAM_REDIRECT_URI?.trim() || process.env.INSTAGRAM_REDIRECT_URL?.trim();
  if (explicit) return explicit;

  const base = (
    process.env.BACKEND_PUBLIC_URL?.trim() ||
    process.env.BACKEND_URL?.trim() ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');

  return `${base}${DEFAULT_CALLBACK_PATH}`;
}

/**
 * Instagram returns `state` in the query string; some parsers treat base64 `+` as space,
 * which corrupts decoding.
 */
export function normalizeInstagramOAuthStateParam(state: string | undefined): string {
  if (!state) return '';
  const trimmed = state.trim();
  if (!trimmed) return '';
  if (/\s/.test(trimmed) && !/[+]/.test(trimmed)) {
    return trimmed.replace(/\s/g, '+');
  }
  return trimmed;
}

/** New flows use base64url; legacy in-flight OAuth may still use base64. */
export function decodeInstagramOAuthState(state: string): Record<string, unknown> {
  const trimmed = normalizeInstagramOAuthStateParam(state);
  if (!trimmed) throw new Error('Empty OAuth state');
  for (const enc of ['base64url', 'base64'] as const) {
    try {
      const raw = Buffer.from(trimmed, enc).toString('utf8');
      if (!raw.startsWith('{')) continue;
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  throw new Error('Invalid OAuth state');
}

/**
 * Use the exact callback URL the browser hit (after Meta's redirect) as `redirect_uri` in the
 * token POST. It must match the `redirect_uri` sent in the authorize request character-for-character
 * from Meta's perspective; building from the incoming request avoids env/state drift behind proxies.
 */
export function buildInstagramRedirectUriFromCallbackRequest(req: FastifyRequest): string {
  const pathOnly = (req.url || '').split('?')[0] || DEFAULT_CALLBACK_PATH;
  const xfProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const xfHost = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim();
  const protocol = xfProto || req.protocol || 'https';
  const host = xfHost || (req.headers.host as string | undefined)?.split(',')[0]?.trim() || '';
  if (!host) return getInstagramRedirectUri();
  return `${protocol}://${host}${pathOnly}`;
}

/** Same host + pathname (ignoring trailing slash on path) — safe gate for auth_ru from state. */
function instagramRedirectSameEndpoint(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const pa = (ua.pathname.replace(/\/+$/, '') || '/') as string;
    const pb = (ub.pathname.replace(/\/+$/, '') || '/') as string;
    return ua.host === ub.host && pa === pb;
  } catch {
    return false;
  }
}

/**
 * Token POST redirect_uri must match the authorize URL exactly. Prefer the string stored in state
 * when /integrations/instagram/auth-url ran (same bytes as redirect_uri=… on Instagram).
 */
export function pickInstagramOAuthRedirectUri(
  req: FastifyRequest | undefined,
  authorizeRedirectFromState: unknown,
): string {
  const configured = getInstagramRedirectUri();
  const fromState =
    typeof authorizeRedirectFromState === 'string' ? authorizeRedirectFromState.trim() : '';

  if (fromState) {
    try {
      const u = new URL(fromState);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
      if (instagramRedirectSameEndpoint(fromState, configured)) {
        logger.info(
          { redirectSample: `${fromState.slice(0, 24)}…`, len: fromState.length },
          'Instagram token exchange using redirect_uri from OAuth state',
        );
        return fromState;
      }
    } catch {
      /* invalid URL */
    }
    logger.warn(
      { fromState, configured },
      'Instagram OAuth state auth_ru invalid or wrong host/path — falling back to configured redirect_uri',
    );
  }

  if (req) {
    const fromCb = buildInstagramRedirectUriFromCallbackRequest(req);
    if (instagramRedirectSameEndpoint(fromCb, configured)) {
      try {
        const uc = new URL(configured);
        const ub = new URL(fromCb);
        if (uc.protocol !== ub.protocol) {
          logger.warn(
            { fromCb, configured },
            'Callback URL scheme differs from configured (fix X-Forwarded-Proto) — using configured redirect_uri for token',
          );
          return configured;
        }
      } catch {
        return configured;
      }
      logger.info(
        { redirectSample: `${fromCb.slice(0, 24)}…`, len: fromCb.length },
        'Instagram token exchange using redirect_uri from inbound callback URL',
      );
      return fromCb;
    }
  }

  return configured;
}

export function generateInstagramAuthUrl(
  userId: string,
  clientFlow: InstagramOAuthClientFlow = 'settings',
  /** SPA origin for post-OAuth browser redirect (allowlisted). */
  frontendBase = 'http://localhost:5173',
): string {
  if (!process.env.INSTAGRAM_APP_ID) {
    throw new Error('INSTAGRAM_APP_ID is not set in environment variables');
  }
  const redirectUri = getInstagramRedirectUri();
  const fe = frontendBase.trim().replace(/\/+$/, '');
  // base64url avoids `+` / `/` in query strings (some stacks mishandle `+` as space).
  // auth_ru = exact redirect_uri sent on authorize (token POST must match byte-for-byte).
  const state = Buffer.from(
    JSON.stringify({ userId, ts: Date.now(), flow: clientFlow, fe, auth_ru: redirectUri }),
  ).toString('base64url');
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    redirect_uri: redirectUri,
    scope: 'instagram_business_basic',
    response_type: 'code',
    state,
  });
  return `${IG_AUTH_URL}?${params.toString()}`;
}

export async function completeInstagramOAuth(
  code: string,
  req?: FastifyRequest,
  authorizeRedirectFromState?: unknown,
): Promise<InstagramOAuthResult> {
  if (!process.env.INSTAGRAM_APP_ID || !process.env.INSTAGRAM_APP_SECRET) {
    throw new Error('INSTAGRAM credentials missing');
  }

  const configuredRedirect = getInstagramRedirectUri();
  const tokenRedirectUri = pickInstagramOAuthRedirectUri(req, authorizeRedirectFromState ?? undefined);
  const cleanCode = sanitizeInstagramAuthCode(code);

  if (req) {
    const fromCallback = buildInstagramRedirectUriFromCallbackRequest(req);
    if (fromCallback !== configuredRedirect && fromCallback !== tokenRedirectUri) {
      logger.warn(
        { configuredRedirect, fromCallback, tokenRedirectUri, hint: 'INSTAGRAM_REDIRECT_URL should match tunnel callback URL' },
        'Instagram callback URL differs from configured / token redirect_uri',
      );
    }
  }

  /** Short-lived exchange first; long-lived uses graph.instagram.com. Env INSTAGRAM_ACCESS_TOKEN is not used here. */
  const postBody = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    client_secret: process.env.INSTAGRAM_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: tokenRedirectUri,
    code: cleanCode,
  });

  let shortLivedRes = await fetch(IG_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: postBody,
  });
  let rawData = (await shortLivedRes.json()) as any;
  let shortLived = rawData.data && Array.isArray(rawData.data) ? rawData.data[0] : rawData;

  const redirectRelatedFailure = (raw: any) => {
    const t = JSON.stringify(raw).toLowerCase();
    return t.includes('redirect_uri') || t.includes('verification code');
  };

  if ((!shortLived || !shortLived.access_token) && redirectRelatedFailure(rawData)) {
    const form = new FormData();
    form.set('client_id', process.env.INSTAGRAM_APP_ID!);
    form.set('client_secret', process.env.INSTAGRAM_APP_SECRET!);
    form.set('grant_type', 'authorization_code');
    form.set('redirect_uri', tokenRedirectUri);
    form.set('code', cleanCode);
    logger.warn('Instagram token exchange retry with multipart/form-data (same redirect_uri)');
    shortLivedRes = await fetch(IG_TOKEN_URL, { method: 'POST', body: form });
    rawData = (await shortLivedRes.json()) as any;
    shortLived = rawData.data && Array.isArray(rawData.data) ? rawData.data[0] : rawData;
  }

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
