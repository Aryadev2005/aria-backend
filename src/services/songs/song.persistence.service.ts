// src/services/songs/song.persistence.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Song Persistence — writes scraped songs to the database and maintains
// trajectory history (Tier 3).
//
// Functions exported:
//   upsertSongs(songs)          — bulk upsert into live_songs
//   updateSongTrajectories()    — refresh Tier 3 from current live_songs
//   computeLifecycle(history)   — pure function, determines lifecycle state
//   computeSignal(lifecycle)    — determines postNow | wait | tooLate
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../../config/database";
import { logger } from "../../utils/logger";
import type { SongRecord } from "./song.scraper.service";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Lifecycle = "RISING" | "PEAKING" | "DECLINING" | "DEAD" | "CYCLICAL";
export type Signal    = "postNow" | "wait" | "tooLate";

export interface RankHistoryEntry {
  date:     string;   // ISO date "2025-01-15"
  rank:     number;
  streams:  string;   // BigInt as string to survive JSON
  source:   string;
}

// ── Lifecycle calculation ─────────────────────────────────────────────────────

export function computeLifecycle(history: RankHistoryEntry[]): Lifecycle {
  if (history.length < 2) return "RISING";

  const recent   = history.slice(-6);
  const ranks    = recent.map((h) => h.rank);
  const latest   = ranks[ranks.length - 1];
  const previous = ranks[ranks.length - 2];
  const earliest = ranks[0];

  // Dead: fallen out of top 100
  if (latest > 100) return "DEAD";

  // Cyclical: rank oscillates (3+ direction changes in last 6 entries)
  if (recent.length >= 5) {
    let changes = 0;
    for (let i = 2; i < ranks.length; i++) {
      const dir1 = Math.sign(ranks[i - 1] - ranks[i - 2]);
      const dir2 = Math.sign(ranks[i]     - ranks[i - 1]);
      if (dir1 !== 0 && dir2 !== 0 && dir1 !== dir2) changes++;
    }
    if (changes >= 3) return "CYCLICAL";
  }

  // Peaking: within top 10 and velocity is stable or slowing
  if (latest <= 10 && Math.abs(latest - previous) <= 2) return "PEAKING";

  // Rising: rank number is decreasing (lower rank = higher position)
  if (latest < earliest) return "RISING";

  // Declining: rank number is increasing (losing position)
  if (latest > previous * 1.15) return "DECLINING";

  // Default: still climbing
  return "RISING";
}

export function computeSignal(lifecycle: Lifecycle, rank: number): Signal {
  if (lifecycle === "DEAD")                      return "tooLate";
  if (lifecycle === "DECLINING" && rank > 50)    return "tooLate";
  if (lifecycle === "PEAKING")                   return "postNow";
  if (lifecycle === "RISING"    && rank <= 30)   return "postNow";
  if (lifecycle === "RISING"    && rank <= 60)   return "postNow";
  if (lifecycle === "CYCLICAL")                  return "wait";
  if (lifecycle === "DECLINING")                 return "wait";
  return "postNow";
}

function computeGrowthLabel(chartChange: number): string {
  if (chartChange > 5)  return `+${chartChange} ↑`;
  if (chartChange > 0)  return `↑${chartChange}`;
  if (chartChange === 0) return "stable";
  return `${chartChange} ↓`;
}

// ── Upsert scraped songs into live_songs ──────────────────────────────────────

export async function upsertSongs(songs: SongRecord[]): Promise<number> {
  if (!songs.length) return 0;

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const dateStr   = new Date().toISOString().split("T")[0];
  let upserted    = 0;

  for (const song of songs) {
    try {
      // Fetch existing to maintain rank_history
      const existing = await (prisma as any).live_songs.findFirst({
        where: {
          title:    { equals: song.title,  mode: "insensitive" },
          artist:   { equals: song.artist, mode: "insensitive" },
          source:   song.source,
        },
        select: { id: true, rank_history: true, peak_rank: true },
      });

      // Build updated rank history
      const prevHistory: RankHistoryEntry[] =
        (existing?.rank_history as RankHistoryEntry[]) || [];

      const todayEntry: RankHistoryEntry = {
        date:    dateStr,
        rank:    song.chart_position,
        streams: song.streams_today.toString(),
        source:  song.source,
      };

      // Avoid duplicate entries on same date
      const history = prevHistory.filter((h) => h.date !== dateStr);
      history.push(todayEntry);
      // Keep last 30 days only
      const trimmedHistory = history.slice(-30);

      const lifecycle = computeLifecycle(trimmedHistory);
      const signal    = computeSignal(lifecycle, song.chart_position);
      const growth    = computeGrowthLabel(song.chart_change);

      const peakRank = Math.min(
        song.chart_position,
        existing?.peak_rank ?? song.chart_position,
      );

      if (existing) {
        await (prisma as any).live_songs.update({
          where: { id: existing.id },
          data: {
            chart_position: song.chart_position,
            chart_change:   song.chart_change,
            streams_today:  song.streams_today,
            language:       song.language,
            lifecycle,
            signal,
            growth,
            niche_tags:     song.niche_tags,
            mood_tags:      song.mood_tags,
            rank_history:   trimmedHistory as any,
            peak_rank:      peakRank,
            raw_data:       song.raw_data as any,
            fetched_at:     new Date(),
            expires_at:     expiresAt,
          },
        });
      } else {
        await (prisma as any).live_songs.create({
          data: {
            source:         song.source,
            title:          song.title,
            artist:         song.artist,
            chart_position: song.chart_position,
            chart_change:   song.chart_change,
            streams_today:  song.streams_today,
            language:       song.language,
            lifecycle,
            signal,
            growth,
            niche_tags:     song.niche_tags,
            mood_tags:      song.mood_tags,
            rank_history:   [todayEntry] as any,
            peak_rank:      song.chart_position,
            raw_data:       song.raw_data as any,
            fetched_at:     new Date(),
            expires_at:     expiresAt,
          },
        });
      }

      upserted++;
    } catch (err: any) {
      logger.warn({ err: err.message, title: song.title }, "Song upsert failed");
    }
  }

  logger.info({ upserted, total: songs.length }, "Songs upserted into live_songs");
  return upserted;
}

// ── Update song_trajectories from current live_songs ─────────────────────────

export async function updateSongTrajectories(): Promise<number> {
  const songs = await (prisma as any).live_songs.findMany({
    where: { expires_at: { gt: new Date() } },
    select: {
      title:          true,
      artist:         true,
      language:       true,
      lifecycle:      true,
      chart_position: true,
      rank_history:   true,
      niche_tags:     true,
      source:         true,
    },
  });

  let updated = 0;

  for (const song of songs) {
    try {
      const history = (song.rank_history as RankHistoryEntry[]) || [];
      const lifecycle = computeLifecycle(history);
      const ranks    = history.map((h) => h.rank);
      const peakRank = ranks.length ? Math.min(...ranks) : song.chart_position;
      const peakEntry = history.find((h) => h.rank === peakRank);

      const existing = await (prisma as any).song_trajectories.findFirst({
        where: {
          song_title: { equals: song.title,    mode: "insensitive" },
          language:   { equals: song.language, mode: "insensitive" },
        },
        select: { id: true, first_seen: true, confidence: true },
      });

      const confidence = Math.min(
        0.99,
        (Number(existing?.confidence || 0.5)) + (history.length >= 5 ? 0.1 : 0.02),
      );

      const payload = {
        song_title:  song.title,
        artist:      song.artist,
        language:    song.language || "unknown",
        lifecycle,
        rank_history: history as any,
        peak_rank:   peakRank,
        peak_at:     peakEntry ? new Date(peakEntry.date) : null,
        niche_tags:  song.niche_tags || [],
        source:      song.source,
        confidence,
        updated_at:  new Date(),
      };

      if (existing) {
        await (prisma as any).song_trajectories.update({
          where: { id: existing.id },
          data:  payload,
        });
      } else {
        await (prisma as any).song_trajectories.create({
          data: { ...payload, first_seen: new Date() },
        });
      }

      updated++;
    } catch (err: any) {
      logger.warn({ err: err.message, title: song.title }, "Trajectory update failed");
    }
  }

  logger.info({ updated, total: songs.length }, "Song trajectories updated");
  return updated;
}

// ── Cleanup expired songs ─────────────────────────────────────────────────────

export async function cleanupExpiredSongs(): Promise<number> {
  try {
    const result = await prisma.$queryRawUnsafe<{ count: string }[]>(
      `DELETE FROM live_songs WHERE expires_at < NOW() RETURNING id`,
    );
    const deleted = result.length;
    if (deleted > 0) {
      logger.info({ deleted }, "Expired songs cleaned up");
    }
    return deleted;
  } catch (err: any) {
    logger.warn({ err: err.message }, "Song cleanup failed");
    return 0;
  }
}
