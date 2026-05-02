import type { FastifyRequest } from 'fastify';

function trimBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function originFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Origins allowed to receive OAuth return redirects (must match where the SPA is actually opened). */
function collectAllowedFrontendOrigins(): Set<string> {
  const allow = new Set<string>();
  for (const raw of [process.env.FRONTEND_PUBLIC_URL, process.env.FRONTEND_URL]) {
    const o = originFromUrl(raw?.trim() || '');
    if (o) allow.add(o);
  }
  for (const part of (process.env.ALLOWED_ORIGINS || '').split(',')) {
    const o = originFromUrl(part.trim());
    if (o) allow.add(o);
  }
  return allow;
}

export function isAllowedOAuthFrontendOrigin(originOrBase: string): boolean {
  const origin = originFromUrl(trimBase(originOrBase)) || originFromUrl(originOrBase.trim());
  if (!origin) return false;
  return collectAllowedFrontendOrigins().has(origin);
}

/**
 * Base URL for the SPA when building OAuth return redirects (where the user’s browser should land).
 * Prefer FRONTEND_PUBLIC_URL only when the SPA is served on a public origin (e.g. preview URL).
 * If only the API is tunneled and the app is localhost:5173, leave FRONTEND_PUBLIC_URL unset — Origin / FRONTEND_URL will be localhost.
 * Do not set FRONTEND_PUBLIC_URL to the API tunnel; that is not the SPA origin.
 */
export function resolveFrontendBaseForOAuth(req: FastifyRequest): string {
  const envPublic = process.env.FRONTEND_PUBLIC_URL?.trim();
  if (envPublic) return trimBase(envPublic);

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (origin && isAllowedOAuthFrontendOrigin(origin)) return trimBase(origin);

  const fallback = process.env.FRONTEND_URL?.trim() || 'http://localhost:5173';
  return trimBase(fallback);
}

/** Use `fe` from signed OAuth state when it matches allowlist; otherwise fallback. */
export function pickFrontendBaseFromOAuthState(feRaw: unknown, fallback: string): string {
  if (typeof feRaw !== 'string' || !feRaw.trim()) return trimBase(fallback);
  const candidate = trimBase(feRaw);
  const origin = originFromUrl(candidate);
  if (!origin || !isAllowedOAuthFrontendOrigin(origin)) return trimBase(fallback);
  return origin;
}
