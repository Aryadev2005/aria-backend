// src/services/songs/song.scraper.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Song Scraper — fetches trending songs from 3 sources every 6 hours
//
// Sources:
//   1. Spotify India Daily Charts (HTML scrape of charts.spotify.com)
//   2. JioSaavn Trending       (public API endpoint)
//   3. YouTube Music Trending  (YouTube Data API v3)
//
// Returns a normalised SongRecord[] ready for upsert into live_songs.
// Each function degrades gracefully — a source failure never blocks others.
// ══════════════════════════════════════════════════════════════════════════════

import axios from "axios";
import { logger } from "../../utils/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SongRecord {
  source:        "spotify" | "jiosaavn" | "youtube";
  title:         string;
  artist:        string;
  chart_position: number;
  chart_change:  number;   // positive = climbing, negative = falling, 0 = stable
  streams_today: bigint;
  language:      string;   // "Hindi" | "English" | "Punjabi" | "Telugu" | etc.
  mood_tags:     string[];
  niche_tags:    string[];
  raw_data:      Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectLanguage(title: string, artist: string, meta: string = ""): string {
  const text = `${title} ${artist} ${meta}`.toLowerCase();

  // Simple heuristic — extend as needed
  if (/[\u0900-\u097F]/.test(text)) return "Hindi";    // Devanagari script
  if (/[\u0A80-\u0AFF]/.test(text)) return "Gujarati";
  if (/[\u0C00-\u0C7F]/.test(text)) return "Telugu";
  if (/[\u0B80-\u0BFF]/.test(text)) return "Tamil";
  if (/[\u0900-\u097F]/.test(artist)) return "Hindi";

  // Keyword-based
  const hindiKeywords = ["bollywood", "filmi", "bhojpuri", "haryanvi", "punjabi"];
  if (hindiKeywords.some((k) => text.includes(k))) return "Hindi";

  const englishKeywords = ["english", "pop", "r&b", "hip-hop"];
  if (englishKeywords.some((k) => text.includes(k))) return "English";

  return "Hindi"; // Default for India charts
}

function inferMoodTags(title: string): string[] {
  const t = title.toLowerCase();
  const moods: string[] = [];
  if (/love|dil|pyaar|ishq|romance|heart/.test(t)) moods.push("romantic");
  if (/sad|dard|tanha|broken|cry/.test(t)) moods.push("melancholic");
  if (/party|dance|bhangra|groove|floor/.test(t)) moods.push("party");
  if (/motivat|hustle|grind|power|strong/.test(t)) moods.push("motivational");
  if (/chill|lofi|relax|calm|easy/.test(t)) moods.push("chill");
  if (/devotional|bhajan|aarti|spiritual/.test(t)) moods.push("devotional");
  if (moods.length === 0) moods.push("general");
  return moods;
}

function inferNicheTags(moodTags: string[], language: string): string[] {
  const niches: string[] = [];
  if (moodTags.includes("party") || moodTags.includes("dance")) {
    niches.push("dance", "fitness", "fashion");
  }
  if (moodTags.includes("romantic")) {
    niches.push("lifestyle", "fashion", "travel");
  }
  if (moodTags.includes("motivational")) {
    niches.push("fitness", "education", "startup");
  }
  if (moodTags.includes("melancholic")) {
    niches.push("lifestyle", "storytelling");
  }
  if (moodTags.includes("devotional")) {
    niches.push("culture", "lifestyle");
  }
  if (language === "English") {
    niches.push("lifestyle", "fashion", "tech");
  }
  // Always include general
  niches.push("general");
  return [...new Set(niches)];
}

// ── Source 1: Spotify India Daily Charts ──────────────────────────────────────

export async function scrapeSpotify(): Promise<SongRecord[]> {
  try {
    logger.info("Scraping Spotify India daily charts via CSV...");

    const { data } = await axios.get(
      "https://charts.spotify.com/charts/view/regional-in-daily/latest.csv",
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/csv,text/plain,*/*",
        },
        timeout: 15000,
        responseType: "text",
      },
    );

    // CSV format: rank,uri,artist_names,track_name,source,peak_rank,previous_rank,weeks_on_chart,streams
    const lines = (data as string).trim().split("\n");

    // Skip header row
    const songs: SongRecord[] = lines
      .slice(1)
      .slice(0, 50)
      .map((line: string, i: number) => {
        // Handle quoted CSV fields properly
        const cols = line.match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g) || line.split(",");
        const clean = (s: string) => s?.replace(/^"|"$/g, "").trim() || "";

        const rank        = parseInt(clean(cols[0])) || i + 1;
        const artist      = clean(cols[2]);
        const title       = clean(cols[3]);
        const peakRank    = parseInt(clean(cols[5])) || rank;
        const prevRank    = parseInt(clean(cols[6])) || rank;
        const streams     = BigInt(Math.round(parseFloat(clean(cols[8])) || 0));

        if (!title || title === "track_name") return null;

        const language  = detectLanguage(title, artist);
        const moodTags  = inferMoodTags(title);
        const nicheTags = inferNicheTags(moodTags, language);

        return {
          source:         "spotify",
          title:          title,
          artist:         artist,
          chart_position: rank,
          chart_change:   prevRank - rank,
          streams_today:  streams,
          language,
          mood_tags:      moodTags,
          niche_tags:     nicheTags,
          raw_data:       { rank, peakRank, prevRank },
        } satisfies SongRecord;
      })
      .filter(Boolean) as SongRecord[];

    logger.info({ count: songs.length }, "Spotify CSV scrape complete");
    return songs;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Spotify CSV scrape failed — skipping source");
    return [];
  }
}

// ── Source 2: JioSaavn Trending ───────────────────────────────────────────────

export async function scrapeJioSaavn(): Promise<SongRecord[]> {
  // Try 3 endpoints in order — first success wins
  return (
    (await _jiosaavnTrending())     ||
    (await _jiosaavnTopCharts())    ||
    (await _jiosaavnSearchFallback()) ||
    []
  );
}

// Attempt 1: trending songs API (most accurate)
async function _jiosaavnTrending(): Promise<SongRecord[] | null> {
  try {
    logger.info("JioSaavn: trying trending songs endpoint...");
    const { data } = await axios.get("https://www.jiosaavn.com/api.php", {
      params: {
        __call:   "song.getTrending",
        _format:  "json",
        _marker:  "0",
        ctx:      "web6dot0",
        entity_type: "song",
        entity_language: "hindi,english,punjabi",
        n:        50,
        p:        1,
      },
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.jiosaavn.com/" },
      timeout: 12000,
    });

    const rawSongs: any[] = Array.isArray(data) ? data : (data?.results || data?.songs || []);
    if (!rawSongs.length) return null;

    return _mapJioSaavnSongs(rawSongs, 40);
  } catch {
    return null;
  }
}

// Attempt 2: top songs via webapi (reliable fallback)
async function _jiosaavnTopCharts(): Promise<SongRecord[] | null> {
  try {
    logger.info("JioSaavn: trying top songs fallback...");
    const { data } = await axios.get("https://www.jiosaavn.com/api.php", {
      params: {
        __call:  "webapi.get",
        _format: "json",
        _marker: "0",
        ctx:     "web6dot0",
        token:   "ze2Qe7oCVGTF4J4w",  // JioSaavn India Top 50 — stable public token
        type:    "playlist",
        n:       50,
        p:       1,
      },
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.jiosaavn.com/" },
      timeout: 12000,
    });

    const rawSongs: any[] = data?.songs || data?.list || [];
    if (!rawSongs.length) return null;

    return _mapJioSaavnSongs(rawSongs, 40);
  } catch {
    return null;
  }
}

// Attempt 3: search "trending" and pull song results
async function _jiosaavnSearchFallback(): Promise<SongRecord[] | null> {
  try {
    logger.info("JioSaavn: trying search fallback...");
    const { data } = await axios.get("https://www.jiosaavn.com/api.php", {
      params: {
        __call:  "search.getResults",
        _format: "json",
        _marker: "0",
        ctx:     "web6dot0",
        query:   "trending hindi 2025",
        n:       40,
        p:       1,
      },
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.jiosaavn.com/" },
      timeout: 10000,
    });

    const rawSongs: any[] = data?.results || [];
    if (!rawSongs.length) return null;

    return _mapJioSaavnSongs(rawSongs, 30);
  } catch {
    return null;
  }
}

// Shared mapper for all JioSaavn responses
function _mapJioSaavnSongs(rawSongs: any[], limit: number): SongRecord[] {
  return rawSongs
    .slice(0, limit)
    .map((song: any, i: number) => {
      const title  = song.title || song.song || "Unknown";
      const artist = song.primary_artists || song.more_info?.primary_artists || song.subtitle || "Unknown";
      const lang   = song.language || detectLanguage(title, artist);
      const moodTags  = inferMoodTags(title);
      const nicheTags = inferNicheTags(moodTags, lang);

      return {
        source:         "jiosaavn",
        title:          decodeHtmlEntities(title.trim()),
        artist:         decodeHtmlEntities(artist.trim()),
        chart_position: i + 1,
        chart_change:   0,
        streams_today:  BigInt(song.play_count || 0),
        language:       capitaliseFirst(lang),
        mood_tags:      moodTags,
        niche_tags:     nicheTags,
        raw_data:       { songId: song.id, language: song.language },
      } satisfies SongRecord;
    })
    .filter((s) => s.title !== "Unknown");
}

// ── Source 3: YouTube Music Trending ──────────────────────────────────────────

export async function scrapeYouTubeMusic(): Promise<SongRecord[]> {
  const YT_KEY = process.env.YOUTUBE_API_KEY?.trim();
  if (!YT_KEY) {
    logger.warn("YOUTUBE_API_KEY not set — skipping YouTube Music scrape");
    return [];
  }

  try {
    logger.info("Scraping YouTube trending music India...");

    // videoCategoryId=10 = Music; regionCode=IN
    const { data } = await axios.get(
      "https://www.googleapis.com/youtube/v3/videos",
      {
        params: {
          key:             YT_KEY,
          part:            "snippet,statistics",
          chart:           "mostPopular",
          regionCode:      "IN",
          videoCategoryId: "10",
          maxResults:      50,
          hl:              "hi",
        },
        timeout: 12000,
      },
    );

    const items: any[] = data.items || [];

    const songs: SongRecord[] = items
      .map((item: any, i: number) => {
        const snippet    = item.snippet || {};
        const stats      = item.statistics || {};
        const title      = snippet.title || "Unknown";
        const artist     = snippet.channelTitle || "Unknown";
        const language   = detectLanguage(title, artist, snippet.description || "");
        const moodTags   = inferMoodTags(title);
        const nicheTags  = inferNicheTags(moodTags, language);
        const views      = BigInt(stats.viewCount || 0);

        return {
          source:         "youtube",
          title:          title.trim(),
          artist:         artist.trim(),
          chart_position: i + 1,
          chart_change:   0,
          streams_today:  views,
          language,
          mood_tags:      moodTags,
          niche_tags:     nicheTags,
          raw_data:       {
            videoId: item.id,
            viewCount: stats.viewCount,
            likeCount: stats.likeCount,
            publishedAt: snippet.publishedAt,
          },
        } satisfies SongRecord;
      })
      .filter((s) => s.title !== "Unknown");

    logger.info({ count: songs.length }, "YouTube Music scrape complete");
    return songs;
  } catch (err: any) {
    logger.warn({ err: err.message }, "YouTube Music scrape failed — skipping source");
    return [];
  }
}

// ── Aggregate: run all scrapers in parallel ────────────────────────────────────

export async function scrapeAllSources(): Promise<{
  songs: SongRecord[];
  diagnostics: Record<string, string>;
}> {
  const [spotifyResult, jiosaavnResult, youtubeResult] = await Promise.allSettled([
    scrapeSpotify(),
    scrapeJioSaavn(),
    scrapeYouTubeMusic(),
  ]);

  const diagnostics: Record<string, string> = {
    spotify:   spotifyResult.status  === "fulfilled" ? `ok (${spotifyResult.value.length})` : `failed: ${(spotifyResult as any).reason?.message}`,
    jiosaavn:  jiosaavnResult.status === "fulfilled" ? `ok (${jiosaavnResult.value.length})` : `failed: ${(jiosaavnResult as any).reason?.message}`,
    youtube:   youtubeResult.status  === "fulfilled" ? `ok (${youtubeResult.value.length})` : `failed: ${(youtubeResult as any).reason?.message}`,
  };

  const allSongs: SongRecord[] = [
    ...(spotifyResult.status  === "fulfilled" ? spotifyResult.value  : []),
    ...(jiosaavnResult.status === "fulfilled" ? jiosaavnResult.value : []),
    ...(youtubeResult.status  === "fulfilled" ? youtubeResult.value  : []),
  ];

  // De-duplicate by normalised title+artist — keep the entry with more streams
  const deduped = deduplicateSongs(allSongs);

  logger.info(
    { total: allSongs.length, deduped: deduped.length, diagnostics },
    "All song sources scraped",
  );

  return { songs: deduped, diagnostics };
}

function deduplicateSongs(songs: SongRecord[]): SongRecord[] {
  const seen = new Map<string, SongRecord>();

  for (const song of songs) {
    const key = normaliseKey(song.title) + "|" + normaliseKey(song.artist);
    const existing = seen.get(key);
    if (!existing || song.streams_today > existing.streams_today) {
      seen.set(key, song);
    }
  }

  return Array.from(seen.values());
}

function normaliseKey(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function capitaliseFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
