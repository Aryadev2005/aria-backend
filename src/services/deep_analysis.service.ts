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
import { ChatOpenAI, tools as openAITools } from "@langchain/openai";
import { createDeepAgent } from "deepagents";
import { z } from "zod";
import OpenAI from "openai";
import { logger } from "../utils/logger";

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
  | { type: "done"; result: ScriptResult }
  | { type: "error"; message: string };

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
        label: "Hook",
        type: "hook",
        placeholder: "First 2 seconds — must stop the scroll",
        tip: "No intro. Open mid-action or with a bold claim.",
      },
      {
        label: "Value Drop",
        type: "body",
        placeholder: "Deliver the core value fast",
        tip: "One idea, maximum clarity. Cut every filler word.",
      },
      {
        label: "CTA",
        type: "cta",
        placeholder: "One action: follow, save, or comment",
        tip: "'Comment YES if you want part 2' > 'Let me know.'",
      },
    ],
    scriptInstructions:
      "Short-form vertical video. Every word must earn its place. Write like texting a friend with 3 seconds of patience.",
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

export async function runDeepResearch(
  input: StudioInput,
  onEvent: (event: SSEEvent) => void,
): Promise<ResearchBrief> {
  const { idea, platform, niche, format, angle } = input;

  onEvent({ type: "phase", phase: "researching", label: "Deep Research" });
  onEvent({ type: "research_update", message: "Initializing research agent…" });

  // ── Tools the researcher subagent gets ───────────────────────────────────
  // 1. OpenAI's native web search — bound as LangChain tool
  const webSearchTool = openAITools.webSearch({
    userLocation: { type: "approximate", country: "IN" },
  });

  // 2. Apify scraper for platform-specific real trend data
  const apifyScraperTool = tool(
    async ({ platform: plt, query, maxItems = 8 }) => {
      const apiKey = process.env.APIFY_API_KEY;
      if (!apiKey) return JSON.stringify({ error: "APIFY_API_KEY not set" });
      const ACTOR_MAP: Record<string, string> = {
        instagram: "apify/instagram-hashtag-scraper",
        youtube: "streamers/youtube-scraper",
        tiktok: "clockworks/free-tiktok-scraper",
      };
      const actorId = ACTOR_MAP[plt] ?? ACTOR_MAP.instagram;
      try {
        const runRes = await fetch(
          `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${apiKey}&maxItems=${maxItems}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hashtags: [query.replace(/^#/, "")],
              resultsLimit: maxItems,
              searchQuery: query,
            }),
            signal: AbortSignal.timeout(25_000),
          },
        );
        if (!runRes.ok)
          return JSON.stringify({ error: `Apify ${runRes.status}` });
        const items = await runRes.json();
        const trimmed = Array.isArray(items)
          ? items.slice(0, maxItems).map((it: any) => ({
              title: it.title || it.caption?.slice(0, 100) || "",
              views: it.viewCount || it.videoViewCount || it.likesCount || 0,
              hashtags: (it.hashtags || []).slice(0, 6),
            }))
          : [];
        return JSON.stringify({ platform: plt, query, results: trimmed });
      } catch (err: any) {
        return JSON.stringify({ error: err.message });
      }
    },
    {
      name: "apify_trend_scraper",
      description:
        "Scrape trending posts from Instagram or YouTube. Use this to get real engagement data. Use AFTER web searches.",
      schema: z.object({
        platform: z.enum(["instagram", "youtube", "tiktok"]),
        query: z.string().describe("Topic or hashtag to search"),
        maxItems: z.number().optional(),
      }),
    },
  );

  // ── Researcher subagent definition ────────────────────────────────────────
  // This is a specialized subagent spawned by the main deep agent via the
  // built-in `task` tool. It runs with context isolation — its own search
  // loop doesn't pollute the main agent's context window.
  const researcherSubagent = {
    name: "researcher",
    description:
      "Deep research subagent with web search and platform scraping. Delegate ALL research tasks here.",
    systemPrompt: `You are a content intelligence researcher for TrendAI — an Indian creator intelligence platform.

Research topics DEEPLY. You MUST search multiple times before concluding.

Required search sequence:
1. web_search: "[topic] trending [platform] India 2025"
2. web_search: "[niche] content strategy [platform] viral India 2025"
3. web_search: "[topic] [niche] Indian audience pain points"
4. web_search: "top [niche] creators [platform] India hooks"
5. apify_trend_scraper: get real platform data for the topic

After ALL searches, return ONLY this JSON (no other text, no markdown):
{
  "trendStrength": "rising|peaking|declining|evergreen",
  "trendSummary": "2-3 sentences on what is ACTUALLY trending with specific data from your searches",
  "whyItWorks": "The psychological/cultural reason this resonates with Indian audiences",
  "topViralAngles": ["angle with evidence", "angle 2", "angle 3", "angle 4", "angle 5"],
  "audienceInsights": "Specific demographics, pain points, desires for this topic in India",
  "hookPatterns": ["hook formula with example from real post", "formula 2", "formula 3", "formula 4"],
  "competitorGaps": "What top creators are NOT doing — the clear opportunity",
  "contentRecommendation": "Specific format, length, style recommendation from research",
  "bestTiming": "Best day/time for Indian audiences on this platform with reasoning",
  "rawSources": "Key sources and data points found"
}`,
    model: new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.2 }).bindTools(
      [webSearchTool],
    ),
    tools: [apifyScraperTool],
  };

  // ── Main deep agent ───────────────────────────────────────────────────────
  // createDeepAgent wraps LangGraph orchestration — it gets:
  // - write_todos (built-in planning tool)
  // - task (built-in subagent delegation tool)
  // - The researcher subagent above
  const researchAgent = createDeepAgent({
    model: new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.2 }),
    subagents: [researcherSubagent],
    systemPrompt: `You are TrendAI's research orchestrator.
Your ONLY job: delegate a research task to the researcher subagent, then return its JSON output verbatim.
Do not modify or interpret the JSON. Just return exactly what the researcher produces.`,
  });

  const researchTask = `Research this for TrendAI:
TOPIC: "${idea}"
PLATFORM: ${platform}
NICHE: ${niche}
FORMAT NEEDED: ${format}
${angle ? `DESIRED ANGLE: ${angle}` : ""}

Delegate to the researcher subagent with these exact instructions:
- Research "${idea}" trending on ${platform} in India
- Find viral angles in the ${niche} niche
- Identify Indian audience insights for this topic
- Scrape ${platform} for real engagement data on "${idea}"
- Return the complete JSON research brief`;

  try {
    onEvent({
      type: "research_update",
      message: "Agent planning research strategy…",
    });

    // Stream the deep agent's LangGraph execution
    const agentStream = await researchAgent.stream(
      { messages: [{ role: "user", content: researchTask }] },
      { streamMode: "updates" },
    );

    let stepCount = 0;
    let finalContent = "";

    for await (const update of agentStream) {
      // LangGraph streams state updates — extract messages for progress
      const msgs = update?.messages ?? update?.agent?.messages ?? [];
      for (const msg of Array.isArray(msgs) ? msgs : []) {
        const content = typeof msg.content === "string" ? msg.content : "";
        if (!content) continue;

        stepCount++;
        finalContent = content;

        // Friendly progress messages based on content hints
        if (
          content.toLowerCase().includes("web_search") ||
          content.toLowerCase().includes("searching")
        ) {
          onEvent({
            type: "research_update",
            message: `Web search ${stepCount}…`,
          });
        } else if (
          content.toLowerCase().includes("apify") ||
          content.toLowerCase().includes("scraping")
        ) {
          onEvent({
            type: "research_update",
            message: "Scraping platform data…",
          });
        } else if (content.toLowerCase().includes("researcher")) {
          onEvent({
            type: "research_update",
            message: "Researcher subagent analyzing…",
          });
        } else if (
          content.toLowerCase().includes("trendstrength") ||
          content.includes("{")
        ) {
          onEvent({
            type: "research_update",
            message: "Synthesizing findings…",
          });
        }
      }

      // Also check tool call chunks (tool_calls live on individual AIMessages)
      const toolCalls = (Array.isArray(msgs) ? msgs : []).flatMap(
        (m: any) => m?.tool_calls ?? [],
      );
      for (const tc of toolCalls) {
        if (tc?.name === "task") {
          onEvent({
            type: "research_update",
            message: "Delegating to researcher subagent…",
          });
        } else if (tc?.name === "write_todos") {
          onEvent({
            type: "research_update",
            message: "Planning research strategy…",
          });
        } else if (
          tc?.name === "web_search" ||
          tc?.name === "web_search_preview"
        ) {
          onEvent({
            type: "research_update",
            message: `Searching: ${tc?.args?.query?.slice(0, 50) || "…"}`,
          });
        }
      }
    }

    // Extract the JSON brief from the final agent output
    const jsonMatch = finalContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in research output");

    const brief: ResearchBrief = JSON.parse(jsonMatch[0]);
    onEvent({ type: "research_done", brief });
    return brief;
  } catch (err: any) {
    logger.warn(
      { err: err.message },
      "Deep agent failed, using fallback brief",
    );
    const fallback: ResearchBrief = {
      trendStrength: "evergreen",
      trendSummary: `Content about "${idea}" in the ${niche} niche on ${platform}.`,
      whyItWorks:
        "Audiences engage with authentic, useful content in this niche.",
      topViralAngles: [
        "Personal story + lesson format",
        "Common mistake + correct approach",
        "Beginner guide with actionable steps",
        "Behind the scenes process reveal",
        "Myth busting format",
      ],
      audienceInsights: `${niche} enthusiasts on ${platform} in India seeking practical value.`,
      hookPatterns: [
        "I tried X for 30 days — here's what happened",
        "Nobody tells you this about X",
        "Stop doing X. Do this instead.",
        "The real reason X doesn't work for most people",
      ],
      competitorGaps:
        "Most creators explain what without showing how. Show your process.",
      contentRecommendation: `A ${format} with direct, no-fluff delivery works best for this topic.`,
      bestTiming: "Tuesday–Thursday, 7–9 PM IST for Indian audiences.",
      rawSources: "Fallback data — deep agent encountered an error.",
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

export async function generateScript(
  input: StudioInput,
  brief: ResearchBrief,
  onEvent: (event: SSEEvent) => void,
): Promise<ScriptResult> {
  const {
    idea,
    platform,
    niche,
    format,
    mood,
    angle,
    archetype,
    voiceContext,
    learnedPrefs,
  } = input;

  onEvent({ type: "phase", phase: "scripting", label: "Generating Script" });

  const formatConfig = FORMAT_CONFIGS[format] || FORMAT_CONFIGS.reel;

  const scriptPrompt = `You are ARIA — TrendAI's script engine for Indian creators.

RESEARCH BRIEF (from deep web research — apply these directly):
- Trend: ${brief.trendStrength} — ${brief.trendSummary}
- Why it works: ${brief.whyItWorks}
- Top viral angles: ${brief.topViralAngles.join(" | ")}
- Audience: ${brief.audienceInsights}
- Proven hooks: ${brief.hookPatterns.join(" | ")}
- Opportunity gap: ${brief.competitorGaps}
- Recommendation: ${brief.contentRecommendation}
- Best timing: ${brief.bestTiming}

CREATOR:
- Idea: "${idea}" | Platform: ${platform} | Niche: ${niche}
- Format: ${format} (${formatConfig.durationRange}) | Mood: ${mood || "authentic"} | Angle: ${angle || "best from research"}
- Archetype: ${archetype}
${voiceContext ? `- Voice: ${voiceContext}` : ""}
${learnedPrefs ? `- Preferences: ${learnedPrefs}` : ""}

FORMAT RULES: ${formatConfig.scriptInstructions}
SECTIONS: ${formatConfig.sections.map((s) => s.label).join(", ")}

Rules:
1. Hook MUST use one of the proven hook patterns from research
2. Address the specific audience pain points found in research
3. Exploit the competitor gap identified
4. Write in the creator's voice — never generic

Return ONLY valid JSON:
{
  "hookLine": "Most powerful opening line (max 15 words)",
  "hookTip": "Why this hook works and how to deliver it",
  "caption": "Full ready-to-post caption with emojis, line breaks, hashtags",
  "hashtags": ["#tag1","#tag2","#tag3","#tag4","#tag5","#tag6","#tag7","#tag8","#tag9","#tag10"],
  "totalDuration": "${formatConfig.durationRange}",
  "trendInsight": "One punchy sentence on why this script is timely",
  "sections": [
    ${formatConfig.sections
      .map(
        (s, i) => `{
      "id": "s${i}",
      "label": "${s.label}",
      "type": "${s.type}",
      "content": "Full, specific, ready-to-use content using research insights",
      "tip": "Specific delivery or editing tip",
      "placeholder": "${s.placeholder}",
      "durationEstimate": "Estimated time/length"
    }`,
      )
      .join(",\n    ")}
  ]
}`;

  const res = await oai().chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 3000,
    temperature: 0.72,
    messages: [
      {
        role: "system",
        content: "You are ARIA. Return ONLY valid JSON, no markdown.",
      },
      { role: "user", content: scriptPrompt },
    ],
  });

  const text = res.choices[0].message.content ?? "";
  const cleaned = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const parsed = JSON.parse(cleaned);

  const sections: ScriptSection[] = (parsed.sections || []).map(
    (s: any, i: number) => ({
      id: s.id || `s${i}`,
      label: s.label || formatConfig.sections[i]?.label || `Section ${i + 1}`,
      type: s.type || formatConfig.sections[i]?.type || "body",
      content: s.content || "",
      tip: s.tip || formatConfig.sections[i]?.tip || "",
      placeholder: s.placeholder || formatConfig.sections[i]?.placeholder || "",
      durationEstimate: s.durationEstimate,
    }),
  );

  for (let i = 0; i < sections.length; i++) {
    onEvent({
      type: "section",
      section: sections[i],
      index: i,
      total: sections.length,
    });
    await new Promise((r) => setTimeout(r, 100));
  }

  onEvent({
    type: "meta",
    caption: parsed.caption || "",
    hashtags: parsed.hashtags || [],
    hookLine: parsed.hookLine || "",
    hookTip: parsed.hookTip || "",
    totalDuration: parsed.totalDuration || formatConfig.durationRange,
    trendInsight: parsed.trendInsight || brief.trendSummary,
  });

  const result: ScriptResult = {
    sections,
    hookLine: parsed.hookLine || "",
    hookTip: parsed.hookTip || "",
    caption: parsed.caption || "",
    hashtags: parsed.hashtags || [],
    totalDuration: parsed.totalDuration || formatConfig.durationRange,
    researchBrief: brief,
    trendInsight: parsed.trendInsight || brief.trendSummary,
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
