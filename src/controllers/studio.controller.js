// src/controllers/studio.controller.js
'use strict';

const studioSvc   = require('../services/studio.service');
const videoSvc    = require('../services/videoAnalysis.service');
const { success, errors } = require('../utils/response');
const { logger }  = require('../utils/logger');
const path        = require('path');
const fs          = require('fs');

// POST /api/v1/studio/script/structure
const getScriptStructure = async (req, reply) => {
  const user = req.user;
  const { idea, platform, niche, format, mood, collaboration, angle } = req.body;

  try {
    const result = await studioSvc.generateScriptStructure({
      idea, platform: platform || user.primaryPlatform || 'instagram',
      niche:    niche    || user.niches?.[0] || 'general',
      archetype: user.archetype || 'EDUCATOR',
      format, mood, collaboration, angle,
      followerRange: user.followerRange,
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, 'Script structure failed');
    return errors.serviceDown(reply, 'Studio Script');
  }
};

// POST /api/v1/studio/script/advise
const adviseSection = async (req, reply) => {
  const user = req.user;
  const { sectionLabel, creatorContent, sectionType, idea, mood } = req.body;

  try {
    const result = await studioSvc.adviseOnSection({
      sectionLabel, creatorContent, sectionType,
      idea, mood,
      platform:  user.primaryPlatform || 'instagram',
      niche:     user.niches?.[0]     || 'general',
      archetype: user.archetype       || 'EDUCATOR',
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, 'Section advice failed');
    return errors.serviceDown(reply, 'Studio Advisor');
  }
};

// POST /api/v1/studio/bgm/match
const matchBGM = async (req, reply) => {
  const user = req.user;
  const { idea, mood, format, duration } = req.body;

  try {
    const result = await studioSvc.matchBGM({
      idea, mood, format, duration,
      platform:  user.primaryPlatform || 'instagram',
      niche:     user.niches?.[0]     || 'general',
      archetype: user.archetype       || 'EDUCATOR',
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, 'BGM match failed');
    return errors.serviceDown(reply, 'BGM Matcher');
  }
};

// POST /api/v1/studio/shots
const getShotList = async (req, reply) => {
  const user = req.user;
  const { idea, format, sections } = req.body;

  try {
    const result = await studioSvc.generateShotList({
      idea, format, sections,
      niche:     user.niches?.[0] || 'general',
      archetype: user.archetype   || 'EDUCATOR',
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, 'Shot list failed');
    return errors.serviceDown(reply, 'Shot List');
  }
};

// POST /api/v1/studio/editing/help
const getEditingHelp = async (req, reply) => {
  const user = req.user;
  const { problem, tool } = req.body;

  try {
    const result = await studioSvc.getEditingHelp({
      problem, tool,
      niche:     user.niches?.[0] || 'general',
      archetype: user.archetype   || 'EDUCATOR',
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, 'Editing help failed');
    return errors.serviceDown(reply, 'Editing Help');
  }
};

// POST /api/v1/studio/analyse/url
const analyseVideoUrl = async (req, reply) => {
  const user = req.user;
  const { videoUrl, mood } = req.body;

  try {
    const result = await videoSvc.analyseFromUrl({
      url:       videoUrl,
      platform:  user.primaryPlatform || 'instagram',
      niche:     user.niches?.[0]     || 'general',
      archetype: user.archetype       || 'EDUCATOR',
      mood,
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, 'Video URL analysis failed');
    return errors.serviceDown(reply, 'Video Analysis');
  }
};

// POST /api/v1/studio/analyse/upload
// Handles multipart file upload
const analyseVideoUpload = async (req, reply) => {
  const user = req.user;

  try {
    const data     = await req.file();
    const mood     = req.body?.mood;

    if (!data) return errors.notFound(reply, 'Video file');

    // Save to temp
    const tmpPath = path.join('/tmp', `aria_upload_${user.id}_${Date.now()}.mp4`);
    const buffer  = await data.toBuffer();
    fs.writeFileSync(tmpPath, buffer);

    const result = await videoSvc.analyseVideo({
      videoPath: tmpPath,
      platform:  user.primaryPlatform || 'instagram',
      niche:     user.niches?.[0]     || 'general',
      archetype: user.archetype       || 'EDUCATOR',
      mood,
      userId:    user.id,
    });

    // Cleanup
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

    return success(reply, result);
  } catch (err) {
    logger.error({ err }, 'Video upload analysis failed');
    return errors.serviceDown(reply, 'Video Analysis');
  }
};

// POST /api/v1/studio/session/save
const saveSession = async (req, reply) => {
  const user = req.user;
  const { idea, platform, niche, scriptStructure, bgmSuggestions, shotList } = req.body;

  try {
    const sessionId = await studioSvc.saveStudioSession(user.id, {
      idea, platform, niche, scriptStructure, bgmSuggestions, shotList,
    });
    return success(reply, { sessionId, saved: true });
  } catch (err) {
    logger.error({ err }, 'Session save failed');
    return errors.internal(reply);
  }
};

module.exports = {
  getScriptStructure, adviseSection, matchBGM,
  getShotList, getEditingHelp,
  analyseVideoUrl, analyseVideoUpload, saveSession,
};
