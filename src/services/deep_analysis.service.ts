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
  attachedNotes?: AttachedNote[];
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
// ── REPLACE the entire runDeepResearch function in src/services/deep_analysis.service.ts
// ── Everything else (types, FORMAT_CONFIGS, generateScript, runTwoPassStudio) stays identical

export async function runDeepResearch(
  input: StudioInput,
  onEvent: (event: SSEEvent) => void,
): Promise<ResearchBrief> {
  const { idea, platform, niche, format, angle } = input;

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

  // ── Apify scraper — OPTIONAL, always returns gracefully ──────────────────
  const apifyScraperTool = tool(
    async ({
      platform: plt,
      query,
    }: {
      platform: string;
      query: string;
    }): Promise<string> => {
      const apiKey = process.env.APIFY_API_KEY?.trim();
      if (!apiKey) {
        logger.warn("[DeepResearch] APIFY_API_KEY not set — skip");
        return JSON.stringify({
          skipped: true,
          reason: "Apify not configured. Proceed with web search results.",
        });
      }

      const ACTOR_MAP: Record<string, string> = {
        instagram: "apify/instagram-hashtag-scraper",
        youtube: "streamers/youtube-scraper",
        tiktok: "clockworks/free-tiktok-scraper",
      };
      const actorId = ACTOR_MAP[plt] ?? ACTOR_MAP.instagram;
      logger.info({ plt, query, actorId }, "[DeepResearch] Apify scrape start");

      try {
        const runRes = await fetch(
          `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${apiKey}&maxItems=6`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hashtags: [query.replace(/^#/, "")],
              resultsLimit: 6,
              searchQuery: query,
            }),
            signal: AbortSignal.timeout(20_000),
          },
        );

        if (!runRes.ok) {
          logger.warn(
            { status: runRes.status },
            "[DeepResearch] Apify HTTP error — skip",
          );
          return JSON.stringify({
            skipped: true,
            reason: `Apify ${runRes.status}. Use web search data only.`,
          });
        }

        const items = await runRes.json();
        const trimmed = Array.isArray(items)
          ? items.slice(0, 6).map((it: any) => ({
              title: it.title || it.caption?.slice(0, 80) || "",
              views: it.viewCount || it.videoViewCount || it.likesCount || 0,
              hashtags: (it.hashtags || []).slice(0, 5),
            }))
          : [];

        logger.info({ count: trimmed.length }, "[DeepResearch] Apify success");
        return JSON.stringify({ platform: plt, query, results: trimmed });
      } catch (err: any) {
        logger.warn({ err: err.message }, "[DeepResearch] Apify failed — skip");
        return JSON.stringify({
          skipped: true,
          reason: `Apify unavailable. Proceed with web search data only.`,
        });
      }
    },
    {
      name: "apify_trend_scraper",
      description:
        "Optional: scrape trending posts from Instagram/YouTube for engagement data. Call ONCE only. If skipped:true is returned, do NOT retry.",
      schema: z.object({
        platform: z.enum(["instagram", "youtube", "tiktok"]),
        query: z.string().describe("Topic or hashtag to search"),
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
Step 5: apify_trend_scraper → platform="${platform}", query="${idea}" (call ONCE, accept any result)
Step 6: STOP all tool calls. Write the JSON brief immediately.
 
CRITICAL RULES:
- If apify_trend_scraper returns skipped:true — that is fine, do NOT retry, go to Step 6
- Do NOT run more than 4 web_search calls
- Do NOT call any tool more than once
- After Step 5 (or if it fails), output the JSON immediately — no more tool calls
 
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
    tools: [webSearchTool, apifyScraperTool],
  };

  // ── Main deep agent — with recursion_limit ────────────────────────────────
  const researchAgent = createDeepAgent({
    model: new ChatOpenAI({ model: "gpt-4o-mini", temperature: 0.1 }),
    subagents: [researcherSubagent],
    systemPrompt: `You are TrendAI's research orchestrator.
Use the task tool ONCE to delegate to the researcher subagent.
Return the researcher's JSON output verbatim — no extra text.`,
  });

  const researchTask = `Research this for TrendAI:
TOPIC: "${idea}"
PLATFORM: ${platform}
NICHE: ${niche}
FORMAT: ${format}
${angle ? `ANGLE: ${angle}` : ""}
 
Use the task tool to delegate to the "researcher" subagent now.`;

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
      let apifyCalled = false;

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
            } else if (tc.name === "apify_trend_scraper") {
              if (!apifyCalled) {
                apifyCalled = true;
                emit(`Scraping ${tc.args?.platform ?? "platform"} data…`);
              } else {
                logger.warn(
                  "[DeepResearch] Apify called >1 time — potential loop",
                );
              }
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
          } else if (toolName === "apify_trend_scraper") {
            try {
              const parsed = JSON.parse(content);
              emit(
                parsed.skipped
                  ? "Platform data unavailable — using web results…"
                  : "Platform data received…",
              );
            } catch {
              emit("Platform data processed…");
            }
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
    attachedNotes,
  } = input;

  onEvent({ type: "phase", phase: "scripting", label: "Generating Script" });

  const formatConfig = FORMAT_CONFIGS[format] || FORMAT_CONFIGS.reel;

  // Build attached notes context if present
  const attachedNotesContext =
    attachedNotes && attachedNotes.length > 0
      ? `
ATTACHED NOTES (use these as reference/context — full content provided):
${attachedNotes
  .map(
    (note, i) => `--- Note ${i + 1}: ${note.title || "Untitled"} ---
Content: ${note.content || "(no content)"}
${note.tags?.length ? `Tags: ${note.tags.join(", ")}` : ""}
`,
  )
  .join("\n")}
Use insights from these notes where relevant to enrich the script.`
      : "";

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
${attachedNotesContext}

FORMAT RULES: ${formatConfig.scriptInstructions}
SECTIONS: ${formatConfig.sections.map((s) => s.label).join(", ")}

Rules:
1. Hook MUST use one of the proven hook patterns from research
2. Address the specific audience pain points found in research
3. Exploit the competitor gap identified
4. Write in the creator's voice — never generic
5. If attached notes are provided, weave relevant insights naturally into the script

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
