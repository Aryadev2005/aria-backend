// src/controllers/youtube_studio.controller.ts
import { FastifyRequest, FastifyReply } from "fastify";
import { runDeepResearch } from "../services/deep_analysis.service";
import { runYouTubeLongFormPipeline } from "../services/youtube_longform.service";
import { getVoicePortrait } from "../services/voice.service";
import { debitCredits } from "../services/credits.service";
import { prisma } from "../config/database";
import { logger } from "../utils/logger";
import { User } from "../types";

export const streamYouTubeScript = async (
  req: FastifyRequest<{ Body: any }>,
  reply: FastifyReply,
) => {
  const user = req.user as User;
  const { idea, niche, duration, mood, angle, userQuery } = req.body as any;

  if (!idea?.trim()) return reply.status(400).send({ error: "idea is required" });

  // Parse duration — YouTube requires explicit duration
  let totalMinutes = 10; // default 10 min
  if (duration) {
    const lower = String(duration).toLowerCase();
    const hr  = lower.match(/(\d+(?:\.\d+)?)\s*h/);
    const min = lower.match(/(\d+(?:\.\d+)?)\s*m/);
    if (hr)  totalMinutes = parseFloat(hr[1]) * 60;
    else if (min) totalMinutes = parseFloat(min[1]);
    totalMinutes = Math.min(Math.max(totalMinutes, 3), 180); // 3min–3hr cap
  }

  reply.raw.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sendSSE = (data: object) => {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  const keepAlive = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
  }, 20000);

  try {
    sendSSE({ type: "phase", phase: "researching", label: "Deep Research" });

    // Load voice portrait
    const voicePortrait = await getVoicePortrait(user.id);
    const voiceContext = voicePortrait
      ? `Tone: ${voicePortrait.toneSignature}, Energy: ${voicePortrait.energyLevel}, Language: ${voicePortrait.preferredLanguage}, Style: ${voicePortrait.sentenceStyle}, PreferredHookStyle: ${voicePortrait.preferredHookStyle || "curiosity gap"}`
      : undefined;

    // Load learned prefs
    let learnedPrefs = "";
    try {
      const rows = await (prisma as any).aria_memory.findMany({
        where: { user_id: user.id, category: { in: ["style", "voice"] } },
        select: { category: true, key: true, value: true },
      });
      learnedPrefs = rows.map((r: any) => `${r.category}.${r.key}: ${r.value}`).join("\n");
    } catch { /* non-critical */ }

    // Pass 1: Deep Research
    const brief = await runDeepResearch(
      {
        idea: idea.trim(),
        platform: "youtube",
        niche: niche || user.niches?.[0] || "general",
        format: "video",
        mood,
        angle,
        archetype: user.archetype || "EDUCATOR",
        followerRange: user.follower_range ?? undefined,
        voiceContext,
        learnedPrefs: learnedPrefs || undefined,
        creatorName: user.name,
        userQuery: userQuery?.trim() || idea.trim(),
        duration: `${Math.round(totalMinutes)} min`,
      },
      (event) => sendSSE(event),
    );

    sendSSE({ type: "phase", phase: "scripting", label: "Building Script" });

    // Passes 1.5–4: Long-form pipeline
    await runYouTubeLongFormPipeline(
      {
        idea: idea.trim(),
        platform: "youtube",
        niche: niche || user.niches?.[0] || "general",
        format: "video",
        totalMinutes,
        voiceContext,
        archetype: user.archetype || "EDUCATOR",
        learnedPrefs: learnedPrefs || undefined,
        userQuery: userQuery?.trim() || idea.trim(),
      },
      brief,
      (event) => sendSSE(event),
    );

    // Debit credits
    debitCredits(user.id, "script_writing", "gpt-4o-mini", 5000, 2500).catch(
      (err) => logger.warn({ err }, "Debit failed"),
    );
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, "streamYouTubeScript failed");
    sendSSE({ type: "error", message: "YouTube script generation failed. Please try again." });
  } finally {
    clearInterval(keepAlive);
    reply.raw.end();
  }
};