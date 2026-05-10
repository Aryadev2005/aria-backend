import OpenAI from "openai";
import { prisma } from "../config/database";
import { logger } from "../utils/logger";
import { getSongsForBGM } from "./songs/song.rag.service";
import { getVoicePortrait, VoicePortrait } from "./voice.service";

// ── Fetch studio learnings for a user from aria_memory ────────────────────────
const getStudioLearnings = async (userId: string): Promise<string> => {
  try {
    const rows = await (prisma as any).aria_memory.findMany({
      where: {
        user_id: userId,
        category: { in: ["style", "voice"] },
      },
      select: { category: true, key: true, value: true },
    });

    if (!rows.length) return "";

    const lines: string[] = [];
    for (const row of rows) {
      try {
        const val = JSON.parse(row.value);
        lines.push(`${row.category}.${row.key}: ${JSON.stringify(val)}`);
      } catch {
        lines.push(`${row.category}.${row.key}: ${row.value}`);
      }
    }

    return `\nCREATOR VOICE PREFERENCES LEARNED FROM PAST SCRIPTS:\n${lines.join("\n")}\nApply these preferences silently — do not mention them in output.\n`;
  } catch (err) {
    return "";
  }
};

let _openai: OpenAI | null = null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const groq = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 25_000 }); // 25s hard limit
  return _openai;
};

export interface ScriptParams {
  idea: string;
  platform: string;
  niche: string;
  archetype: string;
  format?: string;
  mood?: string;
  collaboration?: string;
  angle?: string;
  followerRange?: string;
  userId: string;
}

/**
 * Generates a full script skeleton the creator edits freely
 */
export const generateScriptStructure = async ({
  idea,
  platform,
  niche,
  archetype,
  format,
  mood,
  collaboration,
  angle,
  followerRange,
  userId,
}: ScriptParams) => {
  const isYouTube = platform?.toLowerCase() === "youtube";
  // const isShortForm = !isYouTube || format?.includes('Short');

  // Load voice portrait and learned preferences in parallel with proper error handling
  const [vpResult, lpResult] = await Promise.allSettled([
    getVoicePortrait(userId),
    getStudioLearnings(userId),
  ]);
  const voicePortrait: VoicePortrait | null =
    vpResult.status === "fulfilled" ? vpResult.value : null;
  const learnedPreferences: string =
    lpResult.status === "fulfilled" ? (lpResult.value as string) : "";

  const voiceRulesCtx = voicePortrait
    ? `

CREATOR VOICE RULES (mandatory — override generic advice):
- Write in this tone: ${voicePortrait.toneSignature}
- Vocabulary level: ${voicePortrait.vocabularyLevel}
- Energy: ${voicePortrait.energyLevel}
- Their sentence style: ${voicePortrait.sentenceStyle}
- Their natural hook style: ${voicePortrait.preferredHookStyle}
- Language: ${voicePortrait.preferredLanguage}
${voicePortrait.personalConstraints.length > 0 ? `- Constraints to respect: ${voicePortrait.personalConstraints.join(", ")}` : ""}

The script MUST sound like this specific creator wrote it.
If their tone is casual-humorous, make the hook funny.
If they use Hinglish, mix Hindi and English naturally.
If they are a faceless creator, every visual direction should not require showing a face.
Write it as if you know this person and their audience personally.`
    : "";

  const prompt = `You are ARIA — India's top content strategist.

Creator: ${archetype} | Niche: ${niche} | Platform: ${platform}
Idea: "${idea}"
Format: ${format || (isYouTube ? "YouTube 8min" : "Reel 30s")}
Mood: ${mood || "informative"} | Collab: ${collaboration || "solo"}
Angle: "${angle || "general"}"
Followers: ${followerRange || "10K-50K"}
${learnedPreferences}
RULES:
- Give EXACT words for the hook (first 3 seconds). This is the most important line.
- Each section has: duration, what to say/show, ARIA tip
- Tips must be specific — not generic advice
- Indian context where natural (mention brands, festivals, places)
- Short-form: tight, punchy. Long-form: build tension, payoff.${voiceRulesCtx}

Respond ONLY with valid JSON:
{
  "hookLine": "Exact words to say in the first 3 seconds",
  "hookTip": "Why this hook works for this archetype + niche",
  "sections": [
    {
      "id": "hook",
      "label": "Hook",
      "duration": "0-3s",
      "content": "Exact suggested words/action",
      "bRollIdea": "What to show visually",
      "ariaTip": "Specific ARIA advice for this section",
      "isEditable": true
    },
    {
      "id": "context",
      "label": "Context / Setup",
      "duration": "3-8s",
      "content": "Suggested content",
      "bRollIdea": "Visual suggestion",
      "ariaTip": "ARIA tip",
      "isEditable": true
    },
    {
      "id": "value",
      "label": "The Value",
      "duration": "8-25s",
      "content": "Core content suggestion",
      "bRollIdea": "Visual suggestion",
      "ariaTip": "ARIA tip",
      "isEditable": true
    },
    {
      "id": "cta",
      "label": "CTA",
      "duration": "25-30s",
      "content": "Exact CTA words",
      "bRollIdea": "End frame suggestion",
      "ariaTip": "Why this CTA works",
      "isEditable": true
    }
  ],
  "shootingTips": [
    "Specific shooting tip 1 for this archetype",
    "Specific shooting tip 2",
    "Specific shooting tip 3"
  ],
  "commonMistake": "The one mistake creators make with this exact type of content",
  "estimatedViews": "20K-80K",
  "viralPotential": 78
}`;

  const res = await groq().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 1800,
    temperature: 0.7,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from OpenAI");

  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean);
};

export interface SectionAdviseParams {
  sectionLabel: string;
  creatorContent: string;
  sectionType: string;
  idea: string;
  platform: string;
  niche: string;
  archetype: string;
  mood: string;
}

/**
 * Called when creator asks ARIA to advise on a specific section they wrote
 */
export const adviseOnSection = async ({
  sectionLabel,
  creatorContent,
  sectionType,
  idea,
  platform,
  niche,
  archetype,
  mood,
}: SectionAdviseParams) => {
  const prompt = `You are ARIA — India's top content strategist and editor.

A creator wrote this for their "${sectionLabel}" section:
"${creatorContent}"

Context:
- Idea: "${idea}" | Niche: ${niche} | Platform: ${platform}
- Archetype: ${archetype} | Mood: ${mood}
- Section type: ${sectionType}

Give your honest editorial opinion. Be specific. Be direct.
If it's good, say why. If it needs work, say exactly what and give a better version.
Don't be generic. Reference the actual words they wrote.

Respond ONLY with valid JSON:
{
  "verdict": "strong|decent|weak",
  "score": 75,
  "whatWorks": "Specific thing that works about what they wrote",
  "whatDoesnt": "Specific thing that doesn't work (null if nothing)",
  "suggestion": "Your improved version of JUST this section",
  "reasoning": "Why your version is stronger — be specific",
  "keepOrReplace": "keep|replace|modify"
}`;

  const res = await groq().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 600,
    temperature: 0.75,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from OpenAI");

  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean);
};

export interface BGMParams {
  idea: string;
  mood?: string;
  niche: string;
  platform: string;
  archetype: string;
  duration?: string;
  language?: string;
  userId: string;
}

export const matchBGM = async ({
  idea,
  mood,
  niche,
  platform,
  archetype,
  duration,
  language = "Hindi",
  userId,
}: BGMParams) => {
  // Load voice portrait for personalization
  const voicePortrait = await getVoicePortrait(userId).catch(() => null);

  // ── Pull live songs from Tier 1 hot window ────────────────────────────────
  const liveSongs = await Promise.race([
    getSongsForBGM({ niche, language, limit: 15 }),
    new Promise<any[]>((resolve) => setTimeout(() => resolve([]), 4000)),
  ]).catch(() => []);

  const liveContext =
    liveSongs.length > 0
      ? `\nCURRENTLY TRENDING SONGS (live data):\n` +
        liveSongs
          .slice(0, 10)
          .map((s) => {
            const position =
              s.chart_position > 0 ? `#${s.chart_position}` : "N/A";
            const change = s.chart_change
              ? ` (Δ ${s.chart_change >= 0 ? "+" : ""}${s.chart_change})`
              : "";
            const streams = s.streams_today
              ? `, ${Number(s.streams_today).toLocaleString("en-IN")} streams`
              : "";
            const signal =
              s.signal === "postNow"
                ? " ⚡ POST NOW"
                : s.signal === "tooLate"
                  ? " 💀 TOO LATE"
                  : "";
            return `• "${s.title}" by ${s.artist} — position ${position}${change}${streams}${signal}`;
          })
          .join("\n")
      : "";

  const energyProfileCtx = voicePortrait
    ? `

CREATOR ENERGY PROFILE:
- Energy level: ${voicePortrait.energyLevel}
- Tone: ${voicePortrait.toneSignature}
- Audience: ${voicePortrait.audienceDescription}
- Content territory: ${voicePortrait.contentTerritory}

Match BGM to this energy profile specifically.
A calm-educational creator needs different audio than a high-energy entertainer
even when covering the same trend. Prioritise mood-match over trend-match for this creator.`
    : "";

  const prompt = `You are ARIA — India's music curator for creators.

Match BGM for this content:
- Idea: "${idea}"
- Mood: ${mood || "informative"}
- Niche: ${niche} | Platform: ${platform}
- Archetype: ${archetype}
- Duration: ${duration || "30s"}
- Language preference: ${language}
${energyProfileCtx}

${liveContext}

AUDIO RULES BY ARCHETYPE:
- TRENDSETTER/PERFORMER: Trending Bollywood or viral audio IS the content
- EDUCATOR/EXPERT/HUSTLER: Clean voiceover wins — no trending audio
- STORYTELLER/ATHLETE: Royalty-free instrumental only
- ENTERTAINER: Trending meme audio is mandatory
- CHEF: ASMR natural sounds over music
- CONNECTOR: Soft emotional Bollywood

Give 3 song recommendations. For each, give the EXACT timestamp tip.

Respond ONLY with valid JSON:
{
  "recommendations": [
    {
      "rank": 1,
      "title": "Song title",
      "artist": "Artist name",
      "why": "Why this song fits THIS specific idea and mood",
      "timestampTip": "Use the drop at 0:07 when you show the transformation",
      "source": "spotify|jiosaavn|royalty-free|trending-audio",
      "viralPotential": 88,
      "isFromLiveData": true,
      "lifecycle": "RISING",
      "signal": "postNow",
      "warning": null
    }
  ],
  "audioStrategy": "One sentence on the overall audio strategy for this archetype",
  "avoidThis": "What audio to specifically avoid and why"
}`;

  const res = await groq().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 800,
    temperature: 0.7,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from OpenAI");

  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean);
};

export interface ShotListParams {
  idea: string;
  format: string;
  niche: string;
  archetype: string;
  sections: any[];
}

export const generateShotList = async ({
  idea,
  format,
  niche,
  archetype,
  sections,
}: ShotListParams) => {
  const prompt = `You are ARIA — India's creative director.

Generate a practical shot list for this content. Filmable with a smartphone.

Idea: "${idea}" | Format: ${format} | Niche: ${niche} | Archetype: ${archetype}
Script sections: ${JSON.stringify(sections?.map((s) => ({ label: s.label, content: s.content?.slice(0, 80) })) || [])}

Every shot must be:
- Achievable with a phone camera
- Specific about framing, movement, lighting
- In order of filming (not edit order — batch shots by location)

Respond ONLY with valid JSON:
{
  "shots": [
    {
      "id": "shot_1",
      "order": 1,
      "label": "Hook — Face to camera",
      "frameType": "Close-up | Medium | Wide | Over-the-shoulder | POV",
      "movement": "Static | Slow push in | Pan left | Handheld",
      "lighting": "Natural window light, camera facing window",
      "action": "Exactly what to do/say",
      "duration": "3s",
      "tip": "Specific ARIA tip for nailing this shot",
      "linkedSection": "hook"
    }
  ],
  "gearNeeded": ["Phone tripod/stabiliser", "Ring light (optional)"],
  "locationTips": "Where to film for best results for this niche",
  "goldenstateTime": "Best time of day for natural light for this content"
}`;

  const res = await groq().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 1200,
    temperature: 0.7,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from OpenAI");

  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean);
};

export interface EditingHelpParams {
  problem: string;
  tool: string;
  niche: string;
  archetype: string;
}

export const getEditingHelp = async ({
  problem,
  tool,
  niche,
  archetype,
}: EditingHelpParams) => {
  const EDITING_KB: Record<string, string> = {
    CapCut:
      "CapCut mobile app — has auto-captions, templates, effects, speed control, keyframes",
    InShot: "InShot mobile — good for music sync, transitions, text overlays",
    VN: "VN (Video Ninja) — professional timeline, colour grading, good for YouTube",
    Premiere: "Adobe Premiere Pro desktop — full professional NLE",
    "Final Cut": "Final Cut Pro — Mac only, magnetic timeline",
    DaVinci: "DaVinci Resolve — free professional grade, colour correction",
  };

  const toolInfo = EDITING_KB[tool] || `${tool} editing software`;

  const prompt = `You are ARIA — India's editing mentor.

A ${archetype} creator in ${niche} using ${tool} needs help with:
"${problem}"

Tool context: ${toolInfo}

Give EXACT step-by-step fix. Not general tips — the actual steps in ${tool}.
Include: what to tap/click, what settings to use, what to watch out for.

If there's a YouTube tutorial that would help, mention the search term.

Respond ONLY with valid JSON:
{
  "solution": "One sentence summary of the fix",
  "steps": [
    {
      "step": 1,
      "action": "Exact action to take in ${tool}",
      "detail": "More detail if needed"
    }
  ],
  "proTip": "One advanced tip related to this that most creators don't know",
  "youtubeTutorialSearch": "Exact search term to find a tutorial for this",
  "commonMistake": "What creators usually do wrong with this",
  "timeToLearn": "2 minutes|10 minutes|30 minutes"
}`;

  const res = await groq().chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: 700,
    temperature: 0.6,
    messages: [{ role: "user", content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error("Empty response from OpenAI");

  const clean = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean);
};

/**
 * Save studio session to DB
 */
export const saveStudioSession = async (userId: string, sessionData: any) => {
  try {
    const session = await (prisma as any).studio_sessions.create({
      data: {
        user_id: userId,
        idea: sessionData.idea,
        platform: sessionData.platform,
        niche: sessionData.niche,
        script_structure: (sessionData.scriptStructure || {}) as any,
        bgm_suggestions: (sessionData.bgmSuggestions || {}) as any,
        shot_list: (sessionData.shotList || {}) as any,
      },
      select: { id: true },
    });
    return session.id;
  } catch (err) {
    logger.warn({ err }, "Studio session save failed");
    return null;
  }
};
