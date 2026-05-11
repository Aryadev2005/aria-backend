// src/services/deepAnalysis.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Deep Analysis Agent — LangChain Deep Agent with OpenAI web search + Apify
// Streams SSE events to the client so the UI never sits blank.
// ══════════════════════════════════════════════════════════════════════════════

import { tool } from "@langchain/core/tools";
import { ChatOpenAI, tools as openAITools } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { logger } from "../utils/logger";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface DeepAnalysisInput {
  topic: string;
  platform: string; // instagram | youtube | reels
  niche: string;
  contentType: string; // reel | post | thread | video
  angle?: string; // optional creative angle
  creatorName?: string;
}

export type SSEEvent =
  | { type: "status"; message: string }
  | { type: "research"; content: string }
  | { type: "strategy"; content: string }
  | { type: "hooks"; content: string[] }
  | { type: "captions"; content: string[] }
  | { type: "hashtags"; content: string[] }
  | { type: "contentPlan"; content: ContentPlanItem[] }
  | { type: "done"; summary: string }
  | { type: "error"; message: string };

export interface ContentPlanItem {
  day: number;
  title: string;
  format: string;
  hook: string;
  angle: string;
}

// ── Apify scraper tool ────────────────────────────────────────────────────────
// Wraps your existing Apify setup to scrape Instagram/YouTube trend data
const apifyTrendScraper = tool(
  async ({ platform, query, maxItems = 10 }) => {
    const apiKey = process.env.APIFY_API_KEY;
    if (!apiKey) return JSON.stringify({ error: "APIFY_API_KEY not set" });

    // Actor map — same actors already used in your discovery pipeline
    const ACTOR_MAP: Record<string, string> = {
      instagram: "apify/instagram-hashtag-scraper",
      youtube: "streamers/youtube-scraper",
      tiktok: "clockworks/free-tiktok-scraper",
    };

    const actorId = ACTOR_MAP[platform] ?? ACTOR_MAP.instagram;

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
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (!runRes.ok) {
        return JSON.stringify({ error: `Apify error ${runRes.status}` });
      }

      const items = await runRes.json();
      // Return a trimmed summary so we don't blow the context window
      const trimmed = Array.isArray(items)
        ? items.slice(0, maxItems).map((it: any) => ({
            title: it.title || it.caption?.slice(0, 100) || "",
            views: it.viewCount || it.videoViewCount || it.likesCount || 0,
            hashtags: (it.hashtags || []).slice(0, 8),
            url:
              it.url || it.shortCode
                ? `https://instagram.com/p/${it.shortCode}`
                : "",
          }))
        : [];

      return JSON.stringify({ platform, query, results: trimmed });
    } catch (err: any) {
      logger.warn({ err: err.message }, "Apify scraper failed");
      return JSON.stringify({ error: err.message });
    }
  },
  {
    name: "apify_trend_scraper",
    description:
      "Scrape trending content from Instagram or YouTube for a given topic/hashtag. Returns top posts with view counts and hashtags.",
    schema: z.object({
      platform: z
        .enum(["instagram", "youtube", "tiktok"])
        .describe("Platform to scrape"),
      query: z
        .string()
        .describe("Topic or hashtag to search (e.g. 'skincare routine')"),
      maxItems: z
        .number()
        .optional()
        .describe("Max results to return (default 10)"),
    }),
  },
);

// ── Build research agent (ReAct loop: think → tool call → observe → answer) ──
function buildResearchAgent() {
  const model = new ChatOpenAI({
    model: "gpt-4o",
    temperature: 0.4,
  });

  const webSearch = openAITools.webSearch({
    userLocation: { type: "approximate", country: "IN" },
  });

  return createReactAgent({
    llm: model,
    tools: [webSearch, apifyTrendScraper],
  });
}

// ── Main streaming runner ─────────────────────────────────────────────────────
export async function runDeepAnalysis(
  input: DeepAnalysisInput,
  onEvent: (event: SSEEvent) => void,
): Promise<void> {
  const { topic, platform, niche, contentType, angle, creatorName } = input;

  try {
    onEvent({
      type: "status",
      message: "Starting deep research on your topic…",
    });

    // ── PHASE 1: Research ─────────────────────────────────────────────────────
    onEvent({
      type: "status",
      message: "Searching the web for latest trends…",
    });

    const researchPrompt = `You are a content intelligence researcher for Indian social media creators.

Research the topic: "${topic}" for ${platform} creators in the ${niche} niche.

Do the following:
1. Use web_search to find the LATEST trends, viral content, and audience insights for this topic in India (May 2026)
2. Use apify_trend_scraper to scrape trending posts on ${platform} for this topic
3. Identify what's currently working: formats, angles, hooks
4. Note any Indian-specific cultural context, slang, or references that would resonate

Return a structured research summary covering:
- Current trend strength (is this rising, peaking, or declining?)
- Top 3 viral angles being used right now
- Audience pain points and desires
- What top creators are doing differently
- Best posting windows for Indian audiences on ${platform}

Be specific, use real data from your searches.`;

    let researchOutput = "";

    // Run full ReAct agent loop: model calls tools, gets results, then writes
    // the final research summary as a plain text AIMessage.
    const researchAgent = buildResearchAgent();
    const agentResult = await researchAgent.invoke({
      messages: [{ role: "user", content: researchPrompt }],
    });

    // Last message in the agent trace is the final AI answer
    const lastMsg = agentResult.messages[agentResult.messages.length - 1];
    const rc = lastMsg?.content;

    logger.info(
      {
        msgCount: agentResult.messages.length,
        lastMsgType: lastMsg?.constructor?.name ?? typeof lastMsg,
        contentType: typeof rc,
        contentIsArray: Array.isArray(rc),
        contentSample: Array.isArray(rc)
          ? rc
              .slice(0, 2)
              .map((b: any) => ({
                type: b?.type,
                hasText: "text" in (b ?? {}),
                keys: Object.keys(b ?? {}),
              }))
          : String(rc).slice(0, 200),
      },
      "DEBUG: agent result last message",
    );

    if (typeof rc === "string") {
      researchOutput = rc;
    } else if (Array.isArray(rc)) {
      researchOutput = rc
        .map((block: any) => {
          if (typeof block === "string") return block;
          if (block?.type === "text") return block.text ?? "";
          return "";
        })
        .join("")
        .trim();
    }

    logger.info(
      {
        researchOutputLength: researchOutput.length,
        preview: researchOutput.slice(0, 200),
      },
      "DEBUG: researchOutput extracted",
    );

    onEvent({ type: "research", content: researchOutput });
    onEvent({
      type: "status",
      message: "Research complete. Building your content strategy…",
    });

    // ── PHASE 2: Strategy + Content Generation ────────────────────────────────
    const contentModel = new ChatOpenAI({
      model: "gpt-4o",
      temperature: 0.75,
      streaming: true,
    });

    const strategyPrompt = `You are TrendAI's content strategist for Indian social media creators.

RESEARCH FINDINGS:
${researchOutput}

CREATOR CONTEXT:
- Creator: ${creatorName || "Indian content creator"}
- Platform: ${platform}
- Niche: ${niche}
- Content Type: ${contentType}
- Desired Angle: ${angle || "whatever works best based on research"}

Based on this research, generate a FULL content intelligence package. Return ONLY valid JSON with this exact structure:

{
  "strategy": "A 2-3 paragraph content strategy explaining exactly what to do and why, based on the research. Be specific about timing, format, and approach.",
  
  "hooks": [
    "Hook 1 — attention-grabbing opening line for ${platform}",
    "Hook 2 — different angle, equally punchy",
    "Hook 3 — emotional/relatable variation",
    "Hook 4 — controversial or counter-intuitive",
    "Hook 5 — data/stat-driven"
  ],
  
  "captions": [
    "Full caption variant 1 with relevant emojis, hashtag placeholders, and CTA — optimized for ${platform} algorithm in 2026",
    "Full caption variant 2 — different tone/approach",
    "Full caption variant 3 — storytelling format"
  ],
  
  "hashtags": [
    "#tag1", "#tag2", "#tag3", "#tag4", "#tag5",
    "#tag6", "#tag7", "#tag8", "#tag9", "#tag10",
    "#tag11", "#tag12", "#tag13", "#tag14", "#tag15"
  ],
  
  "contentPlan": [
    { "day": 1, "title": "Content piece title", "format": "${contentType}", "hook": "Opening line", "angle": "Unique angle" },
    { "day": 3, "title": "Content piece title", "format": "${contentType}", "hook": "Opening line", "angle": "Unique angle" },
    { "day": 5, "title": "Content piece title", "format": "${contentType}", "hook": "Opening line", "angle": "Unique angle" },
    { "day": 7, "title": "Content piece title", "format": "${contentType}", "hook": "Opening line", "angle": "Unique angle" },
    { "day": 10, "title": "Content piece title", "format": "${contentType}", "hook": "Opening line", "angle": "Unique angle" },
    { "day": 14, "title": "Content piece title", "format": "${contentType}", "hook": "Opening line", "angle": "Unique angle" }
  ],
  
  "summary": "One punchy sentence summarising the core insight for this creator."
}

Important: The hooks, captions, and hashtags must be in Hinglish or English — whatever works best for ${niche} creators on ${platform} in India. Make them feel human, not AI-generated. Reference real cultural context where possible.`;

    const strategyStream = await contentModel.stream([
      { role: "user", content: strategyPrompt },
    ]);

    let strategyRaw = "";
    for await (const chunk of strategyStream) {
      const text = chunk.content?.toString() ?? "";
      strategyRaw += text;
    }

    // Parse and emit structured events
    try {
      const cleaned = strategyRaw
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

      const parsed = JSON.parse(cleaned);

      onEvent({ type: "strategy", content: parsed.strategy });
      onEvent({ type: "hooks", content: parsed.hooks });
      onEvent({ type: "captions", content: parsed.captions });
      onEvent({ type: "hashtags", content: parsed.hashtags });
      onEvent({ type: "contentPlan", content: parsed.contentPlan });
      onEvent({ type: "done", summary: parsed.summary });
    } catch (parseErr) {
      // Fallback: emit the raw text as strategy if JSON parse fails
      logger.warn({ parseErr }, "Strategy JSON parse failed, emitting raw");
      onEvent({ type: "strategy", content: strategyRaw });
      onEvent({ type: "done", summary: "Analysis complete." });
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "Deep analysis failed");
    onEvent({ type: "error", message: err.message || "Analysis failed" });
  }
}
