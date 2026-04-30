import { prisma } from "../config/database";
import { logger } from "../utils/logger";
import { scrapeAndSaveProfile } from "../services/scraper.service";
import * as groqService from "../services/ai/groq.service";

export interface ScrapeJobData {
  userId: string;
  handle: string;
  platform: "instagram" | "youtube";
}

export interface ScrapeJob {
  id: string;
  data: ScrapeJobData;
}

/**
 * Accepts a plain job-like object: { id: string, data: { userId, handle, platform } }
 */
export const processScrapeJob = async (job: ScrapeJob) => {
  const { userId, handle, platform } = job.data;

  try {
    logger.info(
      { userId, handle, platform, jobId: job.id },
      "Processing scrape job",
    );

    const scrapeResult = await scrapeAndSaveProfile(userId, handle, platform);

    logger.info(
      { userId, followers: scrapeResult.followers, jobId: job.id },
      "Profile scraped successfully",
    );

    const updatedUser = await (prisma.users as any).findUnique({
      where: { id: userId },
    });
    if (!updatedUser) throw new Error(`User ${userId} not found`);

    try {
      const archetypeResult = await groqService.detectArchetype({
        niche: updatedUser.niches?.[0] || "fashion",
        platform: updatedUser.primary_platform || "instagram",
        followerRange: updatedUser.follower_range || "0-1K",
        creatorIntent: updatedUser.creator_intent,
        scrapedData: updatedUser.scraped_summary,
      });

      await prisma.users.update({
        where: { id: userId },
        data: {
          archetype: archetypeResult.archetype,
          archetype_label: archetypeResult.archetypeLabel,
          archetype_confidence: archetypeResult.archetypeConfidence,
          growth_stage: archetypeResult.growthStage,
          tone_profile: archetypeResult.toneProfile,
          health_score: archetypeResult.healthScore || 75,
          aria_analyzed_at: new Date(),
        },
      });

      logger.info(
        { userId, archetype: archetypeResult.archetype, jobId: job.id },
        "ARIA archetype updated",
      );
    } catch (aiErr) {
      logger.warn(
        { err: aiErr, userId, jobId: job.id },
        "ARIA re-analysis failed (non-blocking)",
      );
    }

    logger.info({ userId, jobId: job.id }, "Scrape job completed successfully");
    return {
      success: true,
      followers: scrapeResult.followers,
      engagementRate: scrapeResult.engagement_rate,
    };
  } catch (err) {
    logger.error({ err, userId, handle, jobId: job.id }, "Scrape job failed");
    throw err;
  }
};

/**
 * Dispatch is handled by enqueueScrapeJob() in queue.js
 */
export const startScrapeWorker = async () => {
  const SCRAPE_ENABLED = process.env.SCRAPE_ENABLED !== "false";
  if (!SCRAPE_ENABLED) {
    logger.info("Scrape worker disabled via SCRAPE_ENABLED=false");
    return null;
  }
  logger.info("Scrape processor ready (dispatched on-demand via queue.js)");
  return null;
};
