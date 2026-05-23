// src/services/deepAnalysis.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Two-Pass Studio Pipeline
//
// PASS 1 — LangChain createDeepAgent (deepagents npm package)
//   A researcher subagent autonomously plans and runs multi-step web searches.
//   The deep agent uses its built-in write_todos → task delegation loop.
//   We stream intermediate events back to the UI as progress updates.
//
// PASS 2 — Script Generator (direct OpenAI call)
//   Receives ResearchBrief, generates format-specific script, streams sections.
// ══════════════════════════════════════════════════════════════════════════════

import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";
import { z } from "zod";
import OpenAI from "openai";
import { logger } from "../utils/logger";
import { routerCall, parseRouterJSON } from "./model_router.service";
import { generateHookVariants, HookEngineResult } from "./hook_engine.service";
import { getPlatformContract } from "./platform_contracts.service";
import { makeStructuralDecision, StructuralDecision } from "./narrative_decision.service";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResearchBrief {
  trendStrength: "rising" | "peaking" | "declining" | "evergreen";
  trendSummary: string;
  whyItWorks: string;
  topViralAngles: string[];
  audienceInsights: string;
  hookPatterns: string[];
  competitorGaps: string;
  contentRecommendation: string;
  bestTiming: string;
  rawSources: string;
}

export interface ScriptSection {
  id: string;
  label: string;
  type: "hook" | "body" | "cta" | "transition" | "detail";
  content: string;
  tip: string;
  placeholder: string;
  durationEstimate?: string;
  algoSignal?: string;                    // primary signal this section serves
  shareableMoment?: string | null;        // line engineered for DM share
  satisfactionSignal?: string | null;     // what earns viewer satisfaction here
}

export interface ScriptResult {
  sections: ScriptSection[];
  hookLine: string;
  hookTip: string;
  caption: string;
  hashtags: string[];
  totalDuration: string;
  researchBrief: ResearchBrief;
  trendInsight: string;
  format: string;
}

export interface AttachedNote {
  id: string;
  title?: string;
  content?: string;
  tags?: string[];
}

export interface StudioInput {
  idea: string;
  platform: string;
  niche: string;
  format: string;
  mood?: string;
  angle?: string;
  archetype: string;
  followerRange?: string;
  voiceContext?: string;
  learnedPrefs?: string;
  creatorName?: string;
  userQuery?: string;
  duration?: string;    // e.g. "5 minutes", "30 min", "1 hour", "45s"
  attachedNotes?: AttachedNote[];
  selectedHookArchetype?: string;  // e.g. "PAIN_AMPLIFIER", "CURIOSITY_GAP"
}

export type SSEEvent =
  | {
      type: "phase";
      phase: "researching" | "scripting" | "done";
      label: string;
    }
  | { type: "research_update"; message: string }
  | { type: "research_done"; brief: ResearchBrief }
  | { type: "section"; section: ScriptSection; index: number; total: number }
  | {
      type: "meta";
      caption: string;
      hashtags: string[];
      hookLine: string;
      hookTip: string;
      totalDuration: string;
      trendInsight: string;
    }
  | {
      type: "hook_variants";
      variants: import("./hook_engine.service").HookVariant[];
      recommendedArchetype: import("./hook_engine.service").HookArchetype;
      recommendationReason: string;
    }
  | { type: "hook_selected"; archetype: import("./hook_engine.service").HookArchetype }
  | { type: "done"; result: ScriptResult }
  | { type: "error"; message: string }
  | { type: "shoot_plan"; plan: import("./studioV2.types").ShootPlan }
  | { type: "signal_map"; map: import("./studioV2.types").SignalMap }
  | { type: "director_archetype"; archetype: import("./studioV2.types").DirectorArchetype; label: string };

// ── Format configs ────────────────────────────────────────────────────────────

const FORMAT_CONFIGS: Record<
  string,
  {
    sections: Array<{
      label: string;
      type: ScriptSection["type"];
      placeholder: string;
      tip: string;
    }>;
    durationRange: string;
    scriptInstructions: string;
  }
> = {
  reel: {
    durationRange: "15–60s",
    sections: [
      {
        label: "Visual Hook",
        type: "hook" as const,
        placeholder: "First 1.5s — MUTE VIEWER STOP-SCROLL. No words needed. What do they SEE?",
        tip: "50% watch on mute. Text overlay mandatory. Your face, low angle, filling the frame. This is the audition — non-followers decide your fate here.",
      },
      {
        label: "Spoken Hook",
        type: "hook" as const,
        placeholder: "1.5s–3s — The line that confirms they should keep watching",
        tip: "Contrarian claim OR curiosity gap OR identity hook. Max 12 words. No 'Hey guys'. Open mid-sentence.",
      },
      {
        label: "Tension Build",
        type: "body" as const,
        placeholder: "3s–8s — Make them feel the problem or curiosity. Don't solve yet.",
        tip: "Pattern interrupt here — change angle or cut to B-roll. The 8s mark is where 60% of drop-offs happen. Hit them with a visual change.",
      },
      {
        label: "Value Core",
        type: "body" as const,
        placeholder: "8s–20s — Deliver the actual value. Punchy. One idea.",
        tip: "This is what they came for. Short sentences. Real specifics. No filler. Indian examples > generic ones.",
      },
      {
        label: "Share Trigger",
        type: "body" as const,
        placeholder: "20s–26s — The mic-drop line. Engineered for someone to DM this to a friend.",
        tip: "This is the most important line in the reel. DM shares are 3-5x more powerful than likes for reach. Ask: would someone forward THIS specific line? Make it a stat, a truth, or a contrarian statement.",
      },
      {
        label: "CTA",
        type: "cta" as const,
        placeholder: "26s–30s — ONE action. Match the CTA to the growth stage.",
        tip: "Pick ONE: 'Save this for when you need it' (saves) OR 'Send this to [specific person]' (DM shares) OR 'Comment [word] if this hit' (comments). Never ask for all three.",
      },
    ],
    scriptInstructions:
      "Instagram Reel. 6-beat structure. Algorithm 2026: watch past 3s → DM shares → completion rate. Hook lands in 1.5s visually and 3s verbally. Share trigger at 20-26s must earn a DM forward. Final beat loops back visually to opening. Hinglish natural where it fits. Every word earns its place. Max 30s target.",
  },
  post: {
    durationRange: "read time 30–90s",
    sections: [
      {
        label: "Hook Line",
        type: "hook",
        placeholder: "Caption opener that stops the scroll",
        tip: "Instagram cuts at ~125 chars. Make the first line irresistible.",
      },
      {
        label: "Body",
        type: "body",
        placeholder: "Story, insight, or value — 3–5 short paragraphs",
        tip: "Line breaks after every 1–2 sentences.",
      },
      {
        label: "CTA",
        type: "cta",
        placeholder: "Drive a specific action",
        tip: "Ask a question to boost comments.",
      },
    ],
    scriptInstructions:
      "Instagram/social caption. Hinglish if it fits. Strong opener, punchy closer.",
  },
  carousel: {
    durationRange: "5–10 slides",
    sections: [
      {
        label: "Slide 1: Hook",
        type: "hook",
        placeholder: "Cover slide headline — make them swipe",
        tip: "Bold claim or surprising stat.",
      },
      {
        label: "Slides 2–3: Problem",
        type: "body",
        placeholder: "Validate their pain or desire",
        tip: "Name the feeling before the fix.",
      },
      {
        label: "Slides 4–7: Value",
        type: "body",
        placeholder: "Core tips/steps — one per slide",
        tip: "One point per slide. Use numbers.",
      },
      {
        label: "Slide 8–9: Proof",
        type: "detail",
        placeholder: "Social proof or transformation",
        tip: "Before/after, a result, a quote.",
      },
      {
        label: "Final Slide: CTA",
        type: "cta",
        placeholder: "Save this + follow for more",
        tip: "Always ask for the save explicitly.",
      },
    ],
    scriptInstructions:
      "Instagram carousel. Each slide = one idea. 15 words max per slide headline. Include visual guidance.",
  },
  video: {
    durationRange: "5–15 min",
    sections: [
      {
        label: "Hook (0–30s)",
        type: "hook",
        placeholder: "Open with the payoff or shocking statement",
        tip: "Show the end result first.",
      },
      {
        label: "Intro Context (30–90s)",
        type: "body",
        placeholder: "Why this matters",
        tip: "Keep short. Viewers don't care about your credentials yet.",
      },
      {
        label: "Main Content",
        type: "body",
        placeholder: "Core teaching — chapters/steps",
        tip: "3–5 clear sections. Announce each one.",
      },
      {
        label: "Deep Dive",
        type: "detail",
        placeholder: "Nuance, examples, or case study",
        tip: "This makes people subscribe.",
      },
      {
        label: "Outro CTA",
        type: "cta",
        placeholder: "Subscribe, watch next, or comment",
        tip: "Tell them exactly what to do.",
      },
    ],
    scriptInstructions:
      "YouTube long-form script. Include timestamp markers. Conversational, direct style.",
  },
  story: {
    durationRange: "3–7 frames",
    sections: [
      {
        label: "Frame 1: Hook",
        type: "hook",
        placeholder: "Tap-stopping first frame",
        tip: "Question or something unexpected.",
      },
      {
        label: "Frames 2–4: Content",
        type: "body",
        placeholder: "Quick value — poll, quiz, or insight",
        tip: "Interactive elements boost reach.",
      },
      {
        label: "Last Frame: CTA",
        type: "cta",
        placeholder: "Swipe up, DM, or link tap",
        tip: "Make the CTA time-sensitive.",
      },
    ],
    scriptInstructions:
      "Instagram/WhatsApp Stories. Very short text per frame. Think conversation, not broadcast.",
  },
  thread: {
    durationRange: "5–10 tweets",
    sections: [
      {
        label: "Tweet 1: Hook",
        type: "hook",
        placeholder: "The one tweet that makes them want more",
        tip: "End with a cliffhanger. Never summarize.",
      },
      {
        label: "Tweets 2–3: Setup",
        type: "body",
        placeholder: "Context and core insight",
        tip: "Last sentence of each must pull them forward.",
      },
      {
        label: "Tweets 4–7: Value",
        type: "body",
        placeholder: "Main points — one per tweet",
        tip: "Number them. '3/' readers know they're in a story.",
      },
      {
        label: "Final Tweet: CTA",
        type: "cta",
        placeholder: "Retweet + follow ask",
        tip: "Specific asks outperform generic ones.",
      },
    ],
    scriptInstructions:
      "Twitter/X thread. 280 chars per tweet. Number each (1/, 2/). Punchy and direct.",
  },
};

// ── PASS 1: LangChain Deep Agent ──────────────────────────────────────────────
// ── REPLACE the entire runDeepResearch function in src/services/deep_analysis.service.ts
// ── Everything else (types, FORMAT_CONFIGS, generateScript, runTwoPassStudio) stays identical

export async function runDeepResearch(
  input: StudioInput,
  onEvent: (event: SSEEvent) => void,
): Promise<ResearchBrief> {
  const { idea, platform, niche, format, angle, userQuery } = input;

  onEvent({ type: "phase", phase: "researching", label: "Deep Research" });
  onEvent({ type: "research_update", message: "Initializing research agent…" });

  logger.info(
    { idea, platform, niche, format },
    "[DeepResearch] Starting Pass 1",
  );

  // ── Web search tool as a proper LangChain StructuredTool ─────────────────
  // openAITools.webSearch() returns a ServerTool which is NOT compatible with
  // deepagents subagent tools[]. We wrap OpenAI's Responses API directly instead.
  const webSearchTool = tool(
    async ({ query }: { query: string }): Promise<string> => {
      logger.info({ query }, "[DeepResearch] web_search called");
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) return JSON.stringify({ error: "OPENAI_API_KEY not set" });

      try {
        const res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            tools: [{ type: "web_search_preview" }],
            input: query,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok) {
          logger.warn(
            { status: res.status, query },
            "[DeepResearch] OpenAI Responses API error",
          );
          return JSON.stringify({ error: `Search API error ${res.status}` });
        }

        const data = await res.json();
        // Extract text output from the response
        const text = (data.output ?? [])
          .filter((item: any) => item.type === "message")
          .flatMap((item: any) => item.content ?? [])
          .filter((c: any) => c.type === "output_text")
          .map((c: any) => c.text as string)
          .join("\n");

        logger.info(
          { query, resultLength: text.length },
          "[DeepResearch] web_search success",
        );
        return text || JSON.stringify({ error: "No results returned" });
      } catch (err: any) {
        logger.warn(
          { err: err.message, query },
          "[DeepResearch] web_search failed",
        );
        return JSON.stringify({ error: err.message });
      }
    },
    {
      name: "web_search",
      description:
        "Search the web for current information about a topic. Use this for trend research, audience insights, and viral content patterns.",
      schema: z.object({
        query: z
          .string()
          .describe(
            "The search query — be specific, include 'India 2025' for Indian market data",
          ),
      }),
    },
  );

  // ── Researcher subagent ───────────────────────────────────────────────────
  const researcherSubagent = {
    name: "researcher",
    description:
      "Runs web searches and returns a JSON research brief. Delegate all research here.",
    systemPrompt: `You are a content intelligence researcher for TrendAI (Indian creator platform).
 
YOUR TASK: Research the given topic. You have a MAXIMUM of 6 tool calls total.
 
STRICT SEQUENCE — follow in order, no deviations:
Step 1: web_search → "${idea} trending ${platform} India 2025"
Step 2: web_search → "${niche} viral content ${platform} India 2025"
Step 3: web_search → "${idea} Indian audience pain points ${niche}"
Step 4: web_search → "best hooks ${niche} creators ${platform} India"
Step 5: web_search → "${idea} viral reels creators India ${niche}"
Step 6: STOP all tool calls. Write the JSON brief immediately.
 
CRITICAL RULES:
- Do NOT run more than 5 web_search calls
- Do NOT call any tool more than once
- After Step 5, output the JSON immediately — no more tool calls
 
Return ONLY this JSON — no markdown, no explanation, start with { end with }:
{
  "trendStrength": "rising|peaking|declining|evergreen",
  "trendSummary": "2-3 sentences on what is trending with specific evidence from your searches",
  "whyItWorks": "The psychological/cultural reason this resonates with Indian audiences",
  "topViralAngles": ["angle 1 with evidence", "angle 2", "angle 3", "angle 4", "angle 5"],
  "audienceInsights": "Specific demographics, pain points, desires for this topic in India",
  "hookPatterns": ["hook formula + example from search", "formula 2", "formula 3", "formula 4"],
  "competitorGaps": "What top creators are NOT doing — the opportunity",
  "contentRecommendation": "Specific format, length, style recommendation from research",
  "bestTiming": "Best day/time for Indian audiences on ${platform} with reasoning",
  "rawSources": "Key sources and data points found in your searches"
}`,
    model: new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.2 }).bindTools(
      [webSearchTool],
    ),
    tools: [webSearchTool],
  };

  // ── Main deep agent — with recursion_limit ────────────────────────────────
  const researchAgent = createDeepAgent({
    model: new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.1 }),
    subagents: [researcherSubagent],
    systemPrompt: `You are TrendAI's research orchestrator.
Use the task tool ONCE to delegate to the researcher subagent.
Return the researcher's JSON output verbatim — no extra text.`,
  });

  // ── Seasonal context injection ────────────────────────────────────
  const today = new Date();
  const month = today.getMonth() + 1; // 1-indexed
  const day = today.getDate();

  const INDIAN_CALENDAR: Array<{ name: string; month: number; dayStart: number; dayEnd: number }> = [
    { name: "IPL Season",        month: 3,  dayStart: 20, dayEnd: 31 },
    { name: "IPL Season",        month: 4,  dayStart: 1,  dayEnd: 30 },
    { name: "IPL Season",        month: 5,  dayStart: 1,  dayEnd: 26 },
    { name: "Exam Season",       month: 3,  dayStart: 1,  dayEnd: 31 },
    { name: "Exam Season",       month: 4,  dayStart: 1,  dayEnd: 30 },
    { name: "Diwali Season",     month: 10, dayStart: 15, dayEnd: 31 },
    { name: "Diwali Season",     month: 11, dayStart: 1,  dayEnd: 10 },
    { name: "Navratri Season",   month: 10, dayStart: 1,  dayEnd: 15 },
    { name: "New Year Content",  month: 12, dayStart: 25, dayEnd: 31 },
    { name: "New Year Content",  month: 1,  dayStart: 1,  dayEnd: 10 },
    { name: "Holi Season",       month: 3,  dayStart: 1,  dayEnd: 25 },
    { name: "Eid Season",        month: 3,  dayStart: 20, dayEnd: 31 }, // varies
    { name: "Budget Season",     month: 2,  dayStart: 1,  dayEnd: 5  },
    { name: "Independence Day",  month: 8,  dayStart: 10, dayEnd: 15 },
    { name: "Wedding Season",    month: 11, dayStart: 15, dayEnd: 30 },
    { name: "Wedding Season",    month: 12, dayStart: 1,  dayEnd: 20 },
  ];

  const activeSeasonalEvents = INDIAN_CALENDAR.filter(
    (e) => e.month === month && day >= e.dayStart && day <= e.dayEnd,
  ).map((e) => e.name);

  const seasonalCtx = activeSeasonalEvents.length > 0
    ? `\nACTIVE SEASONAL CONTEXT: ${activeSeasonalEvents.join(", ")}. Prioritise content angles that ride this cultural moment for Indian audiences.`
    : "";

  const researchTask = `Research this for TrendAI:
TOPIC: "${idea}"
PLATFORM: ${platform}
NICHE: ${niche}${seasonalCtx}
FORMAT NEEDED: ${format}
${angle ? `DESIRED ANGLE: ${angle}` : ""}
${userQuery ? `CREATOR'S EXACT REQUEST: "${userQuery}"` : ""}

Delegate to the researcher subagent with these exact instructions:
- Research "${idea}" trending on ${platform} in India
- Find viral angles in the ${niche} niche
- Identify Indian audience insights for this topic
- Scrape ${platform} for real engagement data on "${idea}"
${userQuery ? `- Pay special attention to the creator's specific ask: "${userQuery}"` : ""}
- Return the complete JSON research brief`;

  const TIMEOUT_MS = 90_000;
  let iterationCount = 0;

  try {
    onEvent({
      type: "research_update",
      message: "Agent planning research strategy…",
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Research timed out after 90s")),
        TIMEOUT_MS,
      ),
    );

    const researchPromise = (async (): Promise<string> => {
      // .with_config sets the LangGraph recursion limit to prevent infinite loops
      const agentStream = await (researchAgent as any)
        .withConfig({ recursionLimit: 25 })
        .stream(
          { messages: [{ role: "user", content: researchTask }] },
          { streamMode: "messages" },
        );

      let finalContent = "";
      let lastEmitted = "";
      let searchCount = 0;

      const emit = (msg: string) => {
        if (msg !== lastEmitted) {
          lastEmitted = msg;
          logger.info({ msg }, "[DeepResearch] SSE emit");
          onEvent({ type: "research_update", message: msg });
        }
      };

      for await (const chunk of agentStream) {
        iterationCount++;

        if (iterationCount > 80) {
          logger.warn(
            { iterationCount },
            "[DeepResearch] Iteration cap hit — breaking",
          );
          emit("Finalizing research…");
          break;
        }

        // LangGraph "messages" mode: chunk = [BaseMessage, metadata]
        const [message] = Array.isArray(chunk) ? chunk : [chunk];
        if (!message) continue;

        const msgType: string =
          message._getType?.() ?? (message as any).type ?? "";

        const content: string =
          typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? (message.content as any[])
                  .map((c: any) =>
                    typeof c === "string" ? c : (c?.text ?? ""),
                  )
                  .join("")
              : "";

        // Cast to any to access tool_calls — TS doesn't know which BaseMessage subtype this is
        const toolCalls: any[] = (message as any).tool_calls ?? [];
        const toolName: string = (message as any).name ?? "";

        logger.info(
          {
            msgType,
            toolName,
            toolCallCount: toolCalls.length,
            iterationCount,
            snippet: content.slice(0, 80),
          },
          "[DeepResearch] chunk",
        );

        // AI deciding what to do next
        if (msgType === "ai" && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            logger.info(
              { name: tc.name, args: tc.args },
              "[DeepResearch] tool call",
            );

            if (tc.name === "write_todos") {
              emit("Planning research strategy…");
            } else if (tc.name === "task") {
              emit("Delegating to researcher subagent…");
            } else if (tc.name === "web_search") {
              searchCount++;
              const q: string = tc.args?.query ?? "";
              emit(`Search ${searchCount}: "${q.slice(0, 55)}"`);
            }
          }
        }

        // Tool result returned
        if (msgType === "tool") {
          logger.info(
            { toolName, snippet: content.slice(0, 120) },
            "[DeepResearch] tool result",
          );

          if (toolName === "web_search") {
            emit(`Search ${searchCount} complete…`);
          } else if (toolName === "task") {
            emit("Subagent complete — extracting brief…");
          }
        }

        // AI final text (no tool calls = done)
        if (msgType === "ai" && content && toolCalls.length === 0) {
          finalContent = content;
          logger.info(
            { len: content.length, snippet: content.slice(0, 100) },
            "[DeepResearch] final content",
          );
          if (
            content.includes("trendStrength") ||
            content.trimStart().startsWith("{")
          ) {
            emit("Synthesizing research brief…");
          }
        }
      }

      logger.info(
        { iterationCount, finalLen: finalContent.length },
        "[DeepResearch] stream complete",
      );
      return finalContent;
    })();

    const finalContent = await Promise.race([researchPromise, timeoutPromise]);

    const jsonMatch = finalContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(
        { snippet: finalContent.slice(0, 200) },
        "[DeepResearch] No JSON in output",
      );
      throw new Error("No JSON in research output");
    }

    const brief: ResearchBrief = JSON.parse(jsonMatch[0]);
    logger.info(
      { trendStrength: brief.trendStrength },
      "[DeepResearch] Brief parsed OK",
    );
    onEvent({ type: "research_done", brief });
    return brief;
  } catch (err: any) {
    logger.warn(
      { err: err.message, iterationCount },
      "[DeepResearch] Failed — fallback",
    );
    onEvent({
      type: "research_update",
      message: "Using cached research patterns…",
    });

    const fallback: ResearchBrief = {
      trendStrength: "evergreen",
      trendSummary: `"${idea}" is an established topic in the ${niche} space on ${platform}. Indian creators are actively covering this with educational and relatable formats.`,
      whyItWorks:
        "Audiences engage with content that validates their experience and gives an actionable next step.",
      topViralAngles: [
        "Personal story + lesson: share what you learned the hard way",
        "Common mistake + correct approach: call out what most people do wrong",
        "Beginner guide: break it down for someone starting from zero",
        "Behind the scenes: show your actual process, not the polished version",
        "Myth busting: challenge a popular belief in your niche",
      ],
      audienceInsights: `Indian ${niche} audience on ${platform} — ages 18-35, value practical actionable content, respond to Hinglish tone, high engagement on relatable real-life scenarios.`,
      hookPatterns: [
        "I tried X for 30 days — here's what nobody tells you",
        "Stop doing X. Do this instead (here's why)",
        "The real reason X doesn't work for most people",
        "I wish I knew this when I started with X",
      ],
      competitorGaps:
        "Most creators share the what but skip the how. Show your actual process with real numbers or results.",
      contentRecommendation: `A ${format} under 60 seconds with a strong hook, one clear idea, and a direct CTA performs best for this topic.`,
      bestTiming: "Tuesday–Thursday 7–9 PM IST, Sunday 10 AM–12 PM IST.",
      rawSources: "Fallback patterns — research agent encountered an error.",
    };

    onEvent({ type: "research_done", brief: fallback });
    return fallback;
  }
}
// ── PASS 2: Script Generator ──────────────────────────────────────────────────

const oai = () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY required");
  return new OpenAI({ apiKey, timeout: 60_000 });
};

// ── Duration helpers ──────────────────────────────────────────────────────────
// Inserted just before generateScript. Nothing else changes.

const WORDS_PER_MINUTE = 150; // average spoken delivery rate

function parseDurationToMinutes(duration?: string, format?: string): number {
  if (duration) {
    const lower = duration.toLowerCase().trim();
    let total = 0;
    const hr  = lower.match(/(\d+(?:\.\d+)?)\s*h(?:our|r)?/);
    const min = lower.match(/(\d+(?:\.\d+)?)\s*m(?:in)?/);
    const sec = lower.match(/(\d+(?:\.\d+)?)\s*s(?:ec)?/);
    if (hr)  total += parseFloat(hr[1])  * 60;
    if (min) total += parseFloat(min[1]);
    if (sec) total += parseFloat(sec[1]) / 60;
    if (total > 0) return total;
  }
  // Format-based defaults when no explicit duration given
  const defaults: Record<string, number> = {
    reel: 0.5, post: 1, carousel: 2,
    video: 8,  story: 0.5, thread: 3,
  };
  return defaults[format ?? "reel"] ?? 1;
}

function formatDurationLabel(mins: number): string {
  if (mins >= 60)  return `${(mins / 60).toFixed(1).replace(/\.0$/, "")} hour${mins >= 120 ? "s" : ""}`;
  if (mins >= 1)   return `${Math.round(mins)} minute${Math.round(mins) !== 1 ? "s" : ""}`;
  return `${Math.round(mins * 60)} seconds`;
}

interface SectionBlueprint {
  id: string;
  label: string;
  type: ScriptSection["type"];
  placeholder: string;
  tip: string;
  targetWords: number;
  startMin: number;
  endMin: number;
}

/**
 * Builds a section blueprint scaled to any duration.
 * Short-form (≤3 min): uses FORMAT_CONFIGS sections directly.
 * Long-form (>3 min): AI decides chapter structure via a planning call.
 */
async function buildSectionBlueprints(
  input: StudioInput,
  brief: ResearchBrief,
  totalMinutes: number,
): Promise<SectionBlueprint[]> {
  const { idea, platform, niche, format } = input;
  const totalWords = Math.round(totalMinutes * WORDS_PER_MINUTE);

  // ── Short-form: just use FORMAT_CONFIGS as-is ─────────────────────────────
  if (totalMinutes <= 3) {
    const config = FORMAT_CONFIGS[format] || FORMAT_CONFIGS.reel;
    const perSection = Math.round(totalWords / config.sections.length);
    let cursor = 0;
    const result = config.sections.map((s, i) => {
      const words = (s.type === "hook" || s.type === "cta")
        ? Math.round(perSection * 0.5)
        : perSection;
      const durMins = words / WORDS_PER_MINUTE;
      const bp: SectionBlueprint = {
        id: `s${i}`,
        label: s.label,
        type: s.type,
        placeholder: s.placeholder,
        tip: s.tip,
        targetWords: words,
        startMin: parseFloat(cursor.toFixed(2)),
        endMin: parseFloat((cursor + durMins).toFixed(2)),
      };
      cursor = bp.endMin;
      return bp;
    });

    // ADD re-hook injection for content > 45 seconds
    if (totalMinutes > 0.75) { // > 45 seconds — inject re-hook slots
      const contract = getPlatformContract(platform, format);
      const rehookEveryMins = contract.rehookIntervalSeconds / 60;
      const totalDuration = cursor;

      // Find where to inject re-hooks (avoid first and last section)
      const rehookPositions: number[] = [];
      for (let t = rehookEveryMins; t < totalDuration - 0.3; t += rehookEveryMins) {
        rehookPositions.push(t);
      }

      // Insert re-hook blueprint items at the right positions
      const finalBlueprints: SectionBlueprint[] = [];
      let bpCursor = 0;

      for (const bp of result) { // 'result' = the sections array built above
        finalBlueprints.push(bp);
        bpCursor = bp.endMin;

        // Check if a re-hook should be injected after this section
        const nextRehook = rehookPositions.find(
          (pos) => pos > bp.startMin && pos <= bp.endMin + 0.1
        );

        if (nextRehook && bp.type !== "cta" && bp.type !== "hook") {
          const rehookWords = Math.round(0.15 * WORDS_PER_MINUTE); // ~9 words
          finalBlueprints.push({
            id: `rehook_${Math.round(nextRehook * 60)}`,
            label: `Re-hook at ${Math.round(nextRehook * 60)}s`,
            type: "transition",
            placeholder: "Pattern interrupt — open a new micro-loop",
            tip: "Use a question, a surprising stat, or 'But wait — there's one more thing...'",
            targetWords: rehookWords,
            startMin: parseFloat(bpCursor.toFixed(2)),
            endMin: parseFloat((bpCursor + rehookWords / WORDS_PER_MINUTE).toFixed(2)),
          });
          bpCursor = finalBlueprints[finalBlueprints.length - 1].endMin;
        }
      }

      return finalBlueprints;
    }

    return result;
  }

  // ── Long-form: AI plans the chapter structure ─────────────────────────────
  const durationLabel = formatDurationLabel(totalMinutes);

  const planPrompt = `You are a YouTube script architect for Indian creators.

VIDEO BRIEF:
- Topic: "${idea}"
- Platform: ${platform} | Niche: ${niche}
- Total duration: ${durationLabel} (~${totalWords} words at 150 words/min)
- Trend context: ${brief.trendSummary}
- Audience: ${brief.audienceInsights}

Design the optimal chapter structure for this video.
Rules:
1. Hook must be short (≤60s). Outro/CTA must be short (≤60s).
2. Intro context max 2 min.
3. Content chapters fill the rest. Each chapter covers ONE focused idea.
4. Chapter count should feel natural for the topic — not forced.
5. Each chapter label must be specific and descriptive (not just "Chapter 1").
6. Allocate more time to the most valuable chapters.

Return ONLY valid JSON:
{
  "sections": [
    {
      "label": "Hook",
      "type": "hook",
      "durationMinutes": 0.5,
      "tip": "delivery tip for this section"
    },
    {
      "label": "Why Most People Get This Wrong",
      "type": "body",
      "durationMinutes": 2.0,
      "tip": "delivery tip"
    }
    // ... more sections
  ]
}

Types allowed: "hook" | "body" | "detail" | "cta" | "transition"
Total durationMinutes across all sections MUST sum to exactly ${totalMinutes.toFixed(1)}.`;

  let planSections: Array<{
    label: string;
    type: ScriptSection["type"];
    durationMinutes: number;
    tip: string;
  }> = [];

  try {
    const planRes = await oai().chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1200,
      temperature: 0.4,
      messages: [
        { role: "system", content: "You are a script architect. Return ONLY valid JSON, no markdown." },
        { role: "user", content: planPrompt },
      ],
    });

    const raw = (planRes.choices[0].message.content ?? "")
      .replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(raw);
    planSections = parsed.sections || [];
  } catch (err: any) {
    logger.warn({ err: err.message }, "[Studio] Section planner failed — using fallback structure");
    // Fallback: sensible default long-form structure
    const hookMins  = Math.min(1, totalMinutes * 0.04);
    const introMins = Math.min(2, totalMinutes * 0.08);
    const recapMins = Math.min(2, totalMinutes * 0.05);
    const ctaMins   = Math.min(1, totalMinutes * 0.04);
    const bodyMins  = totalMinutes - hookMins - introMins - recapMins - ctaMins;
    const numChaps  = Math.max(2, Math.round(bodyMins / 5));
    const chapMins  = bodyMins / numChaps;

    planSections = [
      { label: "Hook", type: "hook", durationMinutes: hookMins, tip: "Open mid-action. No intros." },
      { label: "Intro & Why This Matters", type: "body", durationMinutes: introMins, tip: "Short. Promise value immediately." },
      ...Array.from({ length: numChaps }, (_, i) => ({
        label: `Chapter ${i + 1}`,
        type: (i === Math.floor(numChaps / 2) ? "detail" : "body") as ScriptSection["type"],
        durationMinutes: chapMins,
        tip: "One idea per chapter. Real examples over theory.",
      })),
      { label: "Key Takeaways", type: "body", durationMinutes: recapMins, tip: "Name each takeaway explicitly." },
      { label: "Outro & CTA", type: "cta", durationMinutes: ctaMins, tip: "One specific ask. Warm, not salesy." },
    ];
  }

  // Convert plan → blueprints with cumulative timestamps
  let cursor = 0;
  return planSections.map((s, i) => {
    const words = Math.round(s.durationMinutes * WORDS_PER_MINUTE);
    const bp: SectionBlueprint = {
      id: `s${i}`,
      label: s.label,
      type: s.type,
      placeholder: `Spoken content for: ${s.label}`,
      tip: s.tip,
      targetWords: words,
      startMin: parseFloat(cursor.toFixed(2)),
      endMin: parseFloat((cursor + s.durationMinutes).toFixed(2)),
    };
    cursor = bp.endMin;
    return bp;
  });
}

export async function generateScript(
  input: StudioInput,
  brief: ResearchBrief,
  onEvent: (event: SSEEvent) => void,
): Promise<ScriptResult> {
  const {
    idea, platform, niche, format, mood, angle,
    archetype, voiceContext, learnedPrefs, duration, userQuery,
  } = input;

  onEvent({ type: "phase", phase: "scripting", label: "Generating Script" });

  // ── Step 0 (NEW): Generate hook variants ─────────────────────────────────
  onEvent({ type: "research_update", message: "Generating hook variants…" });

  const contract = getPlatformContract(platform, format);

  let hookEngineResult: HookEngineResult | null = null;
  try {
    hookEngineResult = await generateHookVariants({
      idea,
      platform,
      niche,
      format,
      brief,
      preferredHookStyle: input.voiceContext
        ? (/preferredHookStyle[:\s]+([^\n,]+)/i.exec(input.voiceContext)?.[1]?.trim())
        : undefined,
      voiceContext,
      archetype,
    });

    onEvent({
      type: "hook_variants",
      variants: hookEngineResult.variants,
      recommendedArchetype: hookEngineResult.recommendedArchetype,
      recommendationReason: hookEngineResult.recommendationReason,
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, "[Studio] Hook engine failed — continuing without variants");
  }

  // ── Step 0.5 (NEW): Structural decision ──────────────────────────────────
  onEvent({ type: "research_update", message: "Selecting optimal narrative structure…" });

  // Resolve duration first (needed for structural decision)
  const totalMinutes   = parseDurationToMinutes(duration, format);
  const durationLabel  = formatDurationLabel(totalMinutes);
  const totalWords     = Math.round(totalMinutes * WORDS_PER_MINUTE);
  const isShortForm    = totalMinutes <= 3;

  let structuralDecision: StructuralDecision | null = null;
  try {
    structuralDecision = await makeStructuralDecision({
      idea, platform, niche, format, brief, totalMinutes,
    });
    onEvent({
      type: "research_update",
      message: `Framework: ${structuralDecision.frameworkLabel} — ${structuralDecision.whyThisFramework}`,
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, "[Studio] Structural decision failed — continuing");
  }

  // Shared context injected into every section call
  const sharedCtx = `
VIDEO CONTEXT:
- Idea: "${idea}" | Platform: ${platform} | Niche: ${niche}
- Total duration: ${durationLabel} (~${totalWords} words) | Format: ${format}
- Mood: ${mood || "authentic"} | Angle: ${angle || "best from research"}
- Archetype: ${archetype}
${userQuery ? `- Creator's exact request: "${userQuery}"` : ""}
${voiceContext ? `- Voice profile: ${voiceContext}` : ""}
${learnedPrefs ? `- Learned preferences: ${learnedPrefs}` : ""}

RESEARCH INSIGHTS:
- Trend: ${brief.trendStrength} — ${brief.trendSummary}
- Why it works: ${brief.whyItWorks}
- Top viral angles: ${brief.topViralAngles.join(" | ")}
- Audience: ${brief.audienceInsights}
- Proven hooks: ${brief.hookPatterns.join(" | ")}
- Competitor gap: ${brief.competitorGaps}
- Recommendation: ${brief.contentRecommendation}

PLATFORM CONTRACT (${platform.toUpperCase()}):
${contract.scriptInstructions}
- Hook window: ${contract.hookWindowSeconds}s
- Re-hook every: ${contract.rehookIntervalSeconds}s${structuralDecision ? `\n\nNARRATIVE FRAMEWORK: ${structuralDecision.frameworkLabel}\n${structuralDecision.narrativeInstructions}\nOPEN LOOPS TO MAINTAIN: ${structuralDecision.openLoops.join(" | ")}\nPROMISES TO DELIVER: ${structuralDecision.payoffPromises.join(" | ")}` : ""}`.trim();

  // ── Step 1: Build section blueprints ─────────────────────────────────────
  onEvent({ type: "research_update", message: "Planning script structure…" });
  const blueprints = await buildSectionBlueprints(input, brief, totalMinutes);
  const totalSections = blueprints.length;

  // ── Step 2: Meta call — hookLine, caption, hashtags (once, fast) ─────────
  const metaPrompt = `${sharedCtx}

Generate the meta elements for this script. Return ONLY valid JSON:
{
  "hookLine": "Single most powerful opening line, max 15 words",
  "hookTip": "Why this hook works and exactly how to deliver it",
  "caption": "Full ready-to-post caption with emojis, line breaks",
  "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8","#tag9","#tag10"],
  "trendInsight": "One punchy sentence on why this script is timely right now"
}`;

  let meta: any = {};
  try {
    const metaResult = await routerCall({
      tier: "standard",
      system: "You are ARIA — India's elite scriptwriter. Return ONLY valid JSON, no markdown fences.",
      user: metaPrompt,
      maxTokens: 700,
      temperature: 0.7,
      jsonMode: true,
    });
    meta = parseRouterJSON(metaResult);
  } catch {
    meta = { hookLine: "", hookTip: "", caption: "", hashtags: [], trendInsight: brief.trendSummary };
  }

  // ── Step 3: Generate each section independently ───────────────────────────
  const generatedSections: ScriptSection[] = [];
  let prevSummary = ""; // rolling context for coherence

  for (let i = 0; i < blueprints.length; i++) {
    const bp = blueprints[i];
    const isFirst = i === 0;
    const isLast  = i === blueprints.length - 1;

    const sectionPrompt = `${sharedCtx}

You are writing section ${i + 1} of ${totalSections} of a ${durationLabel} script.
${prevSummary ? `\nPREVIOUS SECTION SUMMARY:\n${prevSummary}\n` : ""}
CURRENT SECTION:
- Label: "${bp.label}"
- Type: ${bp.type}
- Timestamp: ${bp.startMin.toFixed(1)}–${bp.endMin.toFixed(1)} min
- Target words: ~${bp.targetWords} words of spoken dialogue
${isFirst ? "- This is the HOOK. Grab attention in the first 3 seconds. Use one of the proven hook patterns from research. NO 'Hey guys welcome back'." : ""}
${isLast ? "- This is the OUTRO. End with ONE specific CTA. Warm, not salesy." : ""}

ALGORITHM TARGET FOR THIS SECTION: ${
  bp.type === "hook" && bp.label.includes("Visual")
    ? "WATCH_PAST_3S signal — this section must pass the 3s audition. 50% of viewers are muted. Text overlay suggestion required."
    : bp.type === "hook"
    ? "WATCH_PAST_3S signal — verbal hook must confirm the visual promise in 1.5s."
    : bp.label.includes("Share Trigger")
    ? "DM_SHARE_TRIGGER signal — generate ONE mic-drop line. Ask yourself: would someone stop scrolling and DM this to a friend? If not, rewrite."
    : bp.type === "transition"
    ? "PATTERN_INTERRUPT signal — this is a re-hook. Change energy, angle, or topic abruptly."
    : bp.type === "cta"
    ? "FOLLOW_TRIGGER or COMMENT_BAIT or SAVE_TRIGGER — pick one signal, make the CTA serve it precisely."
    : "COMPLETION_BOOST signal — earn the next second of watch time with every sentence."
}

RULES:
1. Write FULL spoken dialogue — the creator reads this word for word
2. Hit the word target: ~${bp.targetWords} words
3. Natural conversational tone — match the creator's voice profile
4. No section labels, headers, or meta-commentary in the content field
5. Apply Indian creator context — Hinglish where natural, Indian examples, ₹ for prices
6. Hook MUST use one of the proven hook patterns from research (first section only)

Return ONLY valid JSON:
{
  "content": "Full spoken script for this section. Must be ~${bp.targetWords} words.",
  "tip": "${bp.tip}",
  "durationEstimate": "${bp.startMin.toFixed(1)}–${bp.endMin.toFixed(1)} min",
  "algoSignal": "primary algo signal this section serves (WATCH_PAST_3S|COMPLETION_BOOST|DM_SHARE_TRIGGER|SAVE_TRIGGER|REWATCH_LOOP|COMMENT_BAIT|FOLLOW_TRIGGER|PATTERN_INTERRUPT)",
  "shareableMoment": "For body sections: the single most shareable line — null if no clear shareable moment",
  "satisfactionSignal": "What in this section earns viewer satisfaction — null for transition/hook"
}`;

    // Token budget: 1.4 tokens/word + 200 overhead for JSON structure, capped at 4000
    const sectionTokens = Math.min(Math.round(bp.targetWords * 1.4) + 200, 4000);

    try {
      const sectionTier = (isFirst || isLast) ? "creative" : "standard";
      const sResult = await routerCall({
        tier: sectionTier,
        system: "You are ARIA, India's best script writer. Return ONLY valid JSON. Write the full spoken script — never summarise or truncate the content field.",
        user: sectionPrompt,
        maxTokens: Math.max(bp.targetWords * 6, 800),
        temperature: isFirst ? 0.85 : 0.75,
        jsonMode: true,
      });

      const raw = sResult.text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

      let parsed: any = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        // If JSON parse fails, use the raw text as content rather than crashing
        parsed = { content: raw, tip: bp.tip, durationEstimate: `${bp.startMin.toFixed(1)}–${bp.endMin.toFixed(1)} min` };
      }

      const section: ScriptSection = {
        id: bp.id,
        label: bp.label,
        type: bp.type,
        content: parsed.content || "",
        tip: parsed.tip || bp.tip,
        placeholder: bp.placeholder,
        durationEstimate: parsed.durationEstimate || `${bp.startMin.toFixed(1)}–${bp.endMin.toFixed(1)} min`,
        algoSignal: parsed.algoSignal || null,
        shareableMoment: parsed.shareableMoment || null,
        satisfactionSignal: parsed.satisfactionSignal || null,
      };

      generatedSections.push(section);
      // Keep last 300 chars as rolling context for the next section
      prevSummary = `[${bp.label}]: ${(parsed.content || "").slice(0, 300)}…`;

      onEvent({ type: "section", section, index: i, total: totalSections });

    } catch (err: any) {
      logger.warn({ err: err.message, label: bp.label }, "[Studio] Section generation failed — placeholder inserted");
      const fallback: ScriptSection = {
        id: bp.id,
        label: bp.label,
        type: bp.type,
        content: "",
        tip: bp.tip,
        placeholder: bp.placeholder,
        durationEstimate: `${bp.startMin.toFixed(1)}–${bp.endMin.toFixed(1)} min`,
      };
      generatedSections.push(fallback);
      onEvent({ type: "section", section: fallback, index: i, total: totalSections });
    }
  }

  // ── Step 4: Emit meta + done ──────────────────────────────────────────────
  onEvent({
    type: "meta",
    caption: meta.caption || "",
    hashtags: meta.hashtags || [],
    hookLine: meta.hookLine || "",
    hookTip: meta.hookTip || "",
    totalDuration: durationLabel,
    trendInsight: meta.trendInsight || brief.trendSummary,
  });

  const result: ScriptResult = {
    sections: generatedSections,
    hookLine: meta.hookLine || "",
    hookTip: meta.hookTip || "",
    caption: meta.caption || "",
    hashtags: meta.hashtags || [],
    totalDuration: durationLabel,
    researchBrief: brief,
    trendInsight: meta.trendInsight || brief.trendSummary,
    format,
  };

  onEvent({ type: "done", result });
  return result;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export async function runTwoPassStudio(
  input: StudioInput,
  onEvent: (event: SSEEvent) => void,
): Promise<ScriptResult> {
  try {
    const brief = await runDeepResearch(input, onEvent);
    const result = await generateScript(input, brief, onEvent);
    return result;
  } catch (err: any) {
    logger.error({ err: err.message }, "Two-pass studio failed");
    onEvent({
      type: "error",
      message: err.message || "Studio generation failed",
    });
    throw err;
  }
}
