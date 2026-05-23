// src/services/aria_intent.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// ARIA Intent Classifier
// Classifies incoming user message into one of 9 intents BEFORE agent runs.
// This drives: which tools to pre-run, which tool subset to expose, token budget.
// Uses Groq llama-3.3-70b at temperature 0 — deterministic, fast (<300ms).
// ══════════════════════════════════════════════════════════════════════════════

import Groq from 'groq-sdk';
import { logger } from '../utils/logger';

export type ARIAIntent =
  | 'trend_request'       // "what's trending", "viral topics", "what to post"
  | 'hook_help'           // "write me a hook", "fix my hook", "make this viral"
  | 'script_request'      // "write a script", "full video idea", "reel script"
  | 'competitor_intel'    // "analyse @username", "what is my competitor doing"
  | 'analytics_question'  // "how am I doing", "my stats", "growth rate"
  | 'song_request'        // "trending song", "what audio", "music for reel"
  | 'posting_strategy'    // "when to post", "best time", "posting schedule"
  | 'brand_collab'        // "brand deal", "pitch", "rate card", "sponsorship"
  | 'general_chat';       // greetings, vague questions, anything else

export interface IntentResult {
  intent: ARIAIntent;
  confidence: number; // 0-100
  toolHints: string[]; // which tools are likely needed
  tokenBudget: number; // max_tokens for final response
}

const INTENT_SYSTEM = `You are a classifier. Given a user message, output ONLY valid JSON with the intent.

Intents:
- trend_request: asking about trends, viral topics, what to post, content ideas
- hook_help: asking to write/fix/improve a hook, first 3 seconds, opening line
- script_request: asking for a full script, video outline, reel structure
- competitor_intel: asking about a specific creator handle or competitor analysis
- analytics_question: asking about their own stats, growth, performance
- song_request: asking about trending audio, songs, music
- posting_strategy: asking when to post, frequency, schedule, calendar
- brand_collab: asking about brand deals, pitches, rate cards, sponsorships
- general_chat: greetings, vague, unclear, or anything else

Output ONLY this JSON (no preamble, no markdown):
{"intent": "...", "confidence": 85}`;

const TOOL_HINT_MAP: Record<ARIAIntent, string[]> = {
  trend_request:      ['get_live_trends', 'get_viral_ideas'],
  hook_help:          ['get_live_trends'],
  script_request:     ['get_live_trends', 'get_viral_ideas'],
  competitor_intel:   ['analyse_competitor'],
  analytics_question: ['get_creator_analytics'],
  song_request:       ['get_trending_songs'],
  posting_strategy:   ['get_creator_analytics', 'get_posting_intelligence'],
  brand_collab:       ['get_creator_analytics'],
  general_chat:       [],
};

const TOKEN_BUDGET_MAP: Record<ARIAIntent, number> = {
  trend_request:      1800,
  hook_help:          1200,
  script_request:     2500,
  competitor_intel:   2000,
  analytics_question: 1500,
  song_request:       1200,
  posting_strategy:   1200,
  brand_collab:       1800,
  general_chat:       800,
};

let _groq: Groq | null = null;
const getGroq = () => {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });
  return _groq;
};

export async function classifyIntent(message: string): Promise<IntentResult> {
  try {
    const completion = await getGroq().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 80,
      temperature: 0,
      messages: [
        { role: 'system', content: INTENT_SYSTEM },
        { role: 'user', content: message.slice(0, 500) },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(raw);
    const intent: ARIAIntent = parsed.intent in TOOL_HINT_MAP ? parsed.intent : 'general_chat';

    return {
      intent,
      confidence: parsed.confidence ?? 70,
      toolHints: TOOL_HINT_MAP[intent],
      tokenBudget: TOKEN_BUDGET_MAP[intent],
    };
  } catch (err) {
    logger.warn({ err }, 'Intent classification failed — defaulting to general_chat');
    return {
      intent: 'general_chat',
      confidence: 0,
      toolHints: [],
      tokenBudget: 1200,
    };
  }
}
