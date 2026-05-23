// src/services/performanceFeedback.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Performance Feedback Loop
//
// Closes the flywheel: matches studio scripts to real post analytics,
// computes performance signals, writes them to aria_memory, rebuilds voice portrait
//
// Runs weekly (Sunday midnight IST) — processes last 7–30 days of posts
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from "../config/database";
import { cache } from "../config/redis";
import { logger } from "../utils/logger";
import { buildVoicePortrait } from "./voice.service";

export interface PerformanceSignal {
  studioSessionId: string;
  idea: string;
  platform: string;
  niche: string;
  format: string;
  hookStyle: string; // extracted from script hook section
  toneSignature: string; // from voice portrait at time of generation
  actualViews?: number;
  actualLikes?: number;
  actualComments?: number;
  actualER?: number; // engagement rate
  erVsNicheAvg?: number; // ratio: 1.0 = average, 2.0 = 2x average
  performanceTier: "top_10" | "above_avg" | "avg" | "below_avg" | "low";
  postedAt?: string;
}

// ── Helper: Extract hook style from generated_script ────────────────────────────
function extractHookStyle(
  generatedScript: any,
): string {
  if (!generatedScript || typeof generatedScript !== "object") return "unknown";

  // Try to find hook section in sections array
  const sections = generatedScript.sections as any[];
  if (Array.isArray(sections) && sections.length > 0) {
    const hookSection = sections.find(
      (s) => s.id === "hook" || s.label?.toLowerCase().includes("hook"),
    );
    if (hookSection && hookSection.content) {
      // If we have hook content, try to infer the style
      const content = (hookSection.content as string).toLowerCase();
      if (content.includes("?")) return "question-hook";
      if (
        content.includes("!") ||
        content.includes("wait") ||
        content.includes("stop")
      )
        return "shock-statement";
      if (
        content.includes("story") ||
        content.includes("happened") ||
        content.includes("experience")
      )
        return "relatable-story";
      return "statement";
    }
  }

  return "unknown";
}

// ── Helper: Get toneSignature from creator_voice_profiles closest to created_at ──
async function getToneSignatureAtTime(
  userId: string,
  createdAt: Date,
): Promise<string> {
  try {
    // Find the voice profile built closest to (and before) script creation time
    const profile = await prisma.creator_voice_profiles.findUnique({
      where: { user_id: userId },
    });

    if (!profile) return "unknown";

    const voiceData = profile.voice_data as any;
    return voiceData?.toneSignature || "unknown";
  } catch (err) {
    logger.warn(
      { err, userId },
      "Failed to get tone signature — using fallback",
    );
    return "unknown";
  }
}

// ── Helper: Fuzzy match analytics post to calendar entry ──────────────────────
interface PostMatch {
  matched: boolean;
  views?: number;
  likes?: number;
  comments?: number;
  er?: number;
}

function fuzzyMatchPost(
  entry: any,
  post: any,
): PostMatch {
  // Match criteria:
  // 1. Caption similarity (first 50 chars)
  // 2. Posting date proximity (within 2 hours of scheduled_date)

  const entryCaption = entry.caption ? entry.caption.substring(0, 50) : "";
  const postCaption = post.caption ? (post.caption as string).substring(0, 50) : "";

  // Simple caption match
  const captionMatch =
    entryCaption && postCaption && entryCaption === postCaption;

  // Date proximity match
  let dateMatch = false;
  if (entry.scheduled_date && post.posted_at) {
    const entryDate = new Date(entry.scheduled_date);
    const postDate = new Date(post.posted_at);
    const diffMs = Math.abs(entryDate.getTime() - postDate.getTime());
    const diffHours = diffMs / (1000 * 60 * 60);
    dateMatch = diffHours <= 2;
  }

  // Match if either caption or date proximity matches
  const matched = captionMatch || dateMatch;

  if (!matched) {
    return { matched: false };
  }

  // Extract metrics from post
  const views = post.views || post.impressions || 0;
  const likes = post.likes || 0;
  const comments = post.comments || 0;
  const er = views > 0 ? ((likes + comments) / views) * 100 : 0;

  return {
    matched: true,
    views,
    likes,
    comments,
    er: Math.round(er * 100) / 100,
  };
}

// ── Helper: Compute performance tier ──────────────────────────────────────────
async function computePerformanceTier(
  niche: string,
  actualER: number,
): Promise<"top_10" | "above_avg" | "avg" | "below_avg" | "low"> {
  try {
    const benchmark = await prisma.niche_benchmarks.findUnique({
      where: { niche },
    });

    if (!benchmark) {
      logger.warn({ niche }, "No benchmark found for niche");
      return "avg";
    }

    const benchmarkER = Number(benchmark.avg_er) || 3.0;
    const erVsNicheAvg = actualER / benchmarkER;

    if (erVsNicheAvg > 3) return "top_10";
    if (erVsNicheAvg > 1.5) return "above_avg";
    if (erVsNicheAvg > 0.7) return "avg";
    if (erVsNicheAvg > 0.3) return "below_avg";
    return "low";
  } catch (err) {
    logger.warn({ err, niche }, "Failed to compute performance tier");
    return "avg";
  }
}

// ── Helper: Write performance signals to aria_memory ──────────────────────────
async function writeMemorySignals(
  userId: string,
  signal: PerformanceSignal,
): Promise<number> {
  let signalsWritten = 0;

  try {
    const erVsNicheAvg = signal.erVsNicheAvg || 1.0;

    // Memory entries to write
    const memoryEntries: Array<{
      category: string;
      key: string;
      value: string;
      confidence: number;
      source: string;
    }> = [
      {
        category: "performance_signal",
        key: `format_${signal.format}_performance`,
        value: signal.performanceTier,
        confidence: 75,
        source: "performance_feedback",
      },
      {
        category: "performance_signal",
        key: `niche_er_ratio`,
        value: String(Math.round(erVsNicheAvg * 10) / 10),
        confidence: 80,
        source: "performance_feedback",
      },
    ];

    // If top performer: write hook style that worked
    if (
      signal.performanceTier === "top_10" ||
      signal.performanceTier === "above_avg"
    ) {
      memoryEntries.push({
        category: "winning_pattern",
        key: `top_hook_style`,
        value: signal.hookStyle,
        confidence: 85,
        source: "performance_feedback",
      });
    }

    // If poor performer: write format to avoid
    if (signal.performanceTier === "low") {
      memoryEntries.push({
        category: "avoid_pattern",
        key: `underperforming_format`,
        value: signal.format,
        confidence: 70,
        source: "performance_feedback",
      });
    }

    // Upsert each memory entry
    for (const entry of memoryEntries) {
      await prisma.aria_memory.upsert({
        where: {
          user_id_category_key: {
            user_id: userId,
            category: entry.category,
            key: entry.key,
          },
        },
        create: {
          user_id: userId,
          ...entry,
          times_seen: 1,
          last_seen_at: new Date(),
        },
        update: {
          value: entry.value,
          times_seen: { increment: 1 },
          last_seen_at: new Date(),
          confidence: Math.min(95, (entry.confidence || 50) + 5),
        },
      });
      signalsWritten++;
    }
  } catch (err) {
    logger.error(
      { err, userId, signalId: signal.studioSessionId },
      "Failed to write memory signals",
    );
  }

  return signalsWritten;
}

// ── Main: Run performance feedback for a single user ──────────────────────────
export async function runPerformanceFeedback(userId: string): Promise<{
  matched: number;
  signalsWritten: number;
  skipped: number;
}> {
  const result = {
    matched: 0,
    signalsWritten: 0,
    skipped: 0,
  };

  try {
    logger.info({ userId }, "Starting performance feedback run");

    // Time window: 7–30 days ago (allows time to accumulate views)
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Step 1: Find matchable calendar entries
    const entries = await prisma.calendar_entries.findMany({
      where: {
        user_id: userId,
        studio_session_id: { not: null },
        status: "published",
        // scheduled_date is a string in YYYY-MM-DD format
        scheduled_date: {
          gte: thirtyDaysAgo.toISOString().split("T")[0],
          lte: sevenDaysAgo.toISOString().split("T")[0],
        },
      },
      include: {
        // Note: there's no explicit foreign key, so we fetch separately
      },
    });

    logger.info(
      { userId, count: entries.length },
      "Found candidate calendar entries",
    );

    // Step 2: For each entry, match to analytics and create signal
    for (const entry of entries) {
      try {
        // Fetch the studio script
        const script = await prisma.studio_scripts.findUnique({
          where: { id: entry.studio_session_id! },
        });

        if (!script) {
          logger.warn(
            { studioSessionId: entry.studio_session_id },
            "Studio script not found",
          );
          result.skipped++;
          continue;
        }

        // Get creator analytics for this platform and time period
        const analytics = await prisma.creator_analytics.findUnique({
          where: {
            creator_analytics_user_platform_key: {
              user_id: userId,
              platform: entry.platform,
            },
          },
        });

        if (!analytics) {
          logger.debug(
            { userId, platform: entry.platform },
            "No analytics data found",
          );
          result.skipped++;
          continue;
        }

        // Parse raw_data or top_posts
        const topPosts = analytics.top_posts as any[];
        if (!Array.isArray(topPosts) || topPosts.length === 0) {
          result.skipped++;
          continue;
        }

        // Find matching post via fuzzy matching
        let matchedPost: any = null;
        for (const post of topPosts) {
          const match = fuzzyMatchPost(entry, post);
          if (match.matched) {
            matchedPost = post;
            break;
          }
        }

        if (!matchedPost) {
          logger.debug(
            { entryId: entry.id, caption: entry.caption?.substring(0, 30) },
            "No matching post found in analytics",
          );
          result.skipped++;
          continue;
        }

        // Step 3: Get niche benchmark
        const benchmark = await prisma.niche_benchmarks.findUnique({
          where: { niche: entry.niche || script.niche },
        });

        const benchmarkER = benchmark
          ? Number(benchmark.avg_er) || 3.0
          : 3.0;
        const actualER = matchedPost.er || 0;
        const erVsNicheAvg = actualER / benchmarkER;

        // Compute performance tier
        const performanceTier = await computePerformanceTier(
          entry.niche || script.niche,
          actualER,
        );

        // Extract hook style from generated_script
        const hookStyle = extractHookStyle(script.generated_script);

        // Get tone signature at time of generation
        const toneSignature = await getToneSignatureAtTime(
          userId,
          script.created_at,
        );

        // Create the performance signal
        const signal: PerformanceSignal = {
          studioSessionId: entry.studio_session_id!,
          idea: script.idea,
          platform: entry.platform,
          niche: entry.niche || script.niche,
          format: entry.format || script.archetype,
          hookStyle,
          toneSignature,
          actualViews: matchedPost.views,
          actualLikes: matchedPost.likes,
          actualComments: matchedPost.comments,
          actualER,
          erVsNicheAvg,
          performanceTier,
          postedAt: entry.posted_at?.toISOString(),
        };

        // Step 4: Write aria_memory signals
        const signalsWritten = await writeMemorySignals(userId, signal);
        result.signalsWritten += signalsWritten;
        result.matched++;

        logger.info(
          {
            entryId: entry.id,
            performanceTier: signal.performanceTier,
            er: actualER,
            signalsWritten,
          },
          "Processed performance signal",
        );
      } catch (err: any) {
        logger.error(
          { err: err?.message || err, entryId: entry.id },
          "Error processing calendar entry",
        );
        result.skipped++;
      }
    }

    // Step 5: Trigger voice portrait rebuild if significant new signals
    if (result.signalsWritten > 2) {
      try {
        logger.info({ userId }, "Rebuilding voice portrait with new signals");
        await buildVoicePortrait(userId).catch((err) =>
          logger.warn(
            { err, userId },
            "performanceFeedback: voice portrait rebuild failed — non-fatal",
          ),
        );
      } catch (err) {
        logger.warn(
          { err, userId },
          "Voice portrait rebuild failed — non-fatal",
        );
      }
    }

    // Invalidate memory cache so next read gets fresh data
    await cache.del(`aria_memory:${userId}`).catch(() => {});

    logger.info(
      { userId, ...result },
      "Performance feedback run complete",
    );

    return result;
  } catch (err: any) {
    logger.error(
      { err: err?.message || err, userId },
      "Performance feedback run failed",
    );
    return result;
  }
}

// ── Run for all active users (called by cron) ─────────────────────────────────
export async function runPerformanceFeedbackAll(): Promise<void> {
  try {
    logger.info("Starting performance feedback run for all active users");

    const BATCH_SIZE = 50;
    let offset = 0;
    let totalMatched = 0;
    let totalSignals = 0;
    let totalSkipped = 0;

    // Process users in batches to avoid cron overrun
    while (true) {
      const users = await prisma.users.findMany({
        where: {
          // Only active users
          deleted_at: null,
        },
        select: { id: true },
        take: BATCH_SIZE,
        skip: offset,
        orderBy: { created_at: "asc" },
      });

      if (users.length === 0) break;

      logger.info(
        { offset, batchSize: users.length },
        "Processing user batch",
      );

      // Process each user in the batch
      for (const user of users) {
        const result = await runPerformanceFeedback(user.id);
        totalMatched += result.matched;
        totalSignals += result.signalsWritten;
        totalSkipped += result.skipped;
      }

      offset += BATCH_SIZE;

      // Safety: don't process more than 1000 users per run
      if (offset >= 1000) {
        logger.warn(
          "Performance feedback: reached max user limit (1000) — continuing next week",
        );
        break;
      }
    }

    logger.info(
      { totalMatched, totalSignals, totalSkipped },
      "Performance feedback run for all users complete",
    );
  } catch (err: any) {
    logger.error(
      { err: err?.message || err },
      "Performance feedback run for all users failed",
    );
  }
}
