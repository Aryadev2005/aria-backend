// src/controllers/launch.controller.js
'use strict';

const launchSvc = require('../services/launch.service');
const { success, errors } = require('../utils/response');
const { logger } = require('../utils/logger');
const { getPlatformContext, buildPlatformPromptContext } = require('../utils/platformRouter');

// POST /api/v1/launch/package
// Generates full posting package — caption, hashtags, first comment, story copy
const getPostingPackage = async (req, reply) => {
  const user = req.user;
  const { idea, script } = req.body;

  try {
    const ctx = getPlatformContext(user);
    const pkg = await launchSvc.generatePostingPackage({
      niche:         ctx.niche,
      platform:      ctx.platform,
      archetype:     ctx.archetype,
      followerRange: ctx.followerRange,
      idea,
      script,
    });

    // Save async — don't block the response
    launchSvc.saveLaunchPackage(user.id, { idea, pkg }).catch(() => {});

    return success(reply, pkg);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getPostingPackage failed');
    return errors.serviceDown(reply, 'ARIA Launch');
  }
};

// GET /api/v1/launch/timing
// Returns optimal posting windows for this creator's archetype + niche
const getTimingIntelligence = async (req, reply) => {
  const user = req.user;

  try {
    const ctx = getPlatformContext(user);
    const timing = await launchSvc.getTimingIntelligence({
      archetype:     ctx.archetype,
      niche:         ctx.niche,
      platform:      ctx.platform,
      followerRange: ctx.followerRange,
    });

    return success(reply, timing);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getTimingIntelligence failed');
    return errors.serviceDown(reply, 'ARIA Timing');
  }
};

// GET /api/v1/launch/brand-alert
// Returns brand deal opportunities + ready-to-send pitch template
const getBrandAlert = async (req, reply) => {
  const user = req.user;

  try {
    const ctx = getPlatformContext(user);
    const alert = await launchSvc.generateBrandAlert({
      niche:          ctx.niche,
      platform:       ctx.platform,
      archetype:      ctx.archetype,
      followerRange:  ctx.followerRange,
      engagementRate: ctx.engagementRate,
    });

    return success(reply, alert);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getBrandAlert failed');
    return errors.serviceDown(reply, 'ARIA Brand Alert');
  }
};

module.exports = { getPostingPackage, getTimingIntelligence, getBrandAlert };
