// src/controllers/radar.controller.js
'use strict';

const radarService = require('../services/radar.service');
const { success, errors } = require('../utils/response');
const { logger } = require('../utils/logger');
const { getPlatformContext, buildPlatformPromptContext } = require('../utils/platformRouter');

/**
 * GET /api/v1/discover/intelligence
 */
const getIntelligence = async (req, reply) => {
  const user = req.user;
  try {
    const ctx = getPlatformContext(user);
    const niche         = req.query.niche || ctx.niche;
    const platform      = req.query.platform || ctx.platform;
    const archetype     = ctx.archetype;
    const followerRange = ctx.followerRange;

    const intelligence = await radarService.getOrGenerateRadarSnapshot({
      niche, platform, archetype, followerRange,
    });

    return success(reply, {
      intelligence,
      meta: { niche, platform, archetype, generatedAt: new Date().toISOString(), fromCache: intelligence.fromCache || false },
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getIntelligence failed');
    return errors.serviceDown(reply, 'ARIA Intelligence');
  }
};

/**
 * GET /api/v1/discover/competitors
 */
const getCompetitors = async (req, reply) => {
  const user = req.user;
  try {
    const ctx = getPlatformContext(user);
    const niche     = req.query.niche || ctx.niche;
    const platform  = req.query.platform || ctx.platform;
    const archetype = ctx.archetype;

    const data = await radarService.generateCompetitorIntelligence({ niche, platform, archetype });
    return success(reply, data);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getCompetitors failed');
    return errors.serviceDown(reply, 'ARIA Competitor Intel');
  }
};

/**
 * GET /api/v1/discover/inspiration
 */
const getInspiration = async (req, reply) => {
  const user = req.user;
  try {
    const ctx = getPlatformContext(user);
    const niche         = req.query.niche || ctx.niche;
    const platform      = req.query.platform || ctx.platform;
    const archetype     = ctx.archetype;
    const followerRange = ctx.followerRange;

    const data = await radarService.generateInspiration({ niche, platform, archetype, followerRange });
    return success(reply, data);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getInspiration failed');
    return errors.serviceDown(reply, 'ARIA Inspiration');
  }
};

module.exports = { getIntelligence, getCompetitors, getInspiration };