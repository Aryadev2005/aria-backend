import { FastifyRequest, FastifyReply } from "fastify";
import * as studioSvc from "../services/studio.service";
import * as videoSvc from "../services/videoAnalysis.service";
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
  const { idea, platform, niche, scriptStructure, bgmSuggestions, shotList } =
    req.body as any;

  try {
    const sessionId = await studioSvc.saveStudioSession(user.id, {
      idea,
      platform,
      niche,
      scriptStructure,
      bgmSuggestions,
      shotList,
    });
    return success(reply, { sessionId, saved: true });
  } catch (err) {
    logger.error({ err }, "Session save failed");
    return errors.internal(reply);
  }
};
