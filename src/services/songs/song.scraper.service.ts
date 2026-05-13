// src/services/songs/song.scraper.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Song Scraper — multi-language, multi-region, 3 sources every 6 hours
//
// Sources:
//   1. Spotify  — 10 curated editorial playlists, language-tagged at source
//   2. JioSaavn — trending across Hindi, English, Punjabi, Tamil, Telugu,
//                 Bhojpuri, Malayalam, Marathi, Bengali, Kannada
//   3. YouTube Music — trending music across IN, US, KR, NG, BR regions
//
// Key fixes vs previous version:
//   - Spotify: language was hardcoded "Hindi" for every track → now uses
//     playlist-level language tag from spotify-official.service.ts
//   - JioSaavn: entity_language only covered 3 languages → now covers 10
//     Fallback search query was "trending hindi 2025" → now "trending 2025"
//   - YouTube Music: only scraped IN region → now scrapes 5 regions in parallel
//   - detectLanguage: defaulted to "Hindi" for unrecognised ASCII titles →
//     now defaults to "English" for pure ASCII, "Hindi" only for Devanagari
// ══════════════════════════════════════════════════════════════════════════════

import axios from "axios";
import { logger } from "../../utils/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SongRecord {
  source: "spotify" | "jiosaavn" | "youtube";
  title: string;
  artist: string;
  chart_position: number;
  chart_change: number;
  streams_today: bigint;
  language: string;
  mood_tags: string[];
  niche_tags: string[];
  raw_data: Record<string, unknown>;
}

// ── Language detection — fixed ─────────────────────────────────────────────────
// Previous version defaulted to "Hindi" for all unrecognised text.
// New version: pure ASCII → "English", Devanagari → "Hindi",
// script detection for Tamil/Telugu/Gujarati, keyword detection for Punjabi.

function detectLanguage(title: string, artist: string, meta = ""): string {
  const text = `${title} ${artist} ${meta}`;

  // Script-based detection (most reliable — unambiguous Unicode ranges)
  if (/[\u0900-\u097F]/.test(text)) return "Hindi"; // Devanagari
  if (/[\u0B80-\u0BFF]/.test(text)) return "Tamil"; // Tamil script
  if (/[\u0C00-\u0C7F]/.test(text)) return "Telugu"; // Telugu script
  if (/[\u0A00-\u0A7F]/.test(text)) return "Punjabi"; // Gurmukhi script
  if (/[\u0A80-\u0AFF]/.test(text)) return "Gujarati"; // Gujarati script
  if (/[\u0D00-\u0D7F]/.test(text)) return "Malayalam"; // Malayalam script
  if (/[\u0980-\u09FF]/.test(text)) return "Bengali"; // Bengali script
  if (/[\u0C80-\u0CFF]/.test(text)) return "Kannada"; // Kannada script
  if (/[\uAC00-\uD7AF]/.test(text)) return "Korean"; // Hangul
  if (/[\u4E00-\u9FFF]/.test(text)) return "Chinese"; // CJK
  if (/[\u3040-\u30FF]/.test(text)) return "Japanese"; // Hiragana/Katakana

  const lower = text.toLowerCase();

  // Keyword-based detection for romanised languages
  if (/\b(punjabi|bhangra|haryanvi|jatt|desi)\b/.test(lower)) return "Punjabi";
  if (/\b(bhojpuri|bhojpuriya)\b/.test(lower)) return "Bhojpuri";
  if (/\b(bollywood|hindi|filmi|dil|pyaar|ishq)\b/.test(lower)) return "Hindi";
  if (/\b(tamil|kollywood)\b/.test(lower)) return "Tamil";
  if (/\b(telugu|tollywood)\b/.test(lower)) return "Telugu";
  if (/\b(kannada|sandalwood)\b/.test(lower)) return "Kannada";
  if (/\b(malayalam|mollywood)\b/.test(lower)) return "Malayalam";
  if (/\b(marathi|marathi)\b/.test(lower)) return "Marathi";
  if (/\b(bengali|bangla|bangla)\b/.test(lower)) return "Bengali";
  if (/\b(k-?pop|kpop|hallyu)\b/.test(lower)) return "Korean";
  if (/\b(afrobeats?|afropop|amapiano)\b/.test(lower)) return "Afrobeats";
  if (/\b(reggaeton|latin|cumbia|salsa)\b/.test(lower)) return "Spanish";

  // Pure ASCII with no Indian keywords → English (not Hindi)
  // This is the critical fix — previously defaulted to "Hindi" here
  if (/^[\x00-\x7F]*$/.test(text.trim())) return "English";

  // Mixed/unresolvable — default Hindi (still has Indian context)
  return "Hindi";
}

// ── Mood tags ─────────────────────────────────────────────────────────────────

function inferMoodTags(title: string): string[] {
  const t = title.toLowerCase();
  const moods: string[] = [];
  if (/love|dil|pyaar|ishq|romance|heart|amor|sarang/.test(t))
    moods.push("romantic");
  if (/sad|dard|tanha|broken|cry|pain|hurt/.test(t)) moods.push("melancholic");
  if (/party|dance|bhangra|groove|floor|fiesta/.test(t)) moods.push("party");
  if (/motivat|hustle|grind|power|strong|energy/.test(t))
    moods.push("motivational");
  if (/chill|lofi|relax|calm|easy|vibe/.test(t)) moods.push("chill");
  if (/devotional|bhajan|aarti|spiritual|prayer/.test(t))
    moods.push("devotional");
  if (moods.length === 0) moods.push("general");
  return moods;
}

// ── Niche tags ────────────────────────────────────────────────────────────────

function inferNicheTags(moodTags: string[], language: string): string[] {
  const niches: string[] = [];
  if (moodTags.includes("party") || moodTags.includes("dance"))
    niches.push("dance", "fitness", "fashion");
  if (moodTags.includes("romantic"))
    niches.push("lifestyle", "fashion", "travel");
  if (moodTags.includes("motivational"))
    niches.push("fitness", "education", "startup");
  if (moodTags.includes("melancholic"))
    niches.push("lifestyle", "storytelling");
  if (moodTags.includes("devotional")) niches.push("culture", "lifestyle");
  if (language === "English" || language === "Korean" || language === "Spanish")
    niches.push("lifestyle", "fashion", "tech");
  if (language === "Afrobeats") niches.push("dance", "fashion", "lifestyle");
  niches.push("general");
  return [...new Set(niches)];
}

// ── HTML entity decoder ───────────────────────────────────────────────────────

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

function capitaliseFirst(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 1 — Spotify (via curated editorial playlists, language-tagged)
// ════════════════════════════════════════════════════════════════════════════

export async function scrapeSpotify(): Promise<SongRecord[]> {
  try {
    logger.info("Scraping Spotify via curated playlists...");

    const { scrapeSpotifyOfficial } =
      await import("./spotify-official.service");
    const { songs, diagnostics } = await scrapeSpotifyOfficial();

    if (!songs.length) {
      logger.warn({ diagnostics }, "Spotify official API returned no songs");
      return [];
    }

    const mappedSongs: SongRecord[] = songs.map((spot, i) => {
      // language comes from the playlist-level tag — no longer hardcoded
      const language = spot.language || detectLanguage(spot.title, spot.artist);
      const moodTags = inferMoodTags(spot.title);
      const nicheTags = inferNicheTags(moodTags, language);

      const chartPosition = Math.max(
        1,
        Math.min(50, Math.ceil((100 - spot.popularity) / 2) + 1),
      );

      return {
        source: "spotify",
        title: spot.title,
        artist: spot.artist,
        chart_position: chartPosition,
        chart_change: 0,
        streams_today: BigInt(spot.popularity || 0),
        language,
        mood_tags: moodTags,
        niche_tags: nicheTags,
        raw_data: {
          spotify_id: spot.spotify_id,
          popularity: spot.popularity,
          release_date: spot.release_date,
          image_url: spot.image_url,
          external_url: spot.external_url,
          source: "official-api",
        },
      } satisfies SongRecord;
    });

    logger.info(
      { count: mappedSongs.length, diagnostics },
      "Spotify scrape complete",
    );
    return mappedSongs;
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Spotify scrape failed — skipping source",
    );
    return [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 2 — JioSaavn (multi-language trending)
// ════════════════════════════════════════════════════════════════════════════

export async function scrapeJioSaavn(): Promise<SongRecord[]> {
  return (
    (await _jiosaavnTrending()) ||
    (await _jiosaavnTopCharts()) ||
    (await _jiosaavnSearchFallback()) ||
    []
  );
}

// Attempt 1: trending songs API — now covers all 10 major Indian languages
async function _jiosaavnTrending(): Promise<SongRecord[] | null> {
  try {
    logger.info("JioSaavn: trying trending songs endpoint (10 languages)...");

    // FIX: was "hindi,english,punjabi" — now covers all major Indian languages
    const JIOSAAVN_LANGUAGES =
      "hindi,english,punjabi,tamil,telugu,bhojpuri,malayalam,marathi,bengali,kannada";

    const { data } = await axios.get("https://www.jiosaavn.com/api.php", {
      params: {
        __call: "song.getTrending",
        _format: "json",
        _marker: "0",
        ctx: "web6dot0",
        entity_type: "song",
        entity_language: JIOSAAVN_LANGUAGES,
        n: 80, // increased from 50 to get broader language coverage
        p: 1,
      },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://www.jiosaavn.com/",
      },
      timeout: 12_000,
    });

    const rawSongs: any[] = Array.isArray(data)
      ? data
      : data?.results || data?.songs || [];
    if (!rawSongs.length) return null;

    return _mapJioSaavnSongs(rawSongs, 60);
  } catch {
    return null;
  }
}

// Attempt 2: top songs via webapi — India Top 50 playlist (stable token)
async function _jiosaavnTopCharts(): Promise<SongRecord[] | null> {
  try {
    logger.info("JioSaavn: trying top charts fallback...");
    const { data } = await axios.get("https://www.jiosaavn.com/api.php", {
      params: {
        __call: "webapi.get",
        _format: "json",
        _marker: "0",
        ctx: "web6dot0",
        token: "ze2Qe7oCVGTF4J4w", // India Top 50 — stable public token
        type: "playlist",
        n: 50,
        p: 1,
      },
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.jiosaavn.com/",
      },
      timeout: 12_000,
    });

    const rawSongs: any[] = data?.songs || data?.list || [];
    if (!rawSongs.length) return null;

    return _mapJioSaavnSongs(rawSongs, 40);
  } catch {
    return null;
  }
}

// Attempt 3: search fallback — FIX: was "trending hindi 2025", now language-neutral
async function _jiosaavnSearchFallback(): Promise<SongRecord[] | null> {
  try {
    logger.info("JioSaavn: trying search fallback (language-neutral)...");
    const { data } = await axios.get("https://www.jiosaavn.com/api.php", {
      params: {
        __call: "search.getResults",
        _format: "json",
        _marker: "0",
        ctx: "web6dot0",
        query: "trending 2025", // FIX: removed "hindi" from query
        n: 40,
        p: 1,
      },
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.jiosaavn.com/",
      },
      timeout: 10_000,
    });

    const rawSongs: any[] = data?.results || [];
    if (!rawSongs.length) return null;

    return _mapJioSaavnSongs(rawSongs, 30);
  } catch {
    return null;
  }
}

// Shared mapper — uses song.language from API response (JioSaavn returns this reliably)
function _mapJioSaavnSongs(rawSongs: any[], limit: number): SongRecord[] {
  return rawSongs
    .slice(0, limit)
    .map((song: any, i: number) => {
      const title = song.title || song.song || "Unknown";
      const artist =
        song.primary_artists ||
        song.more_info?.primary_artists ||
        song.subtitle ||
        "Unknown";

      // JioSaavn returns language field — use it directly, fall back to detection
      const rawLang = song.language || song.more_info?.language || "";
      const lang = rawLang
        ? capitaliseFirst(rawLang.trim())
        : detectLanguage(title, artist);

      const moodTags = inferMoodTags(title);
      const nicheTags = inferNicheTags(moodTags, lang);

      return {
        source: "jiosaavn",
        title: decodeHtmlEntities(title.trim()),
        artist: decodeHtmlEntities(artist.trim()),
        chart_position: i + 1,
        chart_change: 0,
        streams_today: BigInt(song.play_count || 0),
        language: lang,
        mood_tags: moodTags,
        niche_tags: nicheTags,
        raw_data: { songId: song.id, language: rawLang },
      } satisfies SongRecord;
    })
    .filter((s) => s.title !== "Unknown");
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE 3 — YouTube Music (multi-region: IN, US, KR, NG, BR)
// ════════════════════════════════════════════════════════════════════════════

// Region → primary language mapping for YouTube Music
const YT_MUSIC_REGIONS: Array<{
  regionCode: string;
  language: string;
  label: string;
}> = [
  { regionCode: "IN", language: "Hindi", label: "India" },
  { regionCode: "US", language: "English", label: "US" },
  { regionCode: "KR", language: "Korean", label: "Korea" },
  { regionCode: "NG", language: "Afrobeats", label: "Nigeria" },
  { regionCode: "BR", language: "Spanish", label: "Brazil" },
];

export async function scrapeYouTubeMusic(): Promise<SongRecord[]> {
  const YT_KEY = process.env.YOUTUBE_API_KEY?.trim();
  if (!YT_KEY) {
    logger.warn("YOUTUBE_API_KEY not set — skipping YouTube Music scrape");
    return [];
  }

  logger.info("Scraping YouTube Music trending — 5 regions in parallel...");

  // Fetch all regions in parallel
  const regionResults = await Promise.allSettled(
    YT_MUSIC_REGIONS.map(async ({ regionCode, language, label }) => {
      const { data } = await axios.get(
        "https://www.googleapis.com/youtube/v3/videos",
        {
          params: {
            key: YT_KEY,
            part: "snippet,statistics",
            chart: "mostPopular",
            regionCode,
            videoCategoryId: "10", // Music category
            maxResults: 50,
          },
          timeout: 12_000,
        },
      );
      return { items: data?.items || [], regionCode, language, label };
    }),
  );

  const allSongs: SongRecord[] = [];
  const seen = new Set<string>(); // deduplicate by videoId across regions

  for (const result of regionResults) {
    if (result.status !== "fulfilled") continue;
    const { items, regionCode, language, label } = result.value;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const videoId = item.id;
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);

      const snippet = item.snippet || {};
      const stats = item.statistics || {};
      const title = (snippet.title || "").trim();
      if (!title || title === "Unknown") continue;

      const artist = snippet.channelTitle || "Unknown";

      // For IN region use smart detection (song might be Tamil/Telugu/Punjabi)
      // For other regions trust the region's primary language as baseline
      const language_detected =
        regionCode === "IN"
          ? detectLanguage(title, artist, snippet.description || "")
          : language;

      const moodTags = inferMoodTags(title);
      const nicheTags = inferNicheTags(moodTags, language_detected);
      const views = BigInt(stats.viewCount || 0);

      allSongs.push({
        source: "youtube",
        title,
        artist,
        chart_position: i + 1,
        chart_change: 0,
        streams_today: views,
        language: language_detected,
        mood_tags: moodTags,
        niche_tags: nicheTags,
        raw_data: {
          videoId,
          regionCode,
          regionLabel: label,
          viewCount: stats.viewCount,
          likeCount: stats.likeCount,
          publishedAt: snippet.publishedAt,
        },
      } satisfies SongRecord);
    }

    logger.info(
      { region: label, count: items.length },
      "YouTube Music region scraped",
    );
  }

  logger.info(
    { total: allSongs.length, regions: YT_MUSIC_REGIONS.length },
    "YouTube Music scrape complete",
  );
  return allSongs;
}

// ════════════════════════════════════════════════════════════════════════════
// AGGREGATE — run all 3 sources in parallel
// ════════════════════════════════════════════════════════════════════════════

export async function scrapeAllSources(): Promise<{
  songs: SongRecord[];
  diagnostics: Record<string, string>;
}> {
  const [spotifyResult, jiosaavnResult, youtubeResult] =
    await Promise.allSettled([
      scrapeSpotify(),
      scrapeJioSaavn(),
      scrapeYouTubeMusic(),
    ]);

  const diagnostics: Record<string, string> = {
    spotify:
      spotifyResult.status === "fulfilled"
        ? `ok (${spotifyResult.value.length})`
        : `failed: ${(spotifyResult as any).reason?.message}`,
    jiosaavn:
      jiosaavnResult.status === "fulfilled"
        ? `ok (${jiosaavnResult.value.length})`
        : `failed: ${(jiosaavnResult as any).reason?.message}`,
    youtube:
      youtubeResult.status === "fulfilled"
        ? `ok (${youtubeResult.value.length})`
        : `failed: ${(youtubeResult as any).reason?.message}`,
  };

  const allSongs: SongRecord[] = [
    ...(spotifyResult.status === "fulfilled" ? spotifyResult.value : []),
    ...(jiosaavnResult.status === "fulfilled" ? jiosaavnResult.value : []),
    ...(youtubeResult.status === "fulfilled" ? youtubeResult.value : []),
  ];

  // Global dedup by normalised title+artist across all sources
  const seen = new Set<string>();
  const unique: SongRecord[] = [];
  for (const s of allSongs) {
    const key = `${s.title.toLowerCase().trim()}::${s.artist.toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(s);
    }
  }

  logger.info(
    { total: allSongs.length, unique: unique.length, diagnostics },
    "Song scrape complete",
  );
  return { songs: unique, diagnostics };
}
