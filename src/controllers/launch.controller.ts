import { FastifyRequest, FastifyReply } from 'fastify';
import * as launchSvc from '../services/launch.service';
import { success, errors } from '../utils/response';
import { logger } from '../utils/logger';
import { getPlatformContext } from '../utils/platformRouter';

// ─────────────────────────────────────────────────────────────────────────────
// GUARD — blocks incomplete profiles from getting silently wrong advice
// ─────────────────────────────────────────────────────────────────────────────

const requireArchetype = (archetype: string | null, reply: FastifyReply): boolean => {
  if (!archetype) {
    reply.code(422).send({
      success: false,
      error:   'INCOMPLETE_PROFILE',
      message: 'Complete your profile setup to unlock Launch intelligence. ARIA needs your archetype to personalise timing and brand recommendations.',
    });
    return false;
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/launch/package
// ─────────────────────────────────────────────────────────────────────────────

export const getPostingPackage = async (
  req: FastifyRequest<{ Body: { idea?: string; script?: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as any;
  const { idea, script } = req.body;

  try {
    const ctx = getPlatformContext(user);

    if (!requireArchetype(ctx.archetype, reply)) return;

    let pkg: any;
    try {
      pkg = await launchSvc.generatePostingPackage({
        niche:         ctx.niche,
        platform:      ctx.platform,
        archetype:     ctx.archetype!,
        followerRange: ctx.followerRange,
        idea,
        script,
      });
    } catch (e) {
      logger.warn({ e }, 'Posting package LLM failed — returning empty shell');
      pkg = {
        caption:     '',
        firstComment:'',
        hashtags:    { mega: [], mid: [], niche: [] },
        storyCopy:   '',
        bestDayTime: '',
      };
    }

    // Fire-and-forget DB save — never block the response
    launchSvc.saveLaunchPackage(user.id, { idea, pkg }).catch(() => {});

    return success(reply, pkg);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getPostingPackage failed');
    return errors.serviceDown(reply, 'ARIA Launch');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/launch/timing
// ─────────────────────────────────────────────────────────────────────────────

export const getTimingIntelligence = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as any;

  try {
    const ctx = getPlatformContext(user);

    if (!requireArchetype(ctx.archetype, reply)) return;

    let timing: any;
    try {
      timing = await launchSvc.getTimingIntelligence({
        archetype:     ctx.archetype!,
        niche:         ctx.niche,
        platform:      ctx.platform,
        followerRange: ctx.followerRange,
      });
    } catch (e) {
      logger.warn({ e }, 'Timing intelligence LLM failed — returning empty shell');
      timing = {
        bestSlots:            [],
        weeklyPattern:        '',
        platformInsight:      '',
        avoidWindows:         [],
        nextBestSlot:         '',
        nextBestSlotHoursAway: 0,
        ariaReason:           '',
      };
    }

    return success(reply, timing);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getTimingIntelligence failed');
    return errors.serviceDown(reply, 'ARIA Timing');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/launch/brand-alert
// ─────────────────────────────────────────────────────────────────────────────

export const getBrandAlert = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as any;

  try {
    const ctx = getPlatformContext(user);

    if (!requireArchetype(ctx.archetype, reply)) return;

    let alert: any;
    try {
      alert = await launchSvc.generateBrandAlert({
        niche:          ctx.niche,
        platform:       ctx.platform,
        archetype:      ctx.archetype!,
        followerRange:  ctx.followerRange,
        engagementRate: ctx.engagementRate,
      });
    } catch (e) {
      logger.warn({ e }, 'Brand alert LLM failed — returning empty shell');
      alert = {
        brandOpportunities: [],
        pitchTemplate:      { subject: '', body: '', whatsappVersion: '' },
        ariaAdvice:         '',
      };
    }

    return success(reply, alert);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getBrandAlert failed');
    return errors.serviceDown(reply, 'ARIA Brand Alert');
  }
};
