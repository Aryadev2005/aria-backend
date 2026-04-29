// src/controllers/profile.controller.js
'use strict';

const profileSvc          = require('../services/profile.service');
const { success, errors } = require('../utils/response');
const { logger }          = require('../utils/logger');
const { getDB }           = require('../config/database');
const { cache }           = require('../config/redis');

// GET /api/v1/profile/analytics
// Platform-aware — reads user.primaryPlatform and routes accordingly
const getAnalytics = async (req, reply) => {
  const user = req.user;
  try {
    const analytics = await profileSvc.getCreatorAnalytics(user.id, user);
    return success(reply, analytics);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getAnalytics failed');
    return errors.serviceDown(reply, 'ARIA Profile Analytics');
  }
};

// GET /api/v1/profile/me
// Returns full creator profile — archetype, niches, memory, subscription
const getProfile = async (req, reply) => {
  const user = req.user;
  try {
    const sql    = getDB();
    const [row]  = await sql`
      SELECT
        id, name, email,
        instagram_handle, youtube_handle,
        primary_platform, archetype, niches,
        follower_range, engagement_rate,
        onboarding_step, aria_analyzed_at,
        subscription_plan, follower_count
      FROM users WHERE id = ${user.id}
    `;

    // Get memory count
    let memoryCount = 0;
    try {
      const [mc] = await sql`
        SELECT COUNT(*) as count FROM agent_memory WHERE user_id = ${user.id}
      `;
      memoryCount = parseInt(mc?.count || 0);
    } catch (_) {}

    return success(reply, {
      ...row,
      memoryCount,
      isOnboarded: row?.onboarding_step === 'complete',
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'getProfile failed');
    return errors.internal(reply);
  }
};

// POST /api/v1/profile/refresh
// Force re-scrape + re-analyse — clears cache
const refreshAnalytics = async (req, reply) => {
  const user = req.user;
  try {
    await cache.del(`profile:analytics:${user.id}`);
    const analytics = await profileSvc.getCreatorAnalytics(user.id, user);
    return success(reply, analytics);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'refreshAnalytics failed');
    return errors.serviceDown(reply, 'ARIA Profile Refresh');
  }
};

// PATCH /api/v1/profile/platform
// Update primary platform — re-routes all future API calls
const updatePlatform = async (req, reply) => {
  const user     = req.user;
  const { platform, handle } = req.body;
  const sql      = getDB();

  try {
    if (platform === 'instagram') {
      await sql`
        UPDATE users SET
          primary_platform   = 'instagram',
          instagram_handle   = ${handle},
          onboarding_step    = 'pending',
          aria_analyzed_at   = NULL
        WHERE id = ${user.id}
      `;
    } else if (platform === 'youtube') {
      await sql`
        UPDATE users SET
          primary_platform = 'youtube',
          youtube_handle   = ${handle},
          onboarding_step  = 'pending',
          aria_analyzed_at = NULL
        WHERE id = ${user.id}
      `;
    }

    // Clear all caches for this user
    await Promise.allSettled([
      cache.del(`profile:analytics:${user.id}`),
      cache.del(`brain:mem:${user.id}`),
      cache.del(`agent:memory:${user.id}`),
    ]);

    logger.info({ userId: user.id, platform, handle }, 'Platform updated');
    return success(reply, { updated: true, platform, handle });
  } catch (err) {
    logger.error({ err, userId: user.id }, 'updatePlatform failed');
    return errors.internal(reply);
  }
};

module.exports = { getAnalytics, getProfile, refreshAnalytics, updatePlatform };
