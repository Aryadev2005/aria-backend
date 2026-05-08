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
  loadActionStates,
} from '../services/roadmap.service';

const USER_SELECT = {
  archetype: true, archetype_label: true, primary_platform: true,
  follower_range: true, engagement_rate: true, growth_stage: true,
  creator_intent: true, scraped_summary: true, aria_last_analysis: true,
  niches: true,
};

// ── GET /api/v1/analytics/roadmap ─────────────────────────────────────────────
export const getPersonalisedRoadmap = async (req: FastifyRequest, reply: FastifyReply) => {
  const user  = req.user as User;
  // ?force=true bypasses BOTH the controller-level cache check AND
  // the service-level cache check — guarantees a fresh AI generation
  const force = (req.query as any)?.force === 'true';

  try {
    // Controller-level cache check (only for non-forced requests)
    if (!force) {
      const cached = await cache.get(`roadmap:${user.id}`);
      if (cached) {
        return success(reply, { ...(cached as object), fromCache: true });
      }
    }

    const fullUser = await prisma.users.findUnique({ where: { id: user.id }, select: USER_SELECT });
    if (!fullUser) return errors.notFound(reply, 'User not found');

    // Pass force=true into service so it also skips its own internal cache
    const roadmap = await generatePersonalisedRoadmap(user.id, { ...user, ...fullUser }, force);
    return success(reply, { ...roadmap, fromCache: false });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, 'Get roadmap failed');
    return errors.internal(reply, 'Failed to generate roadmap');
  }
};

// ── GET /api/v1/analytics/roadmap/refresh ─────────────────────────────────────
// Dedicated refresh endpoint: deletes cache key then regenerates with force=true
export const refreshRoadmap = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    // Explicit cache delete first (belt + suspenders alongside force=true)
    await cache.del(`roadmap:${user.id}`);

    const fullUser = await prisma.users.findUnique({ where: { id: user.id }, select: USER_SELECT });
    if (!fullUser) return errors.notFound(reply, 'User not found');

    const roadmap = await generatePersonalisedRoadmap(
      user.id,
      { ...user, ...fullUser },
      true, // always force on dedicated refresh
    );
    return success(reply, { ...roadmap, refreshed: true, fromCache: false });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, 'Refresh roadmap failed');
    return errors.internal(reply, 'Failed to refresh roadmap');
  }
};

// ── GET /api/v1/analytics/roadmap/action-states?version=xxx ──────────────────
// Returns the completed/dismissed state of every action for a roadmap version.
// The frontend calls this on mount to restore persisted checkboxes.
export const getActionStates = async (req: FastifyRequest, reply: FastifyReply) => {
  const user    = req.user as User;
  const version = (req.query as any)?.version as string | undefined;

  if (!version) return errors.validation(reply, 'version query param is required');

  try {
    const states = await loadActionStates(user.id, version);
    return success(reply, { states, version });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, 'getActionStates failed');
    return errors.internal(reply, 'Failed to load action states');
  }
};

// ── POST /api/v1/analytics/roadmap/action/complete ───────────────────────────
export const completeRoadmapAction = async (
  req: FastifyRequest<{
    Body: { roadmapVersion: string; weekNumber: number; actionIndex: number; actionText: string };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { roadmapVersion, weekNumber, actionIndex, actionText } = req.body;

  // Basic validation
  if (!roadmapVersion || weekNumber == null || actionIndex == null || !actionText) {
    return errors.validation(reply, 'roadmapVersion, weekNumber, actionIndex, actionText are required');
  }

  try {
    await markRoadmapActionComplete(user.id, roadmapVersion, weekNumber, actionIndex, actionText);
    return success(reply, { completed: true });
  } catch (err: any) {
    logger.warn({ err: err.message, userId: user.id }, 'completeRoadmapAction failed');
    // Non-fatal — never block UI
    return success(reply, { completed: false });
  }
};

// ── POST /api/v1/analytics/roadmap/action/dismiss ────────────────────────────
export const dismissRoadmapActionHandler = async (
  req: FastifyRequest<{
    Body: { roadmapVersion: string; weekNumber: number; actionIndex: number; actionText: string };
  }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { roadmapVersion, weekNumber, actionIndex, actionText } = req.body;

  if (!roadmapVersion || weekNumber == null || actionIndex == null || !actionText) {
    return errors.validation(reply, 'roadmapVersion, weekNumber, actionIndex, actionText are required');
  }

  try {
    await dismissRoadmapAction(user.id, roadmapVersion, weekNumber, actionIndex, actionText);
    return success(reply, { dismissed: true });
  } catch (err: any) {
    logger.warn({ err: err.message, userId: user.id }, 'dismissRoadmapAction failed');
    return success(reply, { dismissed: false });
  }
};
