// src/services/digest.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Weekly ARIA Digest Service — builds and sends creator-specific weekly briefs
//
// Runs every Monday at 8:00 AM IST (02:30 UTC)
// Targets: active users (last login within 30 days) with FCM token
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { sendPushNotification } from "../config/firebase";
import { logger } from "../utils/logger";
import { getVoicePortrait } from "./voice.service";
import { rankTrendsByVoiceFit } from "./voiceFit.service";
import { _callGroq } from "./ai/groq.service";
import { checkRivalWatchActivity } from "./rivalWatch.service";

const DIGEST_CACHE_TTL = 60 * 60; // 1 hour — user digests cached briefly

export interface DigestPayload {
  userId: string;
  userName: string;
  topTrends: Array<{ title: string; niche: string; voiceFitGrade: string }>;
  topContentIdea: { title: string; format: string; hookLine: string };
  rivalWatch:
    | Array<{ handle: string; latestPost: string; dnaGrade: string }>
    | null;
  weekNumber: number;
}

/**
 * Build a weekly digest for a single user
 * Returns null if user is inactive or has no FCM token
 */
export async function buildUserDigest(
  userId: string,
): Promise<DigestPayload | null> {
  try {
    // 1. Fetch user record with required fields
    const user = await prisma.users.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        niches: true,
        archetype: true,
        archetype_label: true,
        primary_platform: true,
        fcm_token: true,
        tone_profile: true,
        updated_at: true,
        rival_watch_handles: true,
      },
    });

    if (!user) {
      logger.warn({ userId }, "User not found for digest");
      return null;
    }

    // 2. Check: has FCM token?
    if (!user.fcm_token) {
      logger.debug({ userId }, "User has no FCM token — skipping digest");
      return null;
    }

    // 3. Check: has been active within 30 days?
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if (!user.updated_at || user.updated_at < thirtyDaysAgo) {
      logger.debug(
        { userId, lastUpdated: user.updated_at },
        "User inactive (>30 days) — skipping digest",
      );
      return null;
    }

    // 4. Get voice portrait
    const portrait = await getVoicePortrait(userId);

    // 5. Fetch top 5 trending topics in user's niche
    const userNiche = Array.isArray(user.niches)
      ? (user.niches as any[])[0]
      : "general";

    const trendCacheKey = `trends:niche:${userNiche}`;
    let trends = await cache.get(trendCacheKey);
    if (!trends) {
      // Fetch from DB using niche_tags (GIN indexed array field)
      const trendRecords = await prisma.live_trends.findMany({
        where: {
          niche_tags: { hasSome: [userNiche] },
          expires_at: { gt: new Date() }, // Not expired
        },
        orderBy: [
          { platform_raw_score: "desc" },
          { fetched_at: "desc" },
        ],
        take: 5,
        select: {
          id: true,
          title: true,
          niche_tags: true,
          platform_raw_score: true,
          search_volume: true,
        },
      });

      trends = trendRecords.map((t: any) => ({
        title: t.title,
        niche: t.niche_tags?.[0] || userNiche,
        score: Number(t.platform_raw_score || 50),
        id: t.id,
      }));

      await cache.set(trendCacheKey, trends, 60 * 60); // 1h TTL
    }

    // 6. Score trends via voice fit, pick top 3
    const rankedTrends = rankTrendsByVoiceFit(trends || [], portrait);
    const topTrends = rankedTrends.slice(0, 3).map((t: any) => ({
      title: t.title,
      niche: t.niche,
      voiceFitGrade: t.voiceFit?.badge || "GREAT_FIT", // voiceFit object has badge field
    }));

    if (topTrends.length === 0) {
      logger.warn({ userId }, "No trends found for digest");
      return null;
    }

    // 7. Generate 1 content idea via GPT-4o-mini
    let topContentIdea: { title: string; format: string; hookLine: string } = {
      title: "Trending Topic Alert",
      format: "video",
      hookLine:
        topTrends[0]?.title ||
        "Check out this week's trending content idea",
    };

    try {
      const toneSignature = portrait?.toneSignature || "casual";
      const archetype = user.archetype_label || user.archetype || "creator";

      const ideaPrompt = `Given a "${archetype}" creator in "${userNiche}" who likes "${toneSignature}" content, generate ONE specific video idea for this week.

Respond with valid JSON only:
{
  "title": "concise video title (max 8 words)",
  "format": "reel|youtube_short|carousel|long_form",
  "hookLine": "first sentence hook (max 15 words)"
}`;

      const ideaResult = await _callGroq(ideaPrompt, { maxTokens: 200 });
      if (ideaResult?.title && ideaResult?.format && ideaResult?.hookLine) {
        topContentIdea = ideaResult;
      }
    } catch (err) {
      logger.warn({ err, userId }, "Failed to generate content idea");
      // Fall back to trend-based idea (already set above)
    }

    // 8. Include rival watch data if user has rival handles
    let rivalWatch: Array<{
      handle: string;
      latestPost: string;
      dnaGrade: string;
    }> | null = null;

    if (
      user.rival_watch_handles &&
      Array.isArray(user.rival_watch_handles) &&
      user.rival_watch_handles.length > 0
    ) {
      try {
        rivalWatch = await checkRivalWatchActivity(
          user.rival_watch_handles,
          userId,
        );
      } catch (err) {
        logger.warn({ err, userId }, "Failed to fetch rival watch activity");
        rivalWatch = null;
      }
    }

    // 9. Calculate week number (ISO week)
    const now = new Date();
    const onejan = new Date(now.getFullYear(), 0, 1);
    const millisecsInDay = 86400000;
    const weekNumber = Math.ceil(
      (now.getTime() - onejan.getTime() + onejan.getDay() * millisecsInDay) /
        (7 * millisecsInDay),
    );

    const digest: DigestPayload = {
      userId,
      userName: user.name || "Creator",
      topTrends,
      topContentIdea,
      rivalWatch,
      weekNumber,
    };

    logger.info(
      { userId, weekNumber, trendCount: topTrends.length },
      "Digest built successfully",
    );
    return digest;
  } catch (err) {
    logger.error({ err, userId }, "Error building user digest");
    return null;
  }
}

/**
 * Send a built digest as a push notification
 */
export async function sendDigestNotification(
  digest: DigestPayload,
  fcmToken: string,
): Promise<void> {
  try {
    const topTrendTitle = digest.topTrends[0]?.title || "trending content";

    const title = "Your weekly ARIA brief is ready 🧠";
    const body = `3 trends ranked for you · ${topTrendTitle} leads this week`;
    const data = {
      type: "weekly_digest",
      weekNumber: String(digest.weekNumber),
      deepLink: "/dashboard/discover",
    };

    await sendPushNotification({ token: fcmToken, title, body, data });
    logger.info(
      { userId: digest.userId, weekNumber: digest.weekNumber },
      "Digest notification sent",
    );
  } catch (err) {
    logger.error(
      { err, userId: digest.userId },
      "Failed to send digest notification",
    );
  }
}

/**
 * Run weekly digest for ALL active users
 * Called by cron every Monday at 8:00 AM IST
 */
export async function runWeeklyDigest(): Promise<{
  sent: number;
  failed: number;
  skipped: number;
}> {
  const result = { sent: 0, failed: 0, skipped: 0 };

  try {
    // Query: active users with FCM token
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const activeUsers = await prisma.users.findMany({
      where: {
        fcm_token: { not: null },
        updated_at: { gte: thirtyDaysAgo },
      },
      select: {
        id: true,
        fcm_token: true,
      },
    });

    logger.info(
      { totalUsers: activeUsers.length },
      "Starting weekly digest run",
    );

    for (const user of activeUsers) {
      try {
        const digest = await buildUserDigest(user.id);
        if (!digest) {
          result.skipped++;
          continue;
        }

        await sendDigestNotification(digest, user.fcm_token);
        result.sent++;
      } catch (err) {
        logger.error({ err, userId: user.id }, "Error processing digest");
        result.failed++;
      }
    }

    logger.info(result, "Weekly digest run complete");
    return result;
  } catch (err) {
    logger.error({ err }, "Weekly digest run failed");
    throw err;
  }
}
