import axios from "axios";
import * as cheerio from "cheerio";
import { prisma } from "../config/database";
import { logger } from "../utils/logger";

// Scheduling is handled by setInterval in src/config/queue.js

const FALLBACK_SONGS = [
  {
    title: "Bhaiyaji Superhit",
    artist: "Manoj Bajpayee ft. Various",
    language: "Hindi",
    position: 1,
  },
  {
    title: "Naatu Naatu",
    artist: "MM Keeravani",
    language: "Telugu",
    position: 2,
  },
  {
    title: "Punjabi Trance",
    artist: "Sidhu Moose Wala x Badshah",
    language: "Punjabi",
    position: 3,
  },
  {
    title: "Meri Aashiqui",
    artist: "Arijit Singh",
    language: "Hindi",
    position: 4,
  },
  {
    title: "Teri Baaton Mein Aisa",
    artist: "Raghav Chaturvedi",
    language: "Hindi",
    position: 5,
  },
  {
    title: "Bollywood Mashup 2026",
    artist: "DJ Aqeel",
    language: "Hindi",
    position: 6,
  },
  {
    title: "Kannada Beats",
    artist: "Sonu Nigam x Kailash Kher",
    language: "Kannada",
    position: 7,
  },
  {
    title: "Tamil Vibes",
    artist: "Anirudh Ravichander",
    language: "Tamil",
    position: 8,
  },
  {
    title: "Indie Hindi Pop",
    artist: "Prateek Kuhad",
    language: "Hindi",
    position: 9,
  },
  {
    title: "Bhangra 2026",
    artist: "Guru Randhawa",
    language: "Punjabi",
    position: 10,
  },
];

const detectLanguage = (title: string, artist: string): string => {
  const text = (title + " " + artist).toLowerCase();
  if (
    text.includes("hindi") ||
    text.includes("बॉलीवुड") ||
    text.includes("मेरी")
  )
    return "Hindi";
  if (
    text.includes("punjabi") ||
    text.includes("ਪੰਜਾਬ") ||
    text.includes("bhangra")
  )
    return "Punjabi";
  if (text.includes("tamil") || text.includes("தமிழ்")) return "Tamil";
  if (text.includes("telugu") || text.includes("తెలుగు")) return "Telugu";
  if (text.includes("kannada") || text.includes("ಕನ್ನಡ")) return "Kannada";
  if (text.includes("marathi") || text.includes("मराठी")) return "Marathi";
  if (text.includes("bengali") || text.includes("বাংলা")) return "Bengali";
  return "English";
};

const determineSignal = (position: number): string => {
  if (position <= 15) return "PostNow";
  if (position <= 30) return "PostSoon";
  return "Avoid";
};

const determineLifecycle = (position: number): string => {
  if (position <= 10) return "peak";
  if (position <= 30) return "rising";
  return "early";
};

const fetchSpotifyCharts = async (): Promise<any[] | null> => {
  try {
    const url =
      "https://charts.spotify.com/charts/view/regional-in-daily/latest";
    const response = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const scriptTag = $("#__NEXT_DATA__").html();
    if (!scriptTag) {
      logger.warn("No __NEXT_DATA__ found in Spotify page");
      return null;
    }

    const data = JSON.parse(scriptTag);
    const tracks: any[] = [];
    const traverse = (obj: any) => {
      if (Array.isArray(obj)) {
        obj.forEach(traverse);
      } else if (typeof obj === "object" && obj) {
        if (obj.chartEntryData || obj.rankingItemData) {
          const item = obj.chartEntryData || obj.rankingItemData;
          if (item.trackMetadata) tracks.push(item);
        }
        Object.values(obj).forEach(traverse);
      }
    };
    traverse(data);

    if (tracks.length === 0) {
      logger.warn("Could not extract tracks from Spotify data");
      return null;
    }

    logger.info({ count: tracks.length }, "Spotify charts parsed");
    return tracks.slice(0, 30);
  } catch (err) {
    logger.warn({ err }, "Spotify charts fetch failed");
    return null;
  }
};

const fetchJioSaavnCharts = async (): Promise<any[] | null> => {
  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const url =
      "https://www.jiosaavn.com/api.php?__call=content.getFeaturedPlaylists&api_version=4&_format=json&_marker=0&ctx=web6dot0";
    const response = await axios.get(url, { timeout: 10000 });
    const playlists = response.data?.featuredPlaylistsPromo || [];
    const songs: any[] = [];
    playlists.forEach((playlist: any) => {
      if (playlist.songs) {
        playlist.songs.forEach((song: any) => {
          songs.push({
            title: song.title,
            artist:
              song.artists?.map((a: any) => a.name).join(", ") || "Unknown",
            position: songs.length + 1,
          });
        });
      }
    });
    logger.info({ count: songs.length }, "JioSaavn charts fetched");
    return songs.length > 0 ? songs : null;
  } catch (err) {
    logger.warn({ err }, "JioSaavn fetch failed");
    return null;
  }
};

export interface SongJob {
  id: string;
  data: any;
}

export interface SongData {
  title: string;
  artist: string;
  source: string;
  position?: number;
  streams_today: number;
  language?: string;
}

/**
 * Accepts a plain job-like object: { id: string, data: {} }
 */
export const processSongJob = async (job: SongJob) => {
  let allSongs: SongData[] = [];

  try {
    let songs = await fetchSpotifyCharts();
    if (songs) {
      allSongs = allSongs.concat(
        songs.map((s, idx) => ({
          title: s.trackMetadata?.trackName || "Unknown",
          artist: s.trackMetadata?.artistName || "Unknown",
          source: "spotify",
          position: idx + 1,
          streams_today: 0,
        })),
      );
    }

    if (!songs || songs.length < 10) {
      const saavnSongs = await fetchJioSaavnCharts();
      if (saavnSongs) {
        allSongs = allSongs.concat(
          saavnSongs.map((s) => ({
            ...s,
            source: "jiosaavn",
            streams_today: 0,
          })),
        );
      }
    }

    if (allSongs.length === 0) {
      allSongs = FALLBACK_SONGS.map((s) => ({
        ...s,
        source: "fallback",
        streams_today: 0,
      }));
      logger.warn("Using fallback songs — no real sources available");
    }

    const previousSongs = await prisma.live_songs.findMany({
      where: {
        fetched_at: { gt: new Date(Date.now() - 4 * 60 * 60 * 1000) },
      },
      take: 100,
      select: { title: true, artist: true, chart_position: true },
    });
    const previousMap = new Map(
      previousSongs.map((s) => [`${s.title}|${s.artist}`, s.chart_position]),
    );

    await prisma.live_songs.deleteMany({
      where: {
        fetched_at: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      },
    });

    const insertPromises = allSongs.slice(0, 50).map(async (song, idx) => {
      const position = song.position || idx + 1;
      const previousPosition = previousMap.get(`${song.title}|${song.artist}`);
      const chart_change = previousPosition
        ? Math.max(-100, Math.min(100, (previousPosition as number) - position))
        : 0;
      const language = detectLanguage(song.title, song.artist);
      const signal = determineSignal(position);
      const lifecycle = determineLifecycle(position);

      try {
        await prisma.live_songs.create({
          data: {
            source: song.source,
            title: song.title,
            artist: song.artist,
            chart_position: position,
            chart_change,
            streams_today: BigInt(song.streams_today || 0),
            language,
            raw_data: { ...song, signal, lifecycle },
            fetched_at: new Date(),
          },
        });
      } catch {
        // Preserve prior insert-ignore behavior
      }
    });

    await Promise.all(insertPromises);

    logger.info(
      { count: allSongs.length, job_id: job.id },
      "Songs refreshed and stored",
    );
    return { success: true, songsInserted: allSongs.length };
  } catch (err) {
    logger.error({ err, job_id: job.id }, "Song job failed");
    throw err;
  }
};

/**
 * Scheduling is handled by setInterval in queue.js
 */
export const startSongWorker = async () => {
  const SONGS_ENABLED = process.env.SONGS_ENABLED !== "false";
  if (!SONGS_ENABLED) {
    logger.info("Song worker disabled via SONGS_ENABLED=false");
    return null;
  }
  logger.info("Song processor ready (scheduled via setInterval in queue.js)");
  return null;
};
