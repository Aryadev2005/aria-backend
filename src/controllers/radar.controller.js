// src/controllers/radar.controller.js
'use strict';

const radarService = require('../services/radar.service');
const { success, errors } = require('../utils/response');
const { logger } = require('../utils/logger');

/**
 * GET /api/v1/discover/intelligence
 */
const getIntelligence = async (req, reply) => {
  const user = req.user;
  try {
    const niche         = user.niches?.[0] || req.query.niche || 'general';
    const platform      = user.primaryPlatform || req.query.platform || 'instagram';
    const archetype     = user.archetype || 'EDUCATOR';
    const followerRange = user.followerRange || '1K–10K';

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
    const niche     = user.niches?.[0] || req.query.niche || 'general';
    const platform  = user.primaryPlatform || req.query.platform || 'instagram';
    const archetype = user.archetype || 'EDUCATOR';

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
    const niche         = user.niches?.[0] || req.query.niche || 'general';
    const platform      = user.primaryPlatform || req.query.platform || 'instagram';
    const archetype     = user.archetype || 'EDUCATOR';
    const followerRange = user.followerRange || '1K–10K';

    const data = await radarService.generateInspiration({ niche, platform, archetype, followerRange });
    return success(reply, data);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getInspiration failed');
    return errors.serviceDown(reply, 'ARIA Inspiration');
  }
};

module.exports = { getIntelligence, getCompetitors, getInspiration };