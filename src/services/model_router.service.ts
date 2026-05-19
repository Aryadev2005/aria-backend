// ==================================================================================
// Model Router — centralises all LLM client creation and call routing.
// Rules:
//   CREATIVE tier  → claude-sonnet-4-6  (hooks, hero section, chapter architect)
//   STANDARD tier  → gpt-4o-mini        (body sections, meta, captions)
//   FAST tier      → gpt-4o-mini        (structural decisions, short calls)
// ==================================================================================

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { logger } from "../utils/logger";

export type ModelTier = "creative" | "standard" | "fast";

export interface RouterCallParams {
  tier: ModelTier;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean; // if true, appends JSON instruction and strips fences
}

export interface RouterCallResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// -- Client factories ----------------------------------------------------------

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey, timeout: 90_000 });
}

function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey, timeout: 60_000 });
}

// -- Model constants -----------------------------------------------------------

export const MODELS = {
  CREATIVE: "claude-sonnet-4-6",   // Anthropic — best creative voice
  STANDARD: "gpt-4o-mini",         // OpenAI — body sections, captions
  FAST:     "gpt-4o-mini",         // OpenAI — fast structural calls
} as const;

// -- Main router call ----------------------------------------------------------

export async function routerCall(params: RouterCallParams): Promise<RouterCallResult> {
  const { tier, system, user, maxTokens = 1500, temperature = 0.75, jsonMode = false } = params;

  const systemPrompt = jsonMode
    ? `${system}\n\nReturn ONLY valid JSON. No markdown fences, no preamble.`
    : system;

  if (tier === "creative") {
    return callClaude({ system: systemPrompt, user, maxTokens, temperature });
  }
  return callOpenAI({ system: systemPrompt, user, maxTokens, temperature });
}

// -- Anthropic (Claude) call ---------------------------------------------------

async function callClaude(params: {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}): Promise<RouterCallResult> {
  const client = getAnthropicClient();
  const { system, user, maxTokens, temperature } = params;

  const res = await client.messages.create({
    model: MODELS.CREATIVE,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = res.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => (b as any).text)
    .join("");

  return {
    text,
    model: MODELS.CREATIVE,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  };
}

// -- OpenAI call ---------------------------------------------------------------

async function callOpenAI(params: {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}): Promise<RouterCallResult> {
  const client = getOpenAIClient();
  const { system, user, maxTokens, temperature } = params;

  const res = await client.chat.completions.create({
    model: MODELS.STANDARD,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = res.choices[0].message.content ?? "";
  return {
    text,
    model: MODELS.STANDARD,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
}

// -- JSON helper — strips fences and parses -----------------------------------

export function parseRouterJSON<T>(result: RouterCallResult): T {
  const clean = result.text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(clean) as T;
}
