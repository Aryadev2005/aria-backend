// src/services/songs/spotify-official.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Spotify Web API Official Integration (Client Credentials OAuth2)
//
// Replaces CSV scraping with reliable official API endpoints:
//   - Featured Playlists (curated trending content)
//   - New Releases (emerging trends)
//   - Search for current year tracks (additional signal)
//
// Token caching via Redis to avoid repeated auth calls.
// ══════════════════════════════════════════════════════════════════════════════

import axios, { AxiosInstance } from "axios";
import { cache } from "../../config/redis";
import { logger } from "../../utils/logger";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";

let _spotifyClient: AxiosInstance | null = null;

// ── Token Management ──────────────────────────────────────────────────────────

interface SpotifyToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

async function getSpotifyAccessToken(): Promise<string> {
  const cacheKey = "spotify:access_token";
  const cached = (await cache.get(cacheKey)) as string | null;
  if (cached) {
    logger.debug("Using cached Spotify access token");
    return cached;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error(
      "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables not set",
    );
  }

  try {
    logger.debug("Requesting new Spotify access token...");

    const { data } = await axios.post<SpotifyToken>(
      SPOTIFY_AUTH_URL,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      },
    );

    const token = data.access_token;
    const ttl = Math.max(60, data.expires_in - 300); // Refresh 5 min before expiry
    await cache.set(cacheKey, token, ttl);

    logger.info({ ttl }, "Spotify access token refreshed successfully");
    return token;
  } catch (err: any) {
    logger.error(
      { err: err.message, status: err.response?.status },
      "Spotify token request failed",
    );
    throw err;
  }
}

function getSpotifyClient(): AxiosInstance {
  if (!_spotifyClient) {
    _spotifyClient = axios.create({
      baseURL: SPOTIFY_API_URL,
      timeout: 15000,
    });

    // Interceptor: inject Bearer token on each request
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

    // Interceptor: log errors
    _spotifyClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response) {
          logger.warn(
            { status: error.response.status, url: error.config?.url },
            "Spotify API error",
          );
        }
        return Promise.reject(error);
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
}

// ── Scraper Functions ─────────────────────────────────────────────────────────

/**
 * Get featured playlists curated by Spotify editors.
 * These often represent current trends and themed playlists.
 */
export async function scrapeFeaturedPlaylists(): Promise<SpotifySongResult[]> {
  if (process.env.SPOTIFY_ENABLE_BROWSE_SOURCES !== "true") {
    logger.info(
      "Spotify featured playlists source disabled; skipping browse endpoint",
    );
    return [];
  }

  try {
    logger.info("Scraping Spotify featured playlists...");
    const client = getSpotifyClient();

    const market = process.env.SPOTIFY_MARKET || "IN";

    const { data } = await client.get("/browse/featured-playlists", {
      params: {
        locale: "hi_IN",
        limit: 20, // Increased from 5 to 20
        offset: 0,
      },
    });

    const playlists = data.playlists?.items || [];
    if (!playlists.length) {
      logger.warn("No featured playlists returned");
      return [];
    }

    const allTracks: SpotifySongResult[] = [];

    // Fetch top tracks from each featured playlist
    for (const playlist of playlists) {
      try {
        const { data: playlistData } = await client.get(
          `/playlists/${playlist.id}/tracks`,
          { params: { limit: 30, market } }, // Increased from 20 to 30
        );

        const tracks = playlistData.items || [];

        allTracks.push(
          ...tracks.map((item: any) => {
            const track = item.track || {};
            const album = track.album || {};

            return {
              title: track.name || "Unknown",
              artist: track.artists?.[0]?.name || "Unknown",
              popularity: track.popularity || 0,
              release_date: album.release_date || "",
              image_url: album.images?.[0]?.url || null,
              spotify_id: track.id || "",
              external_url: track.external_urls?.spotify || "",
            } satisfies SpotifySongResult;
          }),
        );
      } catch (err: any) {
        logger.warn(
          { err: err.message, playlistId: playlist.id },
          "Playlist fetch failed (non-critical)",
        );
      }
    }

    logger.info(
      { count: allTracks.length, playlists: playlists.length },
      "Featured playlists scrape complete",
    );
    return allTracks.slice(0, 100); // Cap at 100
  } catch (err: any) {
    logger.warn({ err: err.message }, "Featured playlists scrape failed");
    return [];
  }
}

/**
 * Get newly released albums/singles in the market.
 * Good for capturing emerging trends early.
 */
export async function scrapeNewReleases(): Promise<SpotifySongResult[]> {
  if (process.env.SPOTIFY_ENABLE_BROWSE_SOURCES !== "true") {
    logger.info(
      "Spotify new releases source disabled; skipping browse endpoint",
    );
    return [];
  }

  try {
    logger.info("Scraping Spotify new releases...");
    const client = getSpotifyClient();

    const market = process.env.SPOTIFY_MARKET || "IN";

    const { data } = await client.get("/browse/new-releases", {
      params: {
        country: market,
        limit: 50, // Already at 50
      },
    });

    const albums = data.albums?.items || [];
    if (!albums.length) {
      logger.warn("No new releases returned");
      return [];
    }

    const results: SpotifySongResult[] = [];

    // Each album may contain multiple tracks; extract them
    for (const album of albums) {
      const albumTracks = album.tracks?.items || [];

      results.push(
        ...albumTracks.slice(0, 3).map((track: any) => ({
          // Take top 3 tracks per album
          title: track.name || "Unknown",
          artist: track.artists?.[0]?.name || "Unknown",
          popularity: track.popularity || 0,
          release_date: album.release_date || "",
          image_url: album.images?.[0]?.url || null,
          spotify_id: track.id || "",
          external_url: track.external_urls?.spotify || "",
        })),
      );
    }

    logger.info(
      { count: results.length, albums: albums.length },
      "New releases scrape complete",
    );
    return results.slice(0, 100); // Increased from 50 to 100
  } catch (err: any) {
    logger.warn({ err: err.message }, "New releases scrape failed");
    return [];
  }
}

/**
 * Search for trending tracks in current year.
 * Uses Spotify's search endpoint with year filter.
 */
export async function searchTrendingTracks(): Promise<SpotifySongResult[]> {
  try {
    logger.info("Searching Spotify for trending tracks...");
    const client = getSpotifyClient();

    const market = process.env.SPOTIFY_MARKET || "IN";
    const year = new Date().getFullYear();

    // Run multiple searches to get more variety
    const searchQueries = [
      `track:love year:${year}`,
      `track:party year:${year}`,
      `track:remix year:${year}`,
      `track:hit year:${year}`,
      `track:top year:${year}`,
    ];

    const allTracks: SpotifySongResult[] = [];

    for (const query of searchQueries) {
      for (const offset of [0, 10, 20]) {
        try {
          const { data } = await client.get("/search", {
            params: {
              q: query,
              type: "track",
              market,
              limit: 10,
              offset,
            },
          });

          const tracks = data.tracks?.items || [];

          allTracks.push(
            ...tracks.map((track: any) => ({
              title: track.name || "Unknown",
              artist: track.artists?.[0]?.name || "Unknown",
              popularity: track.popularity || 0,
              release_date: track.album?.release_date || "",
              image_url: track.album?.images?.[0]?.url || null,
              spotify_id: track.id || "",
              external_url: track.external_urls?.spotify || "",
            })),
          );
        } catch (searchErr: any) {
          logger.warn(
            { query, offset, err: searchErr.message },
            "Search query failed (non-critical)",
          );
        }
      }
    }

    logger.info({ count: allTracks.length }, "Trending search complete");
    return allTracks.slice(0, 100); // Increased from 50 to 100
  } catch (err: any) {
    logger.warn({ err: err.message }, "Trending search failed");
    return [];
  }
}

// ── Aggregation ───────────────────────────────────────────────────────────────

/**
 * Run all Spotify scrapers in parallel and aggregate.
 */
export async function scrapeSpotifyOfficial(): Promise<{
  songs: SpotifySongResult[];
  diagnostics: Record<string, string>;
}> {
  const [featuredResult, newReleasesResult, searchResult] =
    await Promise.allSettled([
      scrapeFeaturedPlaylists(),
      scrapeNewReleases(),
      searchTrendingTracks(),
    ]);

  const diagnostics: Record<string, string> = {
    featured_playlists:
      featuredResult.status === "fulfilled"
        ? `ok (${featuredResult.value.length})`
        : `failed: ${(featuredResult as any).reason?.message}`,
    new_releases:
      newReleasesResult.status === "fulfilled"
        ? `ok (${newReleasesResult.value.length})`
        : `failed: ${(newReleasesResult as any).reason?.message}`,
    trending_search:
      searchResult.status === "fulfilled"
        ? `ok (${searchResult.value.length})`
        : `failed: ${(searchResult as any).reason?.message}`,
  };

  const allSongs: SpotifySongResult[] = [
    ...(featuredResult.status === "fulfilled" ? featuredResult.value : []),
    ...(newReleasesResult.status === "fulfilled"
      ? newReleasesResult.value
      : []),
    ...(searchResult.status === "fulfilled" ? searchResult.value : []),
  ];

  // Deduplicate by spotify_id (most reliable identifier)
  const seenIds = new Set<string>();
  const deduped: SpotifySongResult[] = [];

  for (const song of allSongs) {
    if (!seenIds.has(song.spotify_id)) {
      seenIds.add(song.spotify_id);
      deduped.push(song);
    }
  }

  logger.info(
    { total: allSongs.length, deduped: deduped.length, diagnostics },
    "Spotify official scrape complete",
  );

  return { songs: deduped, diagnostics };
}

// ── Test/Verification ─────────────────────────────────────────────────────────

/**
 * Quick health check: verify credentials work and can fetch token.
 * Call this on startup or add to a `/health/spotify` endpoint.
 */
export async function verifySpotifyCredentials(): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    const token = await getSpotifyAccessToken();
    if (token && token.length > 0) {
      return { ok: true, message: "Spotify credentials verified" };
    }
    return { ok: false, message: "Token empty" };
  } catch (err: any) {
    return {
      ok: false,
      message: `Spotify credentials invalid: ${err.message}`,
    };
  }
}
