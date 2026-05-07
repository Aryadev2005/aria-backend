// src/controllers/roadmap.controller.ts

import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma }  from '../config/database';
import { cache }   from '../config/redis';
import { success, errors } from '../utils/response';
import { logger }  from '../utils/logger';
import { User }    from '../types';
import {
  generatePersonalisedRoadmap,
  markRoadmapActionComplete,
  dismissRoadmapAction,
} from '../services/roadmap.service';

const USER_SELECT = {
  archetype: true, archetype_label: true, primary_platform: true,
  follower_range: true, engagement_rate: true, growth_stage: true,
  creator_intent: true, scraped_summary: true, aria_last_analysis: true,
  niches: true,
};

// GET /api/v1/analytics/roadmap
export const getPersonalisedRoadmap = async (req: FastifyRequest, reply: FastifyReply) => {
  const user  = req.user as User;
  const force = (req.query as any)?.force === 'true';

  try {
    if (!force) {
      const cached = await cache.get(`roadmap:${user.id}`);
      if (cached) return success(reply, { ...cached, fromCache: true });
    }

    const fullUser = await prisma.users.findUnique({ where: { id: user.id }, select: USER_SELECT });
    if (!fullUser) return errors.notFound(reply, 'User not found');

    const roadmap = await generatePersonalisedRoadmap(user.id, { ...user, ...fullUser });
    return success(reply, { ...roadmap, fromCache: false });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, 'Get roadmap failed');
    return errors.internal(reply, 'Failed to generate roadmap');
  }
};

// GET /api/v1/analytics/roadmap/refresh
export const refreshRoadmap = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    await cache.del(`roadmap:${user.id}`);
    const fullUser = await prisma.users.findUnique({ where: { id: user.id }, select: USER_SELECT });
    if (!fullUser) return errors.notFound(reply, 'User not found');
    const roadmap = await generatePersonalisedRoadmap(user.id, { ...user, ...fullUser });
    return success(reply, { ...roadmap, refreshed: true });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, 'Refresh roadmap failed');
    return errors.internal(reply, 'Failed to refresh roadmap');
  }
};

// POST /api/v1/analytics/roadmap/action/complete
export const completeRoadmapAction = async (
  req: FastifyRequest<{
    Body: { roadmapVersion: string; weekNumber: number; actionIndex: number; actionText: string };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { roadmapVersion, weekNumber, actionIndex, actionText } = req.body;
  try {
    await markRoadmapActionComplete(user.id, roadmapVersion, weekNumber, actionIndex, actionText);
    return success(reply, { completed: true });
  } catch (err: any) {
    logger.warn({ err: err.message, userId: user.id }, 'completeRoadmapAction failed');
    return success(reply, { completed: false }); // non-fatal — never block UI
  }
};

// POST /api/v1/analytics/roadmap/action/dismiss
export const dismissRoadmapActionHandler = async (
  req: FastifyRequest<{
    Body: { roadmapVersion: string; weekNumber: number; actionIndex: number; actionText: string };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { roadmapVersion, weekNumber, actionIndex, actionText } = req.body;
  try {
    await dismissRoadmapAction(user.id, roadmapVersion, weekNumber, actionIndex, actionText);
    return success(reply, { dismissed: true });
  } catch (err: any) {
    logger.warn({ err: err.message, userId: user.id }, 'dismissRoadmapAction failed');
    return success(reply, { dismissed: false });
  }
};
