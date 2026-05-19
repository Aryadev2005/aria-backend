// src/services/youtube_longform.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// YouTube Long-Form Pipeline
// Separate from short-form. Called ONLY for YouTube videos > 3 minutes.
//
// PASS 1: Deep research (enhanced — competitor analysis + search trends)
// PASS 1.5: Chapter Architect — returns ChapterPlan data structure
// PASS 2: Title + Thumbnail Concept + Opening 90 Seconds (atomic unit)
// PASS 3: Chapter generation (sequential, loop-aware, with narrativeState)
// PASS 4: Production document exploder (talking head / b-roll / on-screen text)
// ══════════════════════════════════════════════════════════════════════════════

import OpenAI from "openai";
import { routerCall, parseRouterJSON } from "./model_router.service";
import { ResearchBrief, SSEEvent } from "./deep_analysis.service";
import { makeStructuralDecision } from "./narrative_decision.service";
import { logger } from "../utils/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CuriosityLoop {
  id: string;
  openedAt: string;       // Chapter label where this opens
  question: string;       // The specific unanswered question
  closedAt: string | null;// Chapter label where this resolves (null = open)
}

export interface ChapterBlueprint {
  id: string;
  index: number;
  label: string;
  purpose: "hook" | "intro" | "body" | "detail" | "recap" | "cta";
  durationMinutes: number;
  targetWords: number;
  startMin: number;
  endMin: number;
  loopsToOpen: string[];      // curiosity loop IDs to open
  loopsToClose: string[];     // curiosity loop IDs to close
  dropOffRisk: "low" | "medium" | "high";
  requiresReHook: boolean;    // inject hard re-hook at start
  tip: string;
}

export interface ChapterPlan {
  chapters: ChapterBlueprint[];
  openingLoops: CuriosityLoop[];
  totalDuration: string;
  thumbnailConcept: string;  // What the thumbnail should show
  titleOptions: string[];    // 3 SEO-optimised title options
}

export interface YouTubeOpeningUnit {
  title: string;             // Final chosen title
  thumbnailConcept: string;  // Detailed thumbnail description
  opening90s: string;        // Full spoken script for first 90 seconds
  openingTip: string;        // Delivery instruction
  loopsOpened: string[];     // Which loops are opened in first 90s
}

export interface ChapterResult {
  id: string;
  label: string;
  script: string;            // Full spoken script for this chapter
  productionNotes: ProductionNote[];
  tip: string;
  loopsClosed: string[];
}

export interface ProductionNote {
  timestamp: string;         // e.g. "0:15–0:30"
  type: "talking_head" | "broll" | "onscreen_text" | "transition" | "music_note";
  instruction: string;
}

export interface YouTubeScriptResult {
  chapterPlan: ChapterPlan;
  openingUnit: YouTubeOpeningUnit;
  chapters: ChapterResult[];
  caption: string;
  hashtags: string[];
  totalDuration: string;
  researchBrief: ResearchBrief;
}

// ── Narrative state (tracks open loops across chapter generation) ─────────────

interface NarrativeState {
  openLoops: CuriosityLoop[];
  establishedFacts: string[];    // Rolling list of what's been introduced
  lastChapterSummary: string;
}

// ── Chapter Architect ─────────────────────────────────────────────────────────

export async function buildChapterPlan(params: {
  idea: string;
  platform: string;
  niche: string;
  totalMinutes: number;
  brief: ResearchBrief;
  voiceContext?: string;
}): Promise<ChapterPlan> {
  const { idea, platform, niche, totalMinutes, brief, voiceContext } = params;
  const totalWords = Math.round(totalMinutes * 150);

  const prompt = `You are a world-class YouTube video architect for Indian creators.
Design the optimal chapter structure for this long-form video.

VIDEO BRIEF:
- Topic: "${idea}"
- Platform: ${platform} | Niche: ${niche}
- Total duration: ${Math.round(totalMinutes)} minutes (~${totalWords} words)
- Trend: ${brief.trendStrength} — ${brief.trendSummary}
- Why it works: ${brief.whyItWorks}
- Audience: ${brief.audienceInsights}
- Top angles: ${brief.topViralAngles.slice(0, 3).join(" | ")}
- Competitor gap: ${brief.competitorGaps}
${voiceContext ? `- Creator voice: ${voiceContext}` : ""}

ARCHITECTURE RULES:
1. Hook section: 30–90 seconds. Opens 2–3 curiosity loops. Thumbnail promise stated.
2. Intro/context: max 2 minutes. Establishes credibility. Teases the structure.
3. Body chapters: each covers ONE focused idea. Minimum 2 min each.
4. Mark chapters with HIGH drop-off risk (usually between chapter 2→3, and at halfway).
5. requiresReHook=true for any chapter after a high drop-off risk chapter.
6. Outro/CTA: 60–90 seconds. Close all open loops. ONE specific CTA.
7. Total chapter count: 5–8 for 10–15min, 8–12 for 20–30min, 12+ for 45–60min.
8. Title options must be search-optimised for Indian YouTube audience.

Return ONLY valid JSON (NO markdown):
{
  "thumbnailConcept": "Detailed description of what the thumbnail shows — text overlay, image, emotion",
  "titleOptions": ["SEO title option 1", "SEO title option 2", "SEO title option 3"],
  "openingLoops": [
    {"id": "loop1", "openedAt": "Hook", "question": "The exact curiosity question opened", "closedAt": null},
    {"id": "loop2", "openedAt": "Hook", "question": "Second loop", "closedAt": null}
  ],
  "chapters": [
    {
      "id": "c0",
      "index": 0,
      "label": "Specific descriptive chapter title",
      "purpose": "hook",
      "durationMinutes": 1,
      "targetWords": 150,
      "startMin": 0,
      "endMin": 1,
      "loopsToOpen": ["loop1", "loop2"],
      "loopsToClose": [],
      "dropOffRisk": "low",
      "requiresReHook": false,
      "tip": "Delivery tip for this specific chapter"
    }
  ],
  "totalDuration": "${Math.round(totalMinutes)} minutes"
}`;

  try {
    const result = await routerCall({
      tier: "creative",
      system: "You are a YouTube video architect. Return ONLY valid JSON.",
      user: prompt,
      maxTokens: 2500,
      temperature: 0.4,
      jsonMode: true,
    });
    const plan = parseRouterJSON<ChapterPlan>(result);
    logger.info({ chapters: plan.chapters.length, idea }, "[ChapterArchitect] Plan built");
    return plan;
  } catch (err: any) {
    logger.error({ err: err.message }, "[ChapterArchitect] Failed");
    throw err;
  }
}

// ── Opening 90s unit ──────────────────────────────────────────────────────────

export async function generateOpeningUnit(params: {
  idea: string;
  niche: string;
  brief: ResearchBrief;
  chapterPlan: ChapterPlan;
  voiceContext?: string;
  archetype: string;
}): Promise<YouTubeOpeningUnit> {
  const { idea, niche, brief, chapterPlan, voiceContext, archetype } = params;

  const title = chapterPlan.titleOptions[0];
  const loops = chapterPlan.openingLoops;

  const prompt = `You are ARIA — India's elite YouTube scriptwriter.
Write the Opening 90 Seconds for this YouTube video.
This is the MOST CRITICAL part — it determines whether viewers stay.

VIDEO: "${title}"
THUMBNAIL CONCEPT: ${chapterPlan.thumbnailConcept}
Creator archetype: ${archetype}
${voiceContext ? `Voice profile: ${voiceContext}` : ""}

CURIOSITY LOOPS TO OPEN (must open ALL of these in first 90s):
${loops.map((l, i) => `${i + 1}. "${l.question}"`).join("\n")}

RESEARCH CONTEXT:
- Trend: ${brief.trendSummary}
- Why this topic works: ${brief.whyItWorks}
- Proven hooks: ${brief.hookPatterns.slice(0, 3).join(" | ")}
- Audience: ${brief.audienceInsights}

RULES FOR OPENING 90 SECONDS:
1. First 5 words must be the most compelling of the entire video
2. The thumbnail's promise must be stated explicitly within first 30 seconds
3. Open ALL curiosity loops — the viewer must need to keep watching to get answers
4. Give a clear "here's what you'll get" moment at 60–75 seconds (structure preview)
5. NO "Hey guys welcome back to my channel"
6. NO generic intro — start mid-energy, like something important is happening
7. Hinglish is fine if natural for the creator's voice
8. Write ~225 words for 90 seconds (150 words/min)

Return ONLY valid JSON:
{
  "title": "${title}",
  "thumbnailConcept": "${chapterPlan.thumbnailConcept}",
  "opening90s": "Full 225-word spoken script for the first 90 seconds",
  "openingTip": "How to deliver this opening — energy, pacing, camera positioning",
  "loopsOpened": ${JSON.stringify(loops.map((l) => l.id))}
}`;

  const result = await routerCall({
    tier: "creative",
    system: "You are ARIA — India's elite YouTube scriptwriter. Return ONLY valid JSON.",
    user: prompt,
    maxTokens: 1200,
    temperature: 0.85,
    jsonMode: true,
  });

  return parseRouterJSON<YouTubeOpeningUnit>(result);
}

// ── Chapter generator ─────────────────────────────────────────────────────────

async function generateChapter(params: {
  chapter: ChapterBlueprint;
  chapterIndex: number;
  totalChapters: number;
  idea: string;
  niche: string;
  archetype: string;
  brief: ResearchBrief;
  narrativeState: NarrativeState;
  voiceContext?: string;
  chapterPlan: ChapterPlan;
}): Promise<ChapterResult> {
  const {
    chapter, chapterIndex, totalChapters, idea, niche, archetype,
    brief, narrativeState, voiceContext, chapterPlan,
  } = params;

  const openLoopsFormatted = narrativeState.openLoops
    .filter((l) => l.closedAt === null)
    .map((l) => `"${l.question}"`)
    .join(", ");

  const loopsToCloseThisChapter = chapterPlan.openingLoops
    .filter((l) => chapter.loopsToClose.includes(l.id))
    .map((l) => l.question);

  const prompt = `You are ARIA — India's elite YouTube scriptwriter.
Write Chapter ${chapterIndex + 1} of ${totalChapters}: "${chapter.label}"

VIDEO: "${idea}" | Niche: ${niche} | Creator: ${archetype}
${voiceContext ? `Voice: ${voiceContext}` : ""}

CHAPTER SPECS:
- Duration: ${chapter.durationMinutes} minutes (~${chapter.targetWords} words)
- Timestamp: ${chapter.startMin.toFixed(1)}–${chapter.endMin.toFixed(1)} min
- Purpose: ${chapter.purpose}
- Drop-off risk: ${chapter.dropOffRisk}
${chapter.requiresReHook ? "⚠️ HIGH DROP-OFF RISK BEFORE THIS CHAPTER — open with a hard re-hook. Use a pattern interrupt or bold re-statement of what's coming." : ""}

NARRATIVE STATE (what has been established):
- Open curiosity loops viewer is waiting to have answered: ${openLoopsFormatted || "none"}
- Last chapter covered: ${narrativeState.lastChapterSummary || "this is the first chapter"}
${loopsToCloseThisChapter.length > 0 ? `- LOOPS TO CLOSE IN THIS CHAPTER: ${loopsToCloseThisChapter.join(" | ")}` : ""}

RESEARCH CONTEXT:
- Key insight for this chapter: ${brief.whyItWorks}
- Audience pain: ${brief.audienceInsights}

WRITING RULES:
1. Write ${chapter.targetWords} words of natural spoken dialogue
2. Maintain the narrative thread from the previous chapter
3. Each paragraph = one idea. Max 3 sentences per paragraph.
4. Use Indian examples, ₹ for money, Indian cities/brands where relevant
5. If requiresReHook=true: FIRST sentence must be a pattern interrupt or bold claim
6. If this chapter closes a curiosity loop: pay it off precisely and satisfyingly
7. Include a micro-CTA at the end ("screenshot this", "pause and do this now") for non-final chapters
8. NO generic transitions ("So, moving on..." / "Now let's talk about...")

Also generate 3–5 production notes for this chapter (timestamps within the chapter, starting from 0:00 for this chapter).

Return ONLY valid JSON:
{
  "script": "Full ${chapter.targetWords}-word spoken script for this chapter",
  "productionNotes": [
    {"timestamp": "0:00–0:30", "type": "talking_head", "instruction": "Direct to camera, energetic"},
    {"timestamp": "0:30–1:00", "type": "broll", "instruction": "Show [specific visual]"},
    {"timestamp": "1:00–1:30", "type": "onscreen_text", "instruction": "Text overlay: [specific text]"}
  ],
  "tip": "Key delivery tip for this chapter",
  "loopsClosed": ${JSON.stringify(chapter.loopsToClose)}
}`;

  const result = await routerCall({
    tier: chapter.purpose === "hook" || chapter.requiresReHook ? "creative" : "standard",
    system: "You are ARIA — India's elite YouTube scriptwriter. Return ONLY valid JSON. Write full spoken script — never summarise.",
    user: prompt,
    maxTokens: Math.max(chapter.targetWords * 7, 1500),
    temperature: 0.78,
    jsonMode: true,
  });

  const parsed = parseRouterJSON<any>(result);
  return {
    id: chapter.id,
    label: chapter.label,
    script: parsed.script || "",
    productionNotes: parsed.productionNotes || [],
    tip: parsed.tip || chapter.tip,
    loopsClosed: parsed.loopsClosed || [],
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runYouTubeLongFormPipeline(
  input: {
    idea: string;
    platform: string;
    niche: string;
    format: string;
    totalMinutes: number;
    voiceContext?: string;
    archetype: string;
    learnedPrefs?: string;
    userQuery?: string;
  },
  brief: ResearchBrief,
  onEvent: (event: SSEEvent | {
    type: "chapter_plan"; plan: ChapterPlan;
  } | {
    type: "opening_unit"; unit: YouTubeOpeningUnit;
  } | {
    type: "chapter"; chapter: ChapterResult; index: number; total: number;
  }) => void,
): Promise<YouTubeScriptResult> {
  const { idea, platform, niche, archetype, voiceContext, totalMinutes } = input;

  // Pass 1.5: Chapter Architect
  onEvent({ type: "research_update", message: "Building chapter architecture…" });
  const chapterPlan = await buildChapterPlan({
    idea, platform, niche, totalMinutes, brief, voiceContext,
  });
  onEvent({ type: "chapter_plan", plan: chapterPlan });

  // Pass 2: Opening Unit (title + thumbnail + first 90s)
  onEvent({ type: "research_update", message: "Writing opening 90 seconds…" });
  const openingUnit = await generateOpeningUnit({
    idea, niche, brief, chapterPlan, voiceContext, archetype,
  });
  onEvent({ type: "opening_unit", unit: openingUnit });

  // Pass 3: Chapter generation (sequential, with narrative state)
  const narrativeState: NarrativeState = {
    openLoops: [...chapterPlan.openingLoops],
    establishedFacts: [],
    lastChapterSummary: "",
  };

  const generatedChapters: ChapterResult[] = [];
  const totalChapters = chapterPlan.chapters.length;

  for (let i = 0; i < totalChapters; i++) {
    const chapter = chapterPlan.chapters[i];
    onEvent({
      type: "research_update",
      message: `Writing chapter ${i + 1}/${totalChapters}: ${chapter.label}…`,
    });

    try {
      const result = await generateChapter({
        chapter, chapterIndex: i, totalChapters, idea, niche, archetype,
        brief, narrativeState, voiceContext, chapterPlan,
      });

      // Update narrative state
      narrativeState.lastChapterSummary =
        `[${chapter.label}]: ${result.script.slice(0, 400)}…`;

      // Close loops that were resolved
      for (const loopId of result.loopsClosed) {
        const loop = narrativeState.openLoops.find((l) => l.id === loopId);
        if (loop) loop.closedAt = chapter.label;
      }

      generatedChapters.push(result);
      onEvent({ type: "chapter", chapter: result, index: i, total: totalChapters });
    } catch (err: any) {
      logger.warn({ err: err.message, chapter: chapter.label }, "[YouTube] Chapter failed — placeholder");
      const fallback: ChapterResult = {
        id: chapter.id, label: chapter.label, script: "",
        productionNotes: [], tip: chapter.tip, loopsClosed: [],
      };
      generatedChapters.push(fallback);
      onEvent({ type: "chapter", chapter: fallback, index: i, total: totalChapters });
    }
  }

  // Pass 4: Generate caption + hashtags for description
  const captionResult = await routerCall({
    tier: "standard",
    system: "You are ARIA. Return ONLY valid JSON.",
    user: `Generate a YouTube video description and hashtags.
Title: "${openingUnit.title}"
Topic: "${idea}" | Niche: ${niche}
Key chapters: ${chapterPlan.chapters.slice(1, -1).map((c) => c.label).join(", ")}
Return: {"caption": "full description with timestamps placeholder and CTA", "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5"]}`,
    maxTokens: 600,
    temperature: 0.6,
    jsonMode: true,
  });

  const captionMeta = parseRouterJSON<any>(captionResult);

  const result: YouTubeScriptResult = {
    chapterPlan,
    openingUnit,
    chapters: generatedChapters,
    caption: captionMeta.caption || "",
    hashtags: captionMeta.hashtags || [],
    totalDuration: input.totalMinutes >= 60
      ? `${(input.totalMinutes / 60).toFixed(1)} hours`
      : `${Math.round(input.totalMinutes)} minutes`,
    researchBrief: brief,
  };

  onEvent({ type: "done", result: result as any });
  return result;
}