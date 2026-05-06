import { FastifyRequest, FastifyReply } from "fastify";
import * as studioSvc from "../services/studio.service";
import * as videoSvc from "../services/videoAnalysis.service";
import { extractScriptLearnings, IntentLabel } from "../services/studio_learning.service";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import path from "path";
import fs from "fs";
import os from "os";
import { User } from "../types";

/**
 * Get script skeleton/structure based on idea and platform
 */
export const getScriptStructure = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { idea, platform, niche, format, mood, collaboration, angle } =
    req.body as any;

  try {
    const result = await studioSvc.generateScriptStructure({
      idea,
      platform: platform || user.primary_platform || "instagram",
      niche: niche || user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
      format,
      mood,
      collaboration,
      angle,
      followerRange: user.follower_range || undefined,
      userId: user.id,
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, "Script structure failed");
    return errors.serviceDown(reply, "Studio Script");
  }
};

/**
 * Get advice on a specific script section
 */
export const adviseSection = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { sectionLabel, creatorContent, sectionType, idea, mood } =
    req.body as any;

  try {
    const result = await studioSvc.adviseOnSection({
      sectionLabel,
      creatorContent,
      sectionType,
      idea,
      mood,
      platform: user.primary_platform || "instagram",
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, "Section advice failed");
    return errors.serviceDown(reply, "Studio Advisor");
  }
};

/**
 * Match BGM for a content idea
 */
export const matchBGM = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { idea, mood, format, duration } = req.body as any;

  try {
    const result = await studioSvc.matchBGM({
      idea,
      mood,
      platform: user.primary_platform || "instagram",
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
      duration,
      userId: user.id,
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, "BGM match failed");
    return errors.serviceDown(reply, "BGM Matcher");
  }
};

/**
 * Generate a practical shot list
 */
export const getShotList = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { idea, format, sections } = req.body as any;

  try {
    const result = await studioSvc.generateShotList({
      idea,
      format,
      sections,
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, "Shot list failed");
    return errors.serviceDown(reply, "Shot List");
  }
};

/**
 * Get help with specific editing tools/problems
 */
export const getEditingHelp = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { problem, tool } = req.body as any;

  try {
    const result = await studioSvc.getEditingHelp({
      problem,
      tool,
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, "Editing help failed");
    return errors.serviceDown(reply, "Editing Help");
  }
};

/**
 * Analyse video from a URL (YouTube/Instagram)
 */
export const analyseVideoUrl = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { videoUrl, mood } = req.body as any;

  try {
    const result = await videoSvc.analyseFromUrl({
      url: videoUrl,
      platform: user.primary_platform || "instagram",
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
      mood,
    });
    return success(reply, result);
  } catch (err) {
    logger.error({ err }, "Video URL analysis failed");
    return errors.serviceDown(reply, "Video Analysis");
  }
};

/**
 * Handle video upload and analysis (multipart)
 */
export const analyseVideoUpload = async (req: any, reply: FastifyReply) => {
  const user = req.user as User;

  try {
    const data = await req.file();
    const mood = req.body?.mood?.value; // multipart fields are often in .value

    if (!data) return errors.notFound(reply, "Video file");

    // Save to temp
    const tmpPath = path.join(
      os.tmpdir(),
      `aria_upload_${user.id}_${Date.now()}.mp4`,
    );
    const buffer = await data.toBuffer();
    fs.writeFileSync(tmpPath, buffer);

    const result = await videoSvc.analyseVideo({
      videoPath: tmpPath,
      platform: user.primary_platform || "instagram",
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
      mood,
      userId: user.id,
    });

    // Cleanup
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }

    return success(reply, result);
  } catch (err) {
    logger.error({ err }, "Video upload analysis failed");
    return errors.serviceDown(reply, "Video Analysis");
  }
};

/**
 * Save studio session to DB
 */
export const saveSession = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const {
    idea,
    platform,
    niche,
    generatedScript,
    editedScript,
    bgmSuggestions,
    shotList,
    pinned,
  } = req.body as any;

  try {
    const session = await (prisma as any).studio_scripts.create({
      data: {
        user_id: user.id,
        idea,
        platform: platform || user.primary_platform || 'instagram',
        niche: niche || user.niches?.[0] || 'general',
        archetype: user.archetype || 'CREATOR',
        generated_script: generatedScript || {},
        edited_script: editedScript || {},
        bgm_suggestions: bgmSuggestions || {},
        shot_list: shotList || {},
        pinned: pinned || false,
      },
      select: { id: true },
    });

    return success(reply, { sessionId: session.id });
  } catch (err) {
    logger.error({ err }, 'saveSession failed');
    return errors.internal(reply);
  }
};

/**
 * Learn from editor feedback
 */
export const learnFromEdit = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const {
    generatedSections,
    editedSections,
    intentLabel,
    sessionId,
  } = req.body as any;

  if (!generatedSections || !editedSections || !intentLabel) {
    return errors.validation(reply, 'Missing required fields');
  }

  try {
    // Run learning extraction
    await extractScriptLearnings({
      userId: user.id,
      generatedSections,
      editedSections,
      intentLabel: intentLabel as IntentLabel,
    });

    // Update the session with the edited script
    if (sessionId) {
      await (prisma as any).studio_scripts.updateMany({
        where: { id: sessionId, user_id: user.id },
        data: { edited_script: { sections: editedSections }, updated_at: new Date() },
      });
    }

    return success(reply, { learned: true });
  } catch (err) {
    logger.error({ err }, 'learnFromEdit failed');
    return errors.internal(reply);
  }
};

/**
 * Get script history
 */
export const getScriptHistory = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  try {
    const scripts = await (prisma as any).studio_scripts.findMany({
      where: { user_id: user.id },
      orderBy: [{ pinned: 'desc' }, { created_at: 'desc' }],
      take: 50,
      select: {
        id: true,
        idea: true,
        platform: true,
        niche: true,
        pinned: true,
        created_at: true,
        edited_script: true,
        generated_script: true,
      },
    });
    return success(reply, scripts);
  } catch (err) {
    logger.error({ err }, 'getScriptHistory failed');
    return errors.internal(reply);
  }
};

/**
 * Toggle pin status of a script
 */
export const togglePin = async (
  req: FastifyRequest<{ Body: any; Params: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { scriptId } = req.params as any;

  try {
    const existing = await (prisma as any).studio_scripts.findFirst({
      where: { id: scriptId, user_id: user.id },
      select: { pinned: true },
    });

    if (!existing) return errors.notFound(reply, 'Script');

    await (prisma as any).studio_scripts.update({
      where: { id: scriptId },
      data: { pinned: !existing.pinned },
    });

    return success(reply, { pinned: !existing.pinned });
  } catch (err) {
    logger.error({ err }, 'togglePin failed');
    return errors.internal(reply);
  }
};
