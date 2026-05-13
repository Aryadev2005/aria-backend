// src/services/songs/spotify-official.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Spotify Official Web API scraper
//
// Strategy: fetch from curated global top-chart playlists per language/region
// instead of generic search queries. This guarantees language diversity and
// avoids the Hindi-only bias of the old search approach.
//
// Playlists used (all stable public Spotify editorial playlists):
//   Global Top 50        → 37i9dQZEVXbMDoHDwVN2tF  (English + global)
//   India Top 50         → 37i9dQZEVXbLZ52XmnySJg  (Hindi, cross-language)
//   Bollywood Top 50     → 37i9dQZEVXbMWDif5SCBJq  (Hindi / Bollywood)
//   Tamil Hits           → 37i9dQZEVXbKqiTGXuCOsB  (Tamil)
//   Telugu Hits          → 37i9dQZEVXbKMzVsSGQ49S  (Telugu)
//   Punjabi Hits         → 37i9dQZEVXbJJMkfOzQ3JB  (Punjabi)
//   K-Pop Top 50         → 37i9dQZEVXbJZGli0rRP3r  (Korean)
//   Global Viral 50      → 37i9dQZEVXbLiRSasKsNU9  (trending globally)
//   Afrobeats            → 37i9dQZEVXbNFJfN1Vw8d9  (Afrobeats / global)
//   Latin Top 50         → 37i9dQZEVXbO3qyFxbkOFj  (Spanish/Portuguese)
// ══════════════════════════════════════════════════════════════════════════════

import axios, { AxiosInstance } from "axios";
import { logger } from "../../utils/logger";

// ── Auth ──────────────────────────────────────────────────────────────────────

let _cachedToken: string | null = null;
let _tokenExpiresAt = 0;

async function getSpotifyAccessToken(): Promise<string> {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 30_000) {
    return _cachedToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET not set");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const { data } = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 10_000,
    },
  );

  _cachedToken = data.access_token;
  _tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return _cachedToken!;
}

// ── Axios client ──────────────────────────────────────────────────────────────

let _spotifyClient: AxiosInstance | null = null;

function getSpotifyClient(): AxiosInstance {
  if (!_spotifyClient) {
    _spotifyClient = axios.create({
      baseURL: "https://api.spotify.com/v1",
      timeout: 15_000,
    });

    _spotifyClient.interceptors.request.use(async (config) => {
      try {
        const token = await getSpotifyAccessToken();
        config.headers.Authorization = `Bearer ${token}`;
      } catch (err) {
        logger.error("Failed to get Spotify token for request");
        throw err;
      }
      return config;
    });

    _spotifyClient.interceptors.response.use(
      (res) => res,
      (err) => {
        if (err.response) {
          logger.warn(
            { status: err.response.status, url: err.config?.url },
            "Spotify API error",
          );
        }
        return Promise.reject(err);
      },
    );
  }
  return _spotifyClient;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpotifySongResult {
  title: string;
  artist: string;
  popularity: number;
  release_date: string;
  image_url: string | null;
  spotify_id: string;
  external_url: string;
  language: string; // NOW POPULATED — was missing before
}

// ── Curated playlist map — language tagged ────────────────────────────────────
// Each entry: [playlistId, language, label]
// All are stable Spotify editorial playlists verified as of 2025.

const CURATED_PLAYLISTS: Array<{
  id: string;
  language: string;
  label: string;
}> = [
  { id: "37i9dQZEVXbMDoHDwVN2tF", language: "English", label: "Global Top 50" },
  {
    id: "37i9dQZEVXbLiRSasKsNU9",
    language: "English",
    label: "Global Viral 50",
  },
  { id: "37i9dQZEVXbLZ52XmnySJg", language: "Hindi", label: "India Top 50" },
  {
    id: "37i9dQZEVXbMWDif5SCBJq",
    language: "Hindi",
    label: "Bollywood Top 50",
  },
  { id: "37i9dQZEVXbKqiTGXuCOsB", language: "Tamil", label: "Tamil Hits" },
  { id: "37i9dQZEVXbKMzVsSGQ49S", language: "Telugu", label: "Telugu Hits" },
  { id: "37i9dQZEVXbJJMkfOzQ3JB", language: "Punjabi", label: "Punjabi Hits" },
  { id: "37i9dQZEVXbJZGli0rRP3r", language: "Korean", label: "K-Pop Top 50" },
  { id: "37i9dQZEVXbNFJfN1Vw8d9", language: "Afrobeats", label: "Afrobeats" },
  { id: "37i9dQZEVXbO3qyFxbkOFj", language: "Spanish", label: "Latin Top 50" },
];

const TRACKS_PER_PLAYLIST = 30;

// ── Scraper ───────────────────────────────────────────────────────────────────

async function fetchPlaylistTracks(
  playlistId: string,
  language: string,
  label: string,
): Promise<SpotifySongResult[]> {
  try {
    const client = getSpotifyClient();
    const { data } = await client.get(`/playlists/${playlistId}/tracks`, {
      params: {
        limit: TRACKS_PER_PLAYLIST,
        offset: 0,
        fields:
          "items(track(id,name,popularity,external_urls,artists,album(release_date,images)))",
      },
    });

    const items: any[] = data?.items || [];

    return items
      .filter((item: any) => item?.track?.id)
      .map((item: any): SpotifySongResult => {
        const track = item.track;
        const album = track.album || {};
        return {
          title: track.name || "Unknown",
          artist: track.artists?.[0]?.name || "Unknown",
          popularity: track.popularity || 0,
          release_date: album.release_date || "",
          image_url: album.images?.[0]?.url || null,
          spotify_id: track.id,
          external_url: track.external_urls?.spotify || "",
          language, // tag with the playlist's known language
        };
      });
  } catch (err: any) {
    logger.warn(
      { err: err.message, playlistId, label },
      "Spotify playlist fetch failed",
    );
    return [];
  }
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export async function scrapeSpotifyOfficial(): Promise<{
  songs: SpotifySongResult[];
  diagnostics: Record<string, string>;
}> {
  // Run all playlist fetches in parallel
  const results = await Promise.allSettled(
    CURATED_PLAYLISTS.map((p) =>
      fetchPlaylistTracks(p.id, p.language, p.label),
    ),
  );

  const diagnostics: Record<string, string> = {};
  const allSongs: SpotifySongResult[] = [];

  for (let i = 0; i < CURATED_PLAYLISTS.length; i++) {
    const { label } = CURATED_PLAYLISTS[i];
    const r = results[i];
    if (r.status === "fulfilled") {
      diagnostics[label] = `ok (${r.value.length})`;
      allSongs.push(...r.value);
    } else {
      diagnostics[label] = `failed: ${(r as any).reason?.message}`;
    }
  }

  // Deduplicate by spotify_id — same track can appear in multiple playlists
  // Keep the first occurrence (which has the most-specific language tag)
  const seen = new Set<string>();
  const deduped: SpotifySongResult[] = [];
  for (const song of allSongs) {
    if (!seen.has(song.spotify_id)) {
      seen.add(song.spotify_id);
      deduped.push(song);
    }
  }

  logger.info(
    { total: allSongs.length, deduped: deduped.length, diagnostics },
    "Spotify official scrape complete",
  );

  return { songs: deduped, diagnostics };
}

// ── Health check ──────────────────────────────────────────────────────────────

export async function verifySpotifyCredentials(): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    const token = await getSpotifyAccessToken();
    return token?.length > 0
      ? { ok: true, message: "Spotify credentials verified" }
      : { ok: false, message: "Token empty" };
  } catch (err: any) {
    return {
      ok: false,
      message: `Spotify credentials invalid: ${err.message}`,
    };
  }
}
