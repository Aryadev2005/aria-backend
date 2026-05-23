// src/services/shootPlan.service.ts
// ══════════════════════════════════════════════════════════════════
// ARIA Director's Cut — Shoot Plan Generator
//
// Single AI call (NOT an agent loop — research is already done).
// Translates a completed ScriptResult into a shot-by-shot shooting guide.
// Uses OpenAI structured outputs (json_schema strict mode) for reliability.
//
// Model routing:
//   Standard tier → gpt-4o-mini (fast, cheap, structured output)
//   The creative tier is NOT needed here — this is translation, not generation.
//
// Input:  ScriptResult + ResearchBrief + platform + niche + voiceContext
// Output: ShootPlan
// ══════════════════════════════════════════════════════════════════

import OpenAI from "openai";
import { logger } from "../utils/logger";
import { ResearchBrief, ScriptResult } from "./deep_analysis.service";
import {
  ShootPlan, ShotCard, BrollShot, DirectorArchetype,
} from "./studioV2.types";

// ── Constants ─────────────────────────────────────────────────────

const ARCHETYPE_MAP: Record<string, DirectorArchetype> = {
  EDUCATOR:    "ARCHITECT",
  EXPERT:      "ARCHITECT",
  ENTERTAINER: "ENERGY",
  STORYTELLER: "STORYTELLER",
  TRENDSETTER: "ARTIST",
  CONNECTOR:   "STORYTELLER",
  HUSTLER:     "OBSERVER",
};

const ARCHETYPE_LABELS: Record<DirectorArchetype, string> = {
  ARCHITECT:   "The Architect (Christopher Nolan)",
  OBSERVER:    "The Observer (Stanley Kubrick)",
  STORYTELLER: "The Storyteller (Steven Spielberg)",
  ARTIST:      "The Artist (Wes Anderson)",
  ENERGY:      "The Energy (Martin Scorsese)",
  REALIST:     "The Realist (Bong Joon-ho)",
};

const ARCHETYPE_INSTRUCTIONS: Record<DirectorArchetype, string> = {
  ARCHITECT:   "Use tight cross-cutting, insert shots of objects, pattern interrupts every 8s. Every shot serves information delivery. No wasted frames.",
  OBSERVER:    "Use dead-center symmetrical framing (Kubrick). Slow deliberate pacing. Authority radiates from stillness. Push-ins for emotional moments.",
  STORYTELLER: "Arc from wide-establishing to intimate close-up. Emotional dolly-in at the share trigger moment. Let the story breathe.",
  ARTIST:      "Flat perpendicular framing throughout. Camera always perpendicular to subject — never angled. Color-conscious backgrounds. Visual identity over dynamism.",
  ENERGY:      "Maximum 2-3s per shot cut. Handheld energy. Raw authenticity. Fast cuts at value peaks. Never static for more than 5s.",
  REALIST:     "Observational angles. Unexpected framing. Environmental context. Show before you tell. Real over polished.",
};

// ── JSON Schema for structured output ────────────────────────────
// Using OpenAI structured outputs (gpt-4o-mini, strict mode)
// This guarantees valid JSON with correct types — no parsing errors.

const SHOOT_PLAN_SCHEMA = {
  type: "object",
  properties: {
    estimatedShootTime:   { type: "string" },
    equipmentNeeded:      { type: "array", items: { type: "string" } },
    lightingSetup:        { type: "string" },
    locationSuggestion:   { type: "string" },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          shotNumber:         { type: "integer" },
          scriptSectionId:    { type: "string" },
          scriptSectionLabel: { type: "string" },
          shotType:           { type: "string" },
          subject:            { type: "string" },
          cameraPosition:     { type: "string" },
          cameraMovement:     { type: "string" },
          dialogue:           { type: "string" },
          action:             { type: "string" },
          onScreenText:       { type: ["string", "null"] },
          textPosition:       { type: "string", enum: ["top", "center", "bottom"] },
          durationSeconds:    { type: "number" },
          timestampStart:     { type: "string" },
          timestampEnd:       { type: "string" },
          directorNote:       { type: "string" },
          algoSignals:        { type: "array", items: { type: "string" } },
          algoReason:         { type: "string" },
          brollNeeded:        { type: "boolean" },
          brollDescription:   { type: ["string", "null"] },
          soloTip:            { type: "string" },
          energyLevel:        { type: "string", enum: ["calm", "building", "peak", "release"] },
          lightingNote:       { type: "string" },
        },
        required: [
          "shotNumber", "scriptSectionId", "scriptSectionLabel", "shotType",
          "subject", "cameraPosition", "cameraMovement", "dialogue", "action",
          "onScreenText", "textPosition", "durationSeconds", "timestampStart",
          "timestampEnd", "directorNote", "algoSignals", "algoReason",
          "brollNeeded", "brollDescription", "soloTip", "energyLevel", "lightingNote",
        ],
        additionalProperties: false,
      },
    },
    brollBank: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:          { type: "string" },
          description: { type: "string" },
          shotType:    { type: "string" },
          usedInShots: { type: "array", items: { type: "integer" } },
          soloTip:     { type: "string" },
        },
        required: ["id", "description", "shotType", "usedInShots", "soloTip"],
        additionalProperties: false,
      },
    },
  },
  required: ["estimatedShootTime", "equipmentNeeded", "lightingSetup", "locationSuggestion", "shots", "brollBank"],
  additionalProperties: false,
};

// ── Client factory ────────────────────────────────────────────────

let _openai: OpenAI | null = null;
function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 60_000 });
  return _openai;
}

// ── Director archetype resolver ───────────────────────────────────

export function resolveDirectorArchetype(creatorArchetype: string): DirectorArchetype {
  return ARCHETYPE_MAP[creatorArchetype?.toUpperCase()] ?? "ARCHITECT";
}

// ── Main generator ────────────────────────────────────────────────

export interface ShootPlanInput {
  scriptResult: ScriptResult;
  brief: ResearchBrief;
  platform: string;
  niche: string;
  format: string;
  creatorArchetype: string;
  voiceContext?: string;
  soloMode?: boolean;
}

export async function generateShootPlan(input: ShootPlanInput): Promise<ShootPlan> {
  const {
    scriptResult, brief, platform, niche, format,
    creatorArchetype, voiceContext, soloMode = true,
  } = input;

  const directorArchetype = resolveDirectorArchetype(creatorArchetype);
  const directorLabel = ARCHETYPE_LABELS[directorArchetype];
  const directorInstructions = ARCHETYPE_INSTRUCTIONS[directorArchetype];

  // Build section summary for the prompt (keep it lean)
  const sectionSummary = scriptResult.sections
    .map((s, i) => `Section ${i + 1} [id:${s.id}, type:${s.type}, label:"${s.label}", duration:"${s.durationEstimate ?? ""}"]:\n${s.content.slice(0, 300)}`)
    .join("\n\n");

  const isShortForm = ["reel", "youtube_short", "short"].includes(format);
  const totalDurationSeconds = isShortForm ? 30 : 600;

  const systemPrompt = `You are ARIA's Director — the world's best shot-by-shot shooting guide for solo Indian content creators.

You combine the visual intelligence of Christopher Nolan, Stanley Kubrick, Steven Spielberg, Wes Anderson, and Scorsese with deep knowledge of Instagram and YouTube algorithms in 2026.

DIRECTOR ARCHETYPE FOR THIS CREATOR: ${directorLabel}
DIRECTORIAL APPROACH: ${directorInstructions}

PLATFORM: ${platform.toUpperCase()} | FORMAT: ${format} | NICHE: ${niche}
SOLO CREATOR MODE: ${soloMode ? "YES — all shots must be executable alone with a smartphone + basic tripod" : "NO"}
${voiceContext ? `CREATOR VOICE: ${voiceContext}` : ""}

ALGORITHM KNOWLEDGE (inject into every shot decision):
- Instagram 2026: DM shares (sends) are 3-5x more valuable than likes. First 3 seconds are the audition — non-followers decide your fate. Completion rate drives distribution.
- YouTube 2026: First 30 seconds lock in satisfaction prediction. Chapters improve AVD. Viewer satisfaction (repeat views, shares) outranks raw watch time.

SHOT RULES — NEVER BREAK:
1. Hook section MUST have MUTE_HOOK_FRAME as shot 1 (50% of viewers are muted — text on screen mandatory)
2. Every reel/short MUST have exactly ONE SHARE_TRIGGER_CLOSE shot — the mic-drop moment engineered for DM forwarding
3. Every reel/short MUST end with REWATCH_LOOP_CLOSE — final shot matches opening visual for seamless loop
4. Solo creator shots: phone + tripod/prop only. No second camera operator.
5. Indian lighting reality: most creators shoot indoors. Lighting notes must be practical (natural window light, ring light, etc.)
6. On-screen text: written in the creator's natural voice (Hinglish if relevant to niche)
7. algoSignals array: use ONLY these values: WATCH_PAST_3S, COMPLETION_BOOST, DM_SHARE_TRIGGER, SAVE_TRIGGER, REWATCH_LOOP, COMMENT_BAIT, FOLLOW_TRIGGER, TRUST_SCORE_BUILD, CTR_HOOK, SATISFACTION_LOCK, CHAPTER_PROMISE, SESSION_EXTENSION, PATTERN_INTERRUPT
8. shotType: use ONLY these values: MUTE_HOOK_FRAME, SPOKEN_HOOK, PATTERN_INTERRUPT_CUT, SHARE_TRIGGER_CLOSE, REWATCH_LOOP_CLOSE, KUBRICK_CENTER, NOLAN_INSERT, SPIELBERG_DOLLY, ANDERSON_FLAT, SCORSESE_HANDHELD, PHONE_PROP_STATIC, SELFIE_LOW_ANGLE, BROLL_HANDS, BROLL_ENVIRONMENT, WALK_AND_TALK, TALKING_HEAD_MCU
9. energyLevel: use ONLY: calm, building, peak, release
10. textPosition: use ONLY: top, center, bottom`;

  const userPrompt = `Create a complete shot-by-shot shoot plan for this ${platform} ${format}.

SCRIPT SECTIONS:
${sectionSummary}

RESEARCH CONTEXT:
- Trend: ${brief.trendStrength} — ${brief.trendSummary}
- Audience: ${brief.audienceInsights}
- Top viral angle used: ${brief.topViralAngles[0] ?? "general"}
- Hook line: "${scriptResult.hookLine}"
- Total duration: ${scriptResult.totalDuration}

For short-form (reels/shorts), generate 6-10 shots covering the full ${totalDurationSeconds}s.
For long-form YouTube, generate 3-5 shots per chapter section.
Always include a brollBank of 3-5 reusable B-roll shots.

Generate the shoot plan now.`;

  try {
    const client = getClient();
    const TIMEOUT_MS = 55_000; // 55s — slightly under the 60s client timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Shoot plan generation timed out after 55s")), TIMEOUT_MS)
    );

    const response = await Promise.race([
      client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        max_tokens: 3500,
        temperature: 0.3,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "shoot_plan",
            strict: true,
            schema: SHOOT_PLAN_SCHEMA,
          },
        },
      }),
      timeoutPromise,
    ]) as OpenAI.Chat.Completions.ChatCompletion;

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error("Empty response from shoot plan generator");

    // With structured outputs, this parse is guaranteed not to throw
    const parsed = JSON.parse(raw);

    const shootPlan: ShootPlan = {
      platform,
      format,
      directorArchetype,
      directorArchetypeLabel: directorLabel,
      totalShots: parsed.shots.length,
      estimatedShootTime: parsed.estimatedShootTime,
      equipmentNeeded: parsed.equipmentNeeded,
      lightingSetup: parsed.lightingSetup,
      locationSuggestion: parsed.locationSuggestion,
      shots: parsed.shots as ShotCard[],
      brollBank: parsed.brollBank as BrollShot[],
      soloMode,
    };

    logger.info(
      { platform, format, directorArchetype, shots: shootPlan.totalShots },
      "[ShootPlan] Generated successfully",
    );

    return shootPlan;
  } catch (err: any) {
    logger.error({ err: err.message, platform, format }, "[ShootPlan] Generation failed");
    throw err;
  }
}
