// src/controllers/calendarEntry.controller.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { success, errors } from '../utils/response';
import { logger } from '../utils/logger';
import { User } from '../types';
import { getTimingIntelligence } from '../services/launch.service';

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/calendar/entries  — create a single entry
// ─────────────────────────────────────────────────────────────────────────────
export const createEntry = async (
  req: FastifyRequest<{ Body: {
    title: string;
    idea?: string;
    platform?: string;
    niche?: string;
    format?: string;
    scheduled_date: string;
    scheduled_time?: string;
    status?: string;
    studio_session_id?: string;
    source?: string;
    hook?: string;
    caption?: string;
    hashtags?: string[];
    aria_tip?: string;
    is_ai_suggested?: boolean;
  }}>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const body = req.body;

  try {
    const entry = await (prisma as any).calendar_entries.create({
      data: {
        user_id:           user.id,
        title:             body.title,
        idea:              body.idea || null,
        platform:          body.platform || user.primary_platform || 'instagram',
        niche:             body.niche   || (user.niches as any)?.[0] || 'general',
        format:            body.format  || null,
        scheduled_date:    body.scheduled_date,
        scheduled_time:    body.scheduled_time || null,
        status:            body.status  || 'idea',
        studio_session_id: body.studio_session_id || null,
        source:            body.source  || 'manual',
        hook:              body.hook    || null,
        caption:           body.caption || null,
        hashtags:          body.hashtags || [],
        aria_tip:          body.aria_tip || null,
        is_ai_suggested:   body.is_ai_suggested || false,
        ai_accepted:       body.is_ai_suggested ? false : true,
      },
    });

    // Fire-and-forget: generate timing suggestion and cache it by entry ID
    const entryId = entry.id;
    getTimingIntelligence({
      archetype: user.archetype || 'EDUCATOR',
      niche:     body.niche || (user.niches as any)?.[0] || 'general',
      platform:  body.platform || user.primary_platform || 'instagram',
      followerRange: user.follower_range || '10K-50K',
    }).then((timing) =>
      cache.set(`timing:entry:${entryId}`, JSON.stringify(timing), 'EX', 43200),
    ).catch((err) => logger.warn({ err, entryId }, 'Entry timing suggestion failed — non-fatal'));

    return success(reply, entry);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'createEntry failed');
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/calendar/entries/:id/timing-suggestion
// ─────────────────────────────────────────────────────────────────────────────
export const getTimingSuggestion = async (
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { id } = req.params;

  try {
    const entry = await (prisma as any).calendar_entries.findFirst({
      where: { id, user_id: user.id },
      select: { id: true, platform: true, niche: true },
    });
    if (!entry) return errors.notFound(reply, 'Calendar entry');

    const cacheKey = `timing:entry:${id}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return success(reply, { timing: JSON.parse(cached as string), fromCache: true });
    }

    // On-demand generation if not yet cached
    const timing = await getTimingIntelligence({
      archetype:    user.archetype || 'EDUCATOR',
      niche:        entry.niche    || (user.niches as any)?.[0] || 'general',
      platform:     entry.platform || user.primary_platform    || 'instagram',
      followerRange: user.follower_range || '10K-50K',
    });

    await cache.set(cacheKey, JSON.stringify(timing), 'EX', 43200).catch(() => {});
    return success(reply, { timing, fromCache: false });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getTimingSuggestion failed');
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/calendar/entries?month=YYYY-MM — fetch a month's entries
// ─────────────────────────────────────────────────────────────────────────────
export const getEntries = async (
  req: FastifyRequest<{ Querystring: { month?: string } }>,
  reply: FastifyReply,
) => {
  const user  = req.user as User;
  const month = req.query.month; // "2025-08"

  try {
    const where: any = { user_id: user.id };
    if (month) {
      where.scheduled_date = { startsWith: month };
    }

    const entries = await (prisma as any).calendar_entries.findMany({
      where,
      orderBy: { scheduled_date: 'asc' },
    });

    return success(reply, entries);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getEntries failed');
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/v1/calendar/entries/:id — update status / reschedule
// ─────────────────────────────────────────────────────────────────────────────
export const updateEntry = async (
  req: FastifyRequest<{
    Params: { id: string };
    Body: {
      status?: string;
      scheduled_date?: string;
      scheduled_time?: string;
      caption?: string;
      posted_at?: string;
      ai_accepted?: boolean;
    };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { id } = req.params;
  const body = req.body;

  try {
    // Ownership check
    const existing = await (prisma as any).calendar_entries.findFirst({
      where: { id, user_id: user.id },
      select: { id: true },
    });
    if (!existing) return errors.notFound(reply, 'Calendar entry');

    const updated = await (prisma as any).calendar_entries.update({
      where: { id },
      data: {
        ...(body.status         && { status: body.status }),
        ...(body.scheduled_date && { scheduled_date: body.scheduled_date }),
        ...(body.scheduled_time !== undefined && { scheduled_time: body.scheduled_time }),
        ...(body.caption        && { caption: body.caption }),
        ...(body.posted_at      && { posted_at: new Date(body.posted_at) }),
        ...(body.ai_accepted    !== undefined && { ai_accepted: body.ai_accepted }),
        updated_at: new Date(),
      },
    });

    return success(reply, updated);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'updateEntry failed');
    return errors.internal(reply);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/calendar/entries/:id
// ─────────────────────────────────────────────────────────────────────────────
export const deleteEntry = async (
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { id } = req.params;

  try {
    const deleted = await (prisma as any).calendar_entries.deleteMany({
      where: { id, user_id: user.id },
    });
    if (deleted.count === 0) return errors.notFound(reply, 'Calendar entry');
    return success(reply, { deleted: true });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'deleteEntry failed');
    return errors.internal(reply);
  }
};
