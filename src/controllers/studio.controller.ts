import { FastifyRequest, FastifyReply } from "fastify";
import * as studioSvc from "../services/studio.service";
import * as videoSvc from "../services/videoAnalysis.service";
import {
  extractScriptLearnings,
  IntentLabel,
} from "../services/studio_learning.service";
import { prisma } from "../config/database";
import { success, errors } from "../utils/response";
import { logger } from "../utils/logger";
import { debitCredits } from "../services/credits.service";
import path from "path";
import fs from "fs";
import os from "os";
import { User } from "../types";
import { getVoicePortrait } from "../services/voice.service";
import { runTwoPassStudio } from "../services/deep_analysis.service";

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
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

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

    await debitCredits(user.id, "script_writing", modelToUse, 1500, 1000).catch(
      (err) => logger.warn({ err }, "Debit failed"),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
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
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

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

    await debitCredits(user.id, "script_writing", modelToUse, 1200, 800).catch(
      (err) => logger.warn({ err }, "Debit failed"),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Section advice failed");
    return errors.serviceDown(reply, "Studio Advisor");
  }
};

/**
 * Match BGM to content idea
 */
export const matchBGM = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { idea, mood, format, duration } = req.body as any;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const result = await studioSvc.matchBGM({
      idea,
      mood,
      duration,
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
      platform: user.primary_platform || "instagram",
      userId: user.id,
    });

    await debitCredits(
      user.id,
      "song_recommendations",
      modelToUse,
      800,
      400,
    ).catch((err) => logger.warn({ err }, "Debit failed"));

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "BGM match failed");
    return errors.serviceDown(reply, "BGM Matcher");
  }
};

/**
 * Get shot list from script sections
 */
export const getShotList = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { idea, format, sections } = req.body as any;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const result = await studioSvc.generateShotList({
      idea,
      format,
      sections,
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
    });

    await debitCredits(user.id, "script_writing", modelToUse, 1000, 600).catch(
      (err) => logger.warn({ err }, "Debit failed"),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
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
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const result = await studioSvc.getEditingHelp({
      problem,
      tool,
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
    });

    await debitCredits(user.id, "script_writing", modelToUse, 800, 400).catch(
      (err) => logger.warn({ err }, "Debit failed"),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
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
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  try {
    const result = await videoSvc.analyseFromUrl({
      url: videoUrl,
      platform: user.primary_platform || "instagram",
      niche: user.niches?.[0] || "general",
      archetype: user.archetype || "EDUCATOR",
      mood,
    });

    await debitCredits(user.id, "video_analysis", modelToUse, 3000, 1500).catch(
      (err) => logger.warn({ err }, "Debit failed"),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
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
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

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

    await debitCredits(user.id, "video_analysis", modelToUse, 3500, 1500).catch(
      (err) => logger.warn({ err }, "Debit failed"),
    );

    return success(reply, {
      ...result,
      creditsUsed: req.creditCheck?.featureCharge ?? 0,
    });
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
    attachedNotes,
  } = req.body as any;

  try {
    const session = await prisma.studio_scripts.create({
      data: {
        user_id: user.id,
        idea,
        platform: platform || user.primary_platform || "instagram",
        niche: niche || user.niches?.[0] || "general",
        archetype: user.archetype || "CREATOR",
        generated_script: generatedScript || {},
        edited_script: editedScript || {},
        bgm_suggestions: bgmSuggestions || {},
        shot_list: shotList || {},
        pinned: pinned || false,
        attached_notes: attachedNotes || [],
      },
      select: { id: true },
    });

    return success(reply, { sessionId: session.id });
  } catch (err) {
    logger.error({ err }, "saveSession failed");
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
  const { generatedSections, editedSections, intentLabel, sessionId } =
    req.body as any;

  if (!generatedSections || !editedSections || !intentLabel) {
    return errors.validation(reply, "Missing required fields");
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
      await prisma.studio_scripts.updateMany({
        where: { id: sessionId, user_id: user.id },
        data: {
          edited_script: { sections: editedSections },
          updated_at: new Date(),
        },
      });
    }

    return success(reply, { learned: true });
  } catch (err) {
    logger.error({ err }, "learnFromEdit failed");
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
    const scripts = await prisma.studio_scripts.findMany({
      where: { user_id: user.id },
      orderBy: [{ pinned: "desc" }, { created_at: "desc" }],
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
        attached_notes: true,
      },
    });
    return success(reply, scripts);
  } catch (err) {
    logger.error({ err }, "getScriptHistory failed");
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
    const existing = await prisma.studio_scripts.findFirst({
      where: { id: scriptId, user_id: user.id },
      select: { pinned: true },
    });

    if (!existing) return errors.notFound(reply, "Script");

    await prisma.studio_scripts.update({
      where: { id: scriptId },
      data: { pinned: !existing.pinned },
    });

    return success(reply, { pinned: !existing.pinned });
  } catch (err) {
    logger.error({ err }, "togglePin failed");
    return errors.internal(reply);
  }
};

// Fetch studio learnings (same helper as studio.service.ts uses internally)
async function getStudioLearnings(userId: string): Promise<string> {
  try {
    const { prisma } = await import("../config/database");
    const rows = await (prisma as any).aria_memory.findMany({
      where: { user_id: userId, category: { in: ["style", "voice"] } },
      select: { category: true, key: true, value: true },
    });
    if (!rows.length) return "";
    return rows
      .map((r: any) => {
        try {
          return `${r.category}.${r.key}: ${JSON.parse(r.value)}`;
        } catch {
          return `${r.category}.${r.key}: ${r.value}`;
        }
      })
      .join("\n");
  } catch {
    return "";
  }
}

// ── POST /api/v1/studio/script/stream ────────────────────────────────────────
// Two-pass: research → script. Streams SSE events.
export const streamScript = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { idea, platform, niche, format, mood, angle, duration, userQuery, attachedNotes } =
    req.body as any;

  if (!idea?.trim()) {
    return reply.status(400).send({ error: "idea is required" });
  }

  // SSE headers
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });

  const sendSSE = (event: any) => {
    try {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {}
  };

  const keepAlive = setInterval(() => {
    try {
      reply.raw.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 15_000);

  try {
    // Load voice portrait and learned prefs in parallel
    const [vpResult, lpResult] = await Promise.allSettled([
      getVoicePortrait(user.id),
      getStudioLearnings(user.id),
    ]);

    const voicePortrait =
      vpResult.status === "fulfilled" ? vpResult.value : null;
    const learnedPrefs =
      lpResult.status === "fulfilled" ? (lpResult.value as string) : "";

    const voiceContext = voicePortrait
      ? `Tone: ${voicePortrait.toneSignature}, Energy: ${voicePortrait.energyLevel}, Language: ${voicePortrait.preferredLanguage}, Style: ${voicePortrait.sentenceStyle}`
      : undefined;

    await runTwoPassStudio(
      {
        idea: idea.trim(),
        platform: platform || user.primary_platform || "instagram",
        niche: niche || user.niches?.[0] || "general",
        format: format || "reel",
        mood,
        angle,
        archetype: user.archetype || "EDUCATOR",
        followerRange: user.follower_range || undefined,
        voiceContext,
        learnedPrefs: learnedPrefs || undefined,
        creatorName: user.name || undefined,
        userQuery: userQuery?.trim() || undefined,
        duration: duration?.trim() || undefined,
        attachedNotes,
      },
      (event) => {
        sendSSE(event);

        if (event.type === "done") {
          const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";
          debitCredits(user.id, "script_writing", modelToUse, 3000, 1500).catch(
            (err) => logger.warn({ err }, "Debit failed"),
          );
        }
      },
    );
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, "streamScript failed");
    sendSSE({
      type: "error",
      message: "Script generation failed. Please try again.",
    });
  } finally {
    clearInterval(keepAlive);
    reply.raw.end();
  }
};
