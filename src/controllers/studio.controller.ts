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
import { debitCredits, DebitResult } from "../services/credits.service";
import { alertDebitFailed } from "../utils/alerting";
import { markTrialUsed } from "../services/firstExperience.service";
import path from "path";
import fs from "fs";
import os from "os";
import { User } from "../types";
import { getVoicePortrait } from "../services/voice.service";
import { runTwoPassStudio } from "../services/deep_analysis.service";
import { generateShootPlan, resolveDirectorArchetype } from "../services/shootPlan.service";
import { analyzeAlgoSignals } from "../services/algoSignalAnalyzer.service";
import { DirectorArchetype } from "../services/studioV2.types";
import { ActionKey } from "../config/credits";

// Retries debitCredits up to 3 times with exponential back-off.
// On permanent failure it alerts and returns null instead of propagating — the
// caller already delivered the content, so we never block the response.
async function debitWithRetry(
  userId: string,
  actionKey: ActionKey,
  modelUsed: string,
  inputTokens: number,
  outputTokens: number,
): Promise<DebitResult | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await debitCredits(userId, actionKey, modelUsed, inputTokens, outputTokens);
    } catch (err: any) {
      if (attempt === 3 || err.code === "INSUFFICIENT_CREDITS") {
        await alertDebitFailed(userId, actionKey, err);
        return null;
      }
      await new Promise((r) => setTimeout(r, attempt * 200));
    }
  }
  return null;
}

/**
 * Get script skeleton/structure based on idea and platform
 */
export const getScriptStructure = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { idea, platform, niche, format, mood, collaboration, angle, attachedNotes } =
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
      attachedNotes: attachedNotes?.length ? attachedNotes : undefined,
    });

    const debitResult = await debitWithRetry(user.id, "script_writing", modelToUse, 1500, 1000);

    return success(reply, {
      ...result,
      creditsUsed: debitResult?.totalDebited ?? req.creditCheck?.featureCharge ?? 0,
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

    const debitResult = await debitWithRetry(user.id, "script_writing", modelToUse, 1200, 800);

    return success(reply, {
      ...result,
      creditsUsed: debitResult?.totalDebited ?? req.creditCheck?.featureCharge ?? 0,
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

    const debitResult = await debitWithRetry(user.id, "song_recommendations", modelToUse, 800, 400);

    return success(reply, {
      ...result,
      creditsUsed: debitResult?.totalDebited ?? req.creditCheck?.featureCharge ?? 0,
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

    const debitResult = await debitWithRetry(user.id, "script_writing", modelToUse, 1000, 600);

    return success(reply, {
      ...result,
      creditsUsed: debitResult?.totalDebited ?? req.creditCheck?.featureCharge ?? 0,
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

    const debitResult = await debitWithRetry(user.id, "script_writing", modelToUse, 800, 400);

    return success(reply, {
      ...result,
      creditsUsed: debitResult?.totalDebited ?? req.creditCheck?.featureCharge ?? 0,
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

    const debitResult = await debitWithRetry(user.id, "video_analysis", modelToUse, 3000, 1500);

    return success(reply, {
      ...result,
      creditsUsed: debitResult?.totalDebited ?? req.creditCheck?.featureCharge ?? 0,
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

    const debitResult = await debitWithRetry(user.id, "video_analysis", modelToUse, 3500, 1500);

    return success(reply, {
      ...result,
      creditsUsed: debitResult?.totalDebited ?? req.creditCheck?.featureCharge ?? 0,
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

    // Auto-extract learnings if both generated and edited sections are present
    const generatedSections = (generatedScript as any)?.sections;
    const editedSections = (editedScript as any)?.sections;
    if (
      generatedSections?.length &&
      editedSections?.length &&
      generatedSections.length === editedSections.length
    ) {
      extractScriptLearnings({
        userId: user.id,
        generatedSections,
        editedSections,
        intentLabel: "other",
      }).catch((err: any) => logger.warn({ err: err.message }, "Auto-learning extraction failed — non-fatal"));
    }

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

/**
 * Regenerate a single section of a script
 */
export const regenerateSection = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const {
    sectionId,
    sectionLabel,
    sectionType,
    currentContent,
    userInstructions,
    idea,
    platform,
    niche,
    format,
    mood,
    angle,
    researchBrief,
    allSections,
  } = req.body as any;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  if (!sectionId || !userInstructions) {
    return errors.validation(
      reply,
      "Missing required fields: sectionId, userInstructions",
    );
  }

  try {
    // Load voice portrait for context
    const voicePortrait = await getVoicePortrait(user.id);
    const voiceContext = voicePortrait
      ? `Tone: ${voicePortrait.toneSignature}, Energy: ${voicePortrait.energyLevel}, Language: ${voicePortrait.preferredLanguage}, Style: ${voicePortrait.sentenceStyle}`
      : undefined;

    const result = await studioSvc.regenerateSection({
      sectionId,
      sectionLabel,
      sectionType,
      currentContent,
      userInstructions,
      idea,
      platform: platform || user.primary_platform || "instagram",
      niche: niche || user.niches?.[0] || "general",
      format,
      mood,
      angle,
      archetype: user.archetype || "EDUCATOR",
      voiceContext,
      researchBrief,
      allSections,
    });

    const debitResult = await debitWithRetry(user.id, "script_writing", modelToUse, 800, 400);

    return success(reply, {
      ...result,
      creditsUsed: debitResult?.totalDebited ?? req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "Section regeneration failed");
    return errors.serviceDown(reply, "Section Regeneration");
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
  const {
    idea,
    platform,
    niche,
    format,
    mood,
    angle,
    duration,
    userQuery,
    attachedNotes,
    selectedHookArchetype,
  } = req.body as any;

  if (!idea?.trim()) {
    return reply.status(400).send({ error: "idea is required" });
  }

  // ADD: format-duration contract enforcement
  const FORMAT_MAX_SECONDS: Record<string, number> = {
    reel: 60,
    story: 60,
    post: 90,
    carousel: Infinity, // slides, not time
    video: 180 * 60, // 3 hours max
    thread: Infinity, // tweets, not time
  };

  if (duration && format) {
    const lower = String(duration).toLowerCase().trim();
    let totalSeconds = 0;

    const hr = lower.match(/(\d+(?:\.\d+)?)\s*h(?:our|r)?/);
    const min = lower.match(/(\d+(?:\.\d+)?)\s*m(?:in)?/);
    const sec = lower.match(/(\d+(?:\.\d+)?)\s*s(?:ec)?/);
    if (hr) totalSeconds += parseFloat(hr[1]) * 3600;
    if (min) totalSeconds += parseFloat(min[1]) * 60;
    if (sec) totalSeconds += parseFloat(sec[1]);

    const maxSeconds = FORMAT_MAX_SECONDS[format] ?? Infinity;
    if (totalSeconds > 0 && totalSeconds > maxSeconds) {
      const maxLabel =
        maxSeconds >= 3600
          ? `${maxSeconds / 3600} hour(s)`
          : maxSeconds >= 60
            ? `${maxSeconds / 60} minute(s)`
            : `${maxSeconds} seconds`;
      return reply.status(400).send({
        error: `Max duration for a ${format} is ${maxLabel}. Reels are short-form content — maximum 60 seconds.`,
      });
    }
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

  let generationCompleted = false;
  let scriptResult: import("../services/deep_analysis.service").ScriptResult | null = null;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

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

    scriptResult = await runTwoPassStudio(
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
        selectedHookArchetype: (selectedHookArchetype as string)?.trim() || undefined,
      },
      (event) => {
        sendSSE(event);
        if (event.type === "done") {
          generationCompleted = true;
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
    if (generationCompleted) {
      const inTok  = scriptResult?.inputTokens  ?? 3000;
      const outTok = scriptResult?.outputTokens ?? 1500;
      await debitWithRetry(user.id, "script_writing", modelToUse, inTok, outTok);

      // trial mark stays fire-and-forget — non-revenue path
      if (req.creditCheck?.isTrial && req.creditCheck?.trialAction) {
        markTrialUsed(user.id, req.creditCheck.trialAction, { idea, platform })
          .catch(err => logger.warn({ err }, "studio: trial mark failed — non-fatal"));
      }
    }
    reply.raw.end();
  }
};

/**
 * POST /api/v1/studio/shoot-plan
 * Generates a shot-by-shot Director's Cut for a completed script session.
 * Requires the script session to exist in studio_scripts (sessionId param).
 */
export const generateDirectorsCut = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { sessionId, soloMode = true, directorArchetypeOverride } = req.body as any;
  const modelToUse = req.creditCheck?.modelToUse ?? "gpt-4o-mini";

  if (!sessionId) return errors.validation(reply, "sessionId is required");

  try {
    // Load the session
    const session = await (prisma as any).studio_scripts.findUnique({
      where: { id: sessionId },
      select: {
        id: true, idea: true, platform: true, niche: true,
        generated_script: true, user_id: true,
      },
    });

    if (!session) return errors.notFound(reply, "Studio session");
    if (session.user_id !== user.id) return errors.unauthorized(reply, "Not your session");

    const generatedScript = session.generated_script as any;
    if (!generatedScript?.sections?.length) {
      return errors.validation(reply, "Session has no script sections. Generate a script first.");
    }

    // Load voice portrait for context
    const voicePortrait = await getVoicePortrait(user.id);
    const voiceContext = voicePortrait
      ? `Tone: ${voicePortrait.toneSignature}, Energy: ${voicePortrait.energyLevel}, Language: ${voicePortrait.preferredLanguage}`
      : undefined;

    // Detect format from the script result
    const format = generatedScript.format ?? "reel";

    // Generate shoot plan
    const shootPlan = await generateShootPlan({
      scriptResult:     generatedScript,
      brief:            generatedScript.researchBrief ?? {},
      platform:         session.platform ?? user.primary_platform ?? "instagram",
      niche:            session.niche ?? user.niches?.[0] ?? "general",
      format,
      creatorArchetype: directorArchetypeOverride ?? user.archetype ?? "EDUCATOR",
      voiceContext,
      soloMode,
    });

    // Analyze signals
    const signalMap = analyzeAlgoSignals(
      generatedScript.sections ?? [],
      shootPlan,
      session.platform ?? "instagram",
    );

    // Persist shoot plan back to the session
    await (prisma as any).studio_scripts.update({
      where: { id: sessionId },
      data: { shot_list: { shootPlan, signalMap } as any },
    });

    const debitResult = await debitWithRetry(user.id, "shoot_plan", modelToUse, 1200, 800);

    return success(reply, {
      shootPlan,
      signalMap,
      creditsUsed: debitResult?.totalDebited ?? req.creditCheck?.featureCharge ?? 0,
    });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, "generateDirectorsCut failed");
    return errors.serviceDown(reply, "Director's Cut");
  }
};

export const getSession = async (
  req: FastifyRequest<{ Params: { sessionId: string } }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { sessionId } = req.params;
  if (!sessionId) return errors.validation(reply, "sessionId is required");
  try {
    const session = await (prisma as any).studio_scripts.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        idea: true,
        platform: true,
        niche: true,
        generated_script: true,
        edited_script: true,
        shot_list: true,
        pinned: true,
        created_at: true,
        user_id: true,
      },
    });
    if (!session) return errors.notFound(reply, "Studio session");
    if (session.user_id !== user.id) return errors.unauthorized(reply, "Not your session");
    return success(reply, session);
  } catch (err: any) {
    logger.error({ err: err.message, sessionId }, "getSession failed");
    return errors.internal(reply);
  }
};
