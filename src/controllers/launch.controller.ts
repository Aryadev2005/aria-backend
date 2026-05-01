import { FastifyRequest, FastifyReply } from 'fastify'
import * as launchSvc from '../services/launch.service';
import { success, errors } from '../utils/response';
import { logger } from '../utils/logger';
import { getPlatformContext } from '../utils/platformRouter';

/**
 * Generates full posting package — caption, hashtags, first comment, story copy
 */
export const getPostingPackage = async (req: FastifyRequest<{ Body: { idea?: string, script?: string } }>, reply: FastifyReply) => {
  const user = req.user as any;
  const { idea, script } = req.body;

  try {
    const ctx = getPlatformContext(user);
    let pkg: any;
    try {
      pkg = await launchSvc.generatePostingPackage({
        niche:         ctx.niche,
        platform:      ctx.platform,
        archetype:     ctx.archetype,
        followerRange: ctx.followerRange,
        idea,
        script,
      });
    } catch (e) {
      logger.warn({ e }, "Groq posting package failed");
      pkg = { caption: "", hashtags: { mega: [], mid: [], niche: [] }, storyCopy: "" };
    }

    // Save async — don't block the response
    launchSvc.saveLaunchPackage(user.id, { idea, pkg }).catch(() => {});

    return success(reply, pkg);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getPostingPackage failed');
    return errors.serviceDown(reply, 'ARIA Launch');
  }
};

/**
 * Returns optimal posting windows for this creator's archetype + niche
 */
export const getTimingIntelligence = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as any;

  try {
    const ctx = getPlatformContext(user);
    let timing: any;
    try {
      timing = await launchSvc.getTimingIntelligence({
        archetype:     ctx.archetype,
        niche:         ctx.niche,
        platform:      ctx.platform,
        followerRange: ctx.followerRange,
      });
    } catch (e) {
      logger.warn({ e }, "Groq timing intelligence failed");
      timing = { bestSlots: [] };
    }

    return success(reply, timing);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getTimingIntelligence failed');
    return errors.serviceDown(reply, 'ARIA Timing');
  }
};

/**
 * Returns brand deal opportunities + ready-to-send pitch template
 */
export const getBrandAlert = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as any;

  try {
    const ctx = getPlatformContext(user);
    let alert: any;
    try {
      alert = await launchSvc.generateBrandAlert({
        niche:          ctx.niche,
        platform:       ctx.platform,
        archetype:      ctx.archetype,
        followerRange:  ctx.followerRange,
        engagementRate: ctx.engagementRate,
      });
    } catch (e) {
      logger.warn({ e }, "Groq brand alert failed");
      alert = { brandOpportunities: [], pitchTemplate: { subject: "", body: "" } };
    }

    return success(reply, alert);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getBrandAlert failed');
    return errors.serviceDown(reply, 'ARIA Brand Alert');
  }
};
