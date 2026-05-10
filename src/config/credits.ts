// src/config/credits.ts
// ══════════════════════════════════════════════════════════════════════════════
// TrendAI Credit System — Central Config
//
// This is the ONLY place that defines what each action costs and which model
// it uses. All services import from here. DB config overrides at runtime.
//
// To change a model or cost:
//   Option A (instant, no deploy): UPDATE credit_config SET ... WHERE action_key = '...'
//   Option B (code): Update the defaults here and run a migration
// ══════════════════════════════════════════════════════════════════════════════

export type ActionKey =
  | "trend_browse"
  | "song_browse"
  | "content_generation"
  | "viral_ideas"
  | "aria_chat"
  | "hook_rewrite"
  | "song_recommendations"
  | "caption_analysis"
  | "bio_analysis"
  | "posting_package"
  | "weekly_report"
  | "content_calendar"
  | "brand_alert"
  | "growth_roadmap"
  | "rate_card"
  | "script_writing"
  | "brand_pitch"
  | "archetype_detection"
  | "voice_portrait"
  | "video_analysis"
  | "competitor_gap";

export interface ActionConfig {
  key: ActionKey;
  displayName: string;
  creditsCost: number;
  modelMini: string; // fast/cheap model
  modelHeavy: string; // smart/expensive model
  useHeavy: boolean; // which one this action actually uses
  maxPerDay?: number;
  maxPerMonth?: number;
  freeTierAllowed: boolean;
  proTierAllowed: boolean;
  maxTierAllowed: boolean;
}

// ── Plan credit allowances ────────────────────────────────────────────────────
export const PLAN_CREDITS: Record<string, number> = {
  free: 50,
  pro: 500,
  max: 1500,
  brand: 5000,
};

// ── Top-up packs ──────────────────────────────────────────────────────────────
export const TOPUP_PACKS = [
  { id: "pack_100", credits: 100, amountInr: 79 },
  { id: "pack_300", credits: 300, amountInr: 199 },
  { id: "pack_1000", credits: 1000, amountInr: 549 },
  { id: "pack_3000", credits: 3000, amountInr: 1299 },
] as const;

// ── Default action configs (DB is the source of truth at runtime) ─────────────
// These are fallbacks if DB lookup fails — keeps the system running
export const DEFAULT_ACTION_CONFIGS: Record<ActionKey, ActionConfig> = {
  trend_browse: {
    key: "trend_browse",
    displayName: "Browse Trends",
    creditsCost: 0,
    modelMini: "none",
    modelHeavy: "none",
    useHeavy: false,
    freeTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  song_browse: {
    key: "song_browse",
    displayName: "Browse Songs",
    creditsCost: 0,
    modelMini: "none",
    modelHeavy: "none",
    useHeavy: false,
    freeTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  content_generation: {
    key: "content_generation",
    displayName: "Content Generation",
    creditsCost: 10,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 20,
    freeTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  viral_ideas: {
    key: "viral_ideas",
    displayName: "Viral Ideas Refresh",
    creditsCost: 5,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 10,
    freeTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  aria_chat: {
    key: "aria_chat",
    displayName: "ARIA Chat",
    creditsCost: 3,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 50,
    freeTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  hook_rewrite: {
    key: "hook_rewrite",
    displayName: "Hook Rewrite",
    creditsCost: 2,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 30,
    freeTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  song_recommendations: {
    key: "song_recommendations",
    displayName: "Song Recommendations",
    creditsCost: 5,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    freeTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  caption_analysis: {
    key: "caption_analysis",
    displayName: "Caption Analysis",
    creditsCost: 5,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 10,
    freeTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  bio_analysis: {
    key: "bio_analysis",
    displayName: "Bio Analysis",
    creditsCost: 5,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 5,
    freeTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  posting_package: {
    key: "posting_package",
    displayName: "Posting Package",
    creditsCost: 8,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 10,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  weekly_report: {
    key: "weekly_report",
    displayName: "Weekly Report",
    creditsCost: 10,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 1,
    maxPerMonth: 4,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  content_calendar: {
    key: "content_calendar",
    displayName: "Content Calendar",
    creditsCost: 15,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 1,
    maxPerMonth: 1,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  brand_alert: {
    key: "brand_alert",
    displayName: "Brand Alert Check",
    creditsCost: 3,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 5,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  growth_roadmap: {
    key: "growth_roadmap",
    displayName: "Growth Roadmap",
    creditsCost: 30,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 1,
    maxPerMonth: 4,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  rate_card: {
    key: "rate_card",
    displayName: "Rate Card Generator",
    creditsCost: 20,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 2,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  script_writing: {
    key: "script_writing",
    displayName: "Script Writing",
    creditsCost: 25,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 5,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  brand_pitch: {
    key: "brand_pitch",
    displayName: "Brand Pitch",
    creditsCost: 25,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 3,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  archetype_detection: {
    key: "archetype_detection",
    displayName: "Archetype Detection",
    creditsCost: 15,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: true, // ← uses heavy model
    maxPerDay: 1,
    maxPerMonth: 2,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  voice_portrait: {
    key: "voice_portrait",
    displayName: "Voice Portrait Build",
    creditsCost: 20,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: true, // ← uses heavy model
    maxPerDay: 1,
    maxPerMonth: 1,
    freeTierAllowed: false,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  video_analysis: {
    key: "video_analysis",
    displayName: "Video DNA Analysis",
    creditsCost: 50,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 5,
    freeTierAllowed: false,
    proTierAllowed: false,
    maxTierAllowed: true, // max+ only
  },
  competitor_gap: {
    key: "competitor_gap",
    displayName: "Competitor Gap Analysis",
    creditsCost: 40,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 3,
    freeTierAllowed: false,
    proTierAllowed: false,
    maxTierAllowed: true, // max+ only
  },
};

// ── Helper: resolve which model string to actually use ────────────────────────
export function resolveModel(config: ActionConfig): string {
  if (config.useHeavy) return config.modelHeavy;
  return config.modelMini;
}

// ── Helper: check tier access ─────────────────────────────────────────────────
export function isTierAllowed(config: ActionConfig, tier: string): boolean {
  if (tier === "free") return config.freeTierAllowed;
  if (tier === "pro") return config.proTierAllowed;
  if (tier === "max") return config.maxTierAllowed;
  if (tier === "brand") return config.maxTierAllowed; // brand = max+
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OPENAI PRICING - Dynamic cost calculation (per 1M tokens in USD)
// ═══════════════════════════════════════════════════════════════════════════════

export const OPENAI_PRICING: Record<string, { input: number; output: number }> =
  {
    // GPT-4o Mini (default for most operations)
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.6 },

    // GPT-4o (for complex tasks)
    "gpt-4o": { input: 2.5, output: 10.0 },
    "gpt-4o-2024-05-13": { input: 5.0, output: 15.0 },
    "gpt-4o-2024-08-06": { input: 2.5, output: 10.0 },
    "gpt-4o-2024-11-20": { input: 2.5, output: 10.0 },

    // GPT-4 Turbo
    "gpt-4-turbo": { input: 10.0, output: 30.0 },
    "gpt-4-turbo-2024-04-09": { input: 10.0, output: 30.0 },

    // GPT-4
    "gpt-4": { input: 30.0, output: 60.0 },
    "gpt-4-0613": { input: 30.0, output: 60.0 },
    "gpt-4-32k": { input: 60.0, output: 120.0 },

    // GPT-3.5 Turbo (legacy)
    "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
    "gpt-3.5-turbo-0125": { input: 0.5, output: 1.5 },
  };

/**
 * Calculate actual OpenAI API cost in USD based on model and token usage
 * @param model - The OpenAI model used (e.g., "gpt-4o-mini", "gpt-4o")
 * @param inputTokens - Number of input/prompt tokens
 * @param outputTokens - Number of output/completion tokens
 * @returns Cost in USD
 */
export function calculateOpenAICost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = OPENAI_PRICING[model] || OPENAI_PRICING["gpt-4o-mini"];

  // Calculate cost: (tokens / 1,000,000) * price_per_1M
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * Get estimated token count for a text string (rough approximation)
 * 1 token ≈ 4 characters for English text
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Calculate credits to deduct based on USD cost
 * 1 credit = $0.001 USD (adjustable)
 */
export function usdToCredits(usdCost: number): number {
  const CREDIT_VALUE_USD = 0.001; // 1 credit = $0.001
  return Math.ceil(usdCost / CREDIT_VALUE_USD);
}
