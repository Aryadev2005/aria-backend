// src/services/rivalWatch.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Rival Watch Service — monitors bookmarked competitor handles for new
// high-performing posts
//
// Runs every 6 hours via cron
// Throttled: max 5 concurrent users, max 2 handles per user per run
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { sendPushNotification } from "../config/firebase";
import { logger } from "../utils/logger";
import { harvestTopContent, scorePosts, RivalHandle, RivalPost } from "./rival.service";
import pLimit from "p-limit";

const RIVAL_CHECK_CACHE_TTL = 4 * 60 * 60; // 4 hours per handle
const MAX_CONCURRENT_USERS = 5;
const MAX_HANDLES_PER_USER = 2;

export interface RivalCheckResult {
  post: RivalPost;
  dnaScore: number;
}

/**
 * Check a single rival handle for new content
 * Returns top post if DNA score > 75, otherwise null
 * Uses cache to avoid re-scraping same handle within 4 hours
 */
export async function checkRivalForNewContent(
  handle: string,
  platform: "instagram" | "youtube" | "auto",
  userId: string,
): Promise<RivalCheckResult | null> {
  try {
    const cacheKey = `rival_check:${handle.toLowerCase()}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      logger.debug(
        { handle, userId },
        "Rival check hit cache",
      );
      return cached as RivalCheckResult | null;
    }

    // Resolve handle and harvest top content
    const resolvedHandle: RivalHandle = {
      raw: handle,
      platform: platform === "auto" ? "instagram" : platform,
      username: handle.replace(/^@/, "").replace(/\/$/, ""),
      resolved: true,
    };

    const posts = await harvestTopContent([resolvedHandle]);
    if (!posts || posts.length === 0) {
      logger.debug({ handle, userId }, "No posts harvested for rival");
      await cache.set(cacheKey, null, RIVAL_CHECK_CACHE_TTL);
      return null;
    }

    // Score posts — pass a dummy niche since we're just checking DNA
    const scoredPosts = await scorePosts(posts, "general");
    if (!scoredPosts || scoredPosts.length === 0) {
      await cache.set(cacheKey, null, RIVAL_CHECK_CACHE_TTL);
      return null;
    }

    // Take first (newest) post
    const topPost = scoredPosts[0];
    const dnaScore = topPost.dnaScore || 0;

    // Only return if DNA score > 75
    if (dnaScore > 75) {
      const result: RivalCheckResult = { post: topPost, dnaScore };
      await cache.set(cacheKey, result, RIVAL_CHECK_CACHE_TTL);
      logger.info(
        { handle, userId, dnaScore },
        "Rival post qualifies (DNA > 75)",
      );
      return result;
    }

    logger.debug(
      { handle, userId, dnaScore },
      "Rival post does not qualify (DNA <= 75)",
    );
    await cache.set(cacheKey, null, RIVAL_CHECK_CACHE_TTL);
    return null;
  } catch (err) {
    logger.error(
      { err, handle, userId },
      "Error checking rival for new content",
    );
    return null;
  }
}

/**
 * Check rival activity for digest building (non-notifying)
 * Returns latest posts for each handle with DNA grades
 */
export async function checkRivalWatchActivity(
  handles: string[],
  userId: string,
): Promise<Array<{ handle: string; latestPost: string; dnaGrade: string }>> {
  try {
    if (!handles || handles.length === 0) return [];

    const results: Array<{
      handle: string;
      latestPost: string;
      dnaGrade: string;
    }> = [];

    for (const handle of handles.slice(0, 5)) {
      // Limit to 5 handles per digest
      try {
        const check = await checkRivalForNewContent(handle, "auto", userId);
        if (check) {
          results.push({
            handle: handle.replace(/^@/, ""),
            latestPost: check.post.title || check.post.caption || "Post",
            dnaGrade:
              check.post.dnaGrade || `${Math.round(check.dnaScore)}/100`,
          });
        }
      } catch (err) {
        logger.warn(
          { err, handle, userId },
          "Error checking activity for handle",
        );
      }
    }

    return results;
  } catch (err) {
    logger.error(
      { err, userId },
      "Error checking rival watch activity",
    );
    return [];
  }
}

/**
 * Run rival watch check for ALL users who have rival handles
 * Called by cron every 6 hours
 * Throttled: max 5 concurrent users, max 2 handles per user per run
 */
export async function runRivalWatchCheck(): Promise<{
  notified: number;
  checked: number;
}> {
  const result = { notified: 0, checked: 0 };

  try {
    // Query: users with rival handles and FCM token
    const usersWithRivals = await prisma.users.findMany({
      where: {
        rival_watch_handles: { not: { equals: [] } },
        fcm_token: { not: null },
      },
      select: {
        id: true,
        name: true,
        fcm_token: true,
        rival_watch_handles: true,
        rival_watch_last_notified_at: true,
        primary_platform: true,
      },
    });

    logger.info(
      { totalUsers: usersWithRivals.length },
      "Starting rival watch check",
    );

    // Throttle: max 5 concurrent users
    const limiter = pLimit(MAX_CONCURRENT_USERS);
    const promises = usersWithRivals.map((user) =>
      limiter(async () => {
        try {
          // Throttle: max 2 handles per user per run
          const handlesToPoll = (
            user.rival_watch_handles as string[]
          ).slice(0, MAX_HANDLES_PER_USER);

          for (const handle of handlesToPoll) {
            result.checked++;

            const check = await checkRivalForNewContent(
              handle,
              user.primary_platform === "youtube" ? "youtube" : "instagram",
              user.id,
            );

            if (!check) continue;

            // Check throttle: only notify if last notification > 6 hours ago
            const lastNotified = user.rival_watch_last_notified_at;
            const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

            if (lastNotified && lastNotified > sixHoursAgo) {
              logger.debug(
                { userId: user.id, handle },
                "Rival notification throttled (< 6 hours since last)",
              );
              continue;
            }

            // Notify
            try {
              const title = `👀 ${handle} just posted something worth watching`;
              const body = `DNA score: ${Math.round(check.dnaScore)}/100 · Steal Card ready in Rival Spy`;
              const data = {
                type: "rival_watch",
                handle: handle.replace(/^@/, ""),
                deepLink: "/dashboard/spy",
              };

              await sendPushNotification({
                token: user.fcm_token,
                title,
                body,
                data,
              });

              // Update last notified timestamp
              await prisma.users.update({
                where: { id: user.id },
                data: { rival_watch_last_notified_at: new Date() },
              });

              result.notified++;
              logger.info(
                { userId: user.id, handle, score: check.dnaScore },
                "Rival watch notification sent",
              );
            } catch (err) {
              logger.error(
                { err, userId: user.id, handle },
                "Failed to send rival watch notification",
              );
            }
          }
        } catch (err) {
          logger.error(
            { err, userId: user.id },
            "Error processing user rival watch",
          );
        }
      }),
    );

    await Promise.allSettled(promises);

    logger.info(result, "Rival watch check complete");
    return result;
  } catch (err) {
    logger.error({ err }, "Rival watch check failed");
    throw err;
  }
}
