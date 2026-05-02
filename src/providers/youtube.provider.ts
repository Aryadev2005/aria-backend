/**
 * ARIA — YouTube OAuth Provider
 * Extracted and adapted from Postiz (AGPL-3.0)
 * Uses the `googleapis` npm package — install: npm install googleapis
 */

import { google } from 'googleapis';

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

function makeYouTubeOAuthClient(redirectUri: string) {
  return new google.auth.OAuth2({
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri,
  });
}

function getRedirectUri(): string {
  return `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/v1/integrations/youtube/callback`;
}

export function generateYouTubeAuthUrl(
  userId: string,
  flow: "register" | "onboarding" | "dashboard" = "dashboard",
): string {
  const client = makeYouTubeOAuthClient(getRedirectUri());
  const state = Buffer.from(
    JSON.stringify({ userId, ts: Date.now(), flow }),
  ).toString("base64");
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: YOUTUBE_SCOPES,
    state,
    redirect_uri: getRedirectUri(),
  });
}

export interface YouTubeTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  expiresAt: Date;
}

export async function exchangeYouTubeCode(code: string): Promise<YouTubeTokenResult> {
  const client = makeYouTubeOAuthClient(getRedirectUri());
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new Error('YouTube token exchange returned no access_token');
  const expiresIn = tokens.expiry_date ? Math.floor((tokens.expiry_date - Date.now()) / 1000) : 3600;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    expiresIn,
    expiresAt: new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
  };
}

export interface YouTubeChannelInfo {
  channelId: string;
  handle: string;
  channelName: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
  thumbnailUrl: string;
  description: string;
}

export async function getYouTubeChannelInfo(accessToken: string): Promise<YouTubeChannelInfo> {
  const client = makeYouTubeOAuthClient(getRedirectUri());
  client.setCredentials({ access_token: accessToken });
  const youtube = google.youtube({ version: 'v3', auth: client });
  const res = await youtube.channels.list({ part: ['snippet', 'statistics'], mine: true });
  const channel = res.data.items?.[0];
  if (!channel) throw new Error('No YouTube channel found for this account');
  const stats = channel.statistics || {};
  return {
    channelId: channel.id || '',
    handle: channel.snippet?.customUrl || channel.snippet?.title || '',
    channelName: channel.snippet?.title || '',
    subscriberCount: parseInt(stats.subscriberCount || '0'),
    videoCount: parseInt(stats.videoCount || '0'),
    viewCount: parseInt(stats.viewCount || '0'),
    thumbnailUrl: channel.snippet?.thumbnails?.default?.url || '',
    description: channel.snippet?.description?.slice(0, 300) || '',
  };
}

export async function refreshYouTubeToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const client = makeYouTubeOAuthClient(getRedirectUri());
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  if (!credentials.access_token) throw new Error('YouTube token refresh returned no access_token');
  return {
    accessToken: credentials.access_token,
    expiresAt: new Date(credentials.expiry_date || Date.now() + 3600 * 1000),
  };
}

export function isTokenExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - 5 * 60 * 1000 < Date.now();
}

export async function getValidYouTubeToken(
  decryptedTokenPayload: string,
  tokenExpiresAt: Date | null,
  onRefreshed?: (newToken: string, newExpiresAt: Date) => Promise<void>
): Promise<string> {
  const payload = JSON.parse(decryptedTokenPayload) as { access_token: string; refresh_token: string };
  if (!isTokenExpired(tokenExpiresAt)) return payload.access_token;
  if (!payload.refresh_token) throw new Error('YouTube token expired and no refresh_token — user must reconnect');
  const { accessToken, expiresAt } = await refreshYouTubeToken(payload.refresh_token);
  if (onRefreshed) {
    await onRefreshed(JSON.stringify({ access_token: accessToken, refresh_token: payload.refresh_token }), expiresAt);
  }
  return accessToken;
}

export async function revokeYouTubeToken(accessToken: string): Promise<void> {
  const client = makeYouTubeOAuthClient(getRedirectUri());
  client.setCredentials({ access_token: accessToken });
  await client.revokeCredentials();
}
