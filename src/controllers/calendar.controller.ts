import { FastifyRequest, FastifyReply } from "fastify";
import ariaService from "../services/ariaService";
import { getCache, setCache } from "../services/cacheWrapper";
import { prisma } from "../config/database";
import { User } from "../types";
import { logger } from "../utils/logger";
import { debitCredits } from "../services/credits.service";
import { alertDebitFailed } from "../utils/alerting";

interface GenerateCalendarBody {
  niche: string;
  platform: string;
  followerRange: string;
  month: string;
  year: number;
}

export const generate = async (
  req: FastifyRequest<{ Body: GenerateCalendarBody }>,
  reply: FastifyReply,
) => {
  const { niche, platform, followerRange, month, year } = req.body;
  const user = req.user as User;
  const userId = user?.id ?? "anonymous";

  const cacheKey = `calendar:${userId}:${month}:${year}:${niche}:${platform}`;

  try {
    // 1. Check cache first (TTL: 1 hour)
    const cached = await getCache(cacheKey);
    if (cached) {
      logger.info({ cacheKey }, "Calendar cache hit");
      return reply.send({ success: true, data: cached, fromCache: true });
    }

    // 2. Generate with ARIA
    logger.info(
      { niche, platform, month, year },
      "Generating calendar with ARIA",
    );
    const calendar = await ariaService.generateCalendar({
      niche,
      platform,
      followerRange,
      month,
      year,
    });

    // 3. Cache the result (1 hour TTL)
    await setCache(cacheKey, calendar, 3600);

    // 4. Log the event (async)
    if (userId !== "anonymous") {
      prisma.analytics
        .create({
          data: {
            user_id: userId,
            event: "calendar_generated",
            platform,
            niche,
            metadata: { month, year },
            created_at: new Date(),
          },
        })
        .catch((err) => logger.error({ err }, "Analytics insert failed"));

      // Debit AFTER successful calendar generation
      const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";
      await debitCredits(
        userId,
        "content_calendar",
        modelToUse,
        2500,
        1200,
     
      ).catch((err) => alertDebitFailed(userId, "content_calendar", err));
    }

    return reply.send({
      success: true,
      data: calendar,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Calendar generation failed");

    // Return a friendly fallback
    const fallback = ariaService.generateCalendarFallback({
      niche,
      platform,
      followerRange,
      month,
      year,
    });
    return reply.send({ success: true, data: fallback, isFallback: true });
  }
};

export const getSaved = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  if (!user?.id) return reply.status(401).send({ error: "Unauthorized" });

  try {
    const result = await prisma.content_calendars.findMany({
      where: { user_id: user.id },
      orderBy: { created_at: "desc" },
      take: 6,
    });
    return reply.send({ success: true, data: result });
  } catch (err) {
    logger.error({ err }, "Failed to fetch saved calendars");
    return reply.status(500).send({ error: "Failed to fetch saved calendars" });
  }
};

interface SaveCalendarBody {
  month: string;
  year: number;
  calendarData: any;
}

export const save = async (
  req: FastifyRequest<{ Body: SaveCalendarBody }>,
  reply: FastifyReply,
) => {
  const { month, year, calendarData } = req.body;
  const user = req.user as User;
  if (!user?.id) return reply.status(401).send({ error: "Unauthorized" });

  try {
    const existing = await prisma.content_calendars.findFirst({
      where: { user_id: user.id, month, year },
      select: { id: true },
    });

    if (existing) {
      await prisma.content_calendars.update({
        where: { id: existing.id },
        data: {
          calendar_data: calendarData,
          created_at: new Date(),
        },
      });
    } else {
      await prisma.content_calendars.create({
        data: {
          user_id: user.id,
          month,
          year,
          calendar_data: calendarData,
          created_at: new Date(),
        },
      });
    }
    return reply.send({ success: true, message: "Calendar saved" });
  } catch (err) {
    logger.error({ err }, "Failed to save calendar");
    return reply.status(500).send({ error: "Failed to save calendar" });
  }
};
