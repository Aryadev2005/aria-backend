// src/config/credits.ts
// ══════════════════════════════════════════════════════════════════════════════
// ARIA Credit System — Central Config
//
// ARCHITECTURE:
//   - Credits are internal float units. Users NEVER see raw credit numbers.
//   - Frontend shows only: usedPct (0–100), plan name, "X× free plan" messaging.
//   - Every action costs: feature_charge (flat) + ai_dynamic_charge (token-based).
//   - credit_config.credits_cost  = feature charge (for using the feature itself)
//   - debitCredits()              = AI charge    (actual token cost → credits)
//   - Total debit = feature_charge + ai_charge   (both are floats)
//
// CREDIT VALUE:
//   1 credit = ₹0.05 (at ₹499/1500cr plan — cost to user)
//   1 credit = $0.00008 USD (your actual OpenAI cost at scale)
//   Margin per credit ≈ 60× — healthy SaaS margin
//
// PLANS (target: ₹500 avg revenue per user/month):
//   free:    100cr  — teaser, ~16% of starter
//   starter: 500cr  — ₹249  — 5× free
//   pro:    1500cr  — ₹499  — 15× free  ← target plan
//   max:    4000cr  — ₹749  — 40× free
//   brand: 10000cr  — ₹999  — 100× free
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
  | "competitor_gap"
  | "rival_spy"
  | "shoot_plan";

export interface ActionConfig {
  key: ActionKey;
  displayName: string;
  // Feature charge: flat credits for using this feature (regardless of AI cost)
  // This is the "product value" charge on top of raw AI cost.
  featureCharge: number;
  modelMini: string;
  modelHeavy: string;
  useHeavy: boolean;
  maxPerDay?: number;
  maxPerMonth?: number;
  freeTierAllowed: boolean;
  starterTierAllowed: boolean;
  proTierAllowed: boolean;
  maxTierAllowed: boolean;
}

// ── Plan credit allowances ─────────────────────────────────────────────────────
// These are the monthly credit pools per plan.
// Users see these only as 100% of their allowance — never as a raw number.
export const PLAN_CREDITS: Record<string, number> = {
  free: 100, // teaser — enough for ~10 light actions
  starter: 500, // ₹249 — 5× free — light creator
  pro: 1500, // ₹499 — 15× free — active creator  ← primary target
  max: 4000, // ₹749 — 40× free — heavy creator
  brand: 10000, // ₹999 — 100× free — agency/brand
};

// Human-readable plan labels for frontend messaging
export const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  max: "Max",
  brand: "Brand",
};

// "X× free plan" multipliers for frontend display (like Claude's messaging)
export const PLAN_MULTIPLIERS: Record<string, string> = {
  free: "Free plan",
  starter: "5× the free plan",
  pro: "15× the free plan",
  max: "40× the free plan",
  brand: "100× the free plan",
};

// Plan prices in INR (for display and Razorpay)
export const PLAN_PRICES_INR: Record<string, number> = {
  free: 0,
  starter: 249,
  pro: 499,
  max: 749,
  brand: 999,
};

// ── Top-up packs (one-time credit purchases) ──────────────────────────────────
// These are for users who exhaust their monthly allowance.
// Priced so buying is less efficient than upgrading (drives plan upgrades).
export const TOPUP_PACKS = [
  { id: "pack_50", credits: 50, amountInr: 49, label: "Quick top-up" },
  { id: "pack_150", credits: 150, amountInr: 129, label: "Standard" },
  { id: "pack_500", credits: 500, amountInr: 379, label: "Best value" },
  { id: "pack_1500", credits: 1500, amountInr: 999, label: "Power pack" },
] as const;

// ── Default action configs ────────────────────────────────────────────────────
// DB (credit_config table) is the source of truth at runtime.
// These are fallbacks if DB lookup fails.
//
// featureCharge design rationale:
//   - Free actions (browse): 0 feature charge
//   - Light AI (chat, hooks): small feature charge  (0.5–2)
//   - Medium AI (content, ideas): medium charge     (3–8)
//   - Heavy AI (reports, roadmaps): high charge     (10–25)
//   - Premium AI (brand, competitor): very high     (20–40)
//
// Total cost per action = featureCharge + ai_dynamic_charge (from tokens)
// Typical ai_dynamic_charge with gpt-4o-mini ≈ 0.2–1.5 credits
// With gpt-4o ≈ 3–15 credits
export const DEFAULT_ACTION_CONFIGS: Record<ActionKey, ActionConfig> = {
  // ── Free / zero-cost actions ─────────────────────────────────────────────
  trend_browse: {
    key: "trend_browse",
    displayName: "Browse Trends",
    featureCharge: 0,
    modelMini: "none",
    modelHeavy: "none",
    useHeavy: false,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  song_browse: {
    key: "song_browse",
    displayName: "Browse Songs",
    featureCharge: 0,
    modelMini: "none",
    modelHeavy: "none",
    useHeavy: false,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },

  // ── Light AI actions (mini model, small feature charge) ──────────────────
  aria_chat: {
    key: "aria_chat",
    displayName: "ARIA Chat",
    featureCharge: 1, // +AI dynamic ~0.3cr = ~1.3cr total
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 50,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  hook_rewrite: {
    key: "hook_rewrite",
    displayName: "Hook Rewrite",
    featureCharge: 1, // +AI dynamic ~0.2cr = ~1.2cr total
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 30,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  song_recommendations: {
    key: "song_recommendations",
    displayName: "Song Recommendations",
    featureCharge: 2, // vector search + AI scoring
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },

  // ── Medium AI actions ────────────────────────────────────────────────────
  viral_ideas: {
    key: "viral_ideas",
    displayName: "Viral Ideas Refresh",
    featureCharge: 4, // +AI dynamic ~0.8cr = ~4.8cr total
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 10,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  content_generation: {
    key: "content_generation",
    displayName: "Content Generation",
    featureCharge: 6, // +AI dynamic ~1.2cr = ~7.2cr total
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 20,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  caption_analysis: {
    key: "caption_analysis",
    displayName: "Caption Analysis",
    featureCharge: 5,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 20,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  bio_analysis: {
    key: "bio_analysis",
    displayName: "Bio Analysis",
    featureCharge: 4,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },

  // ── Heavy AI actions (larger context, higher value) ──────────────────────
  posting_package: {
    key: "posting_package",
    displayName: "Posting Package",
    featureCharge: 8,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 10,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  content_calendar: {
    key: "content_calendar",
    displayName: "Content Calendar",
    featureCharge: 10,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerMonth: 4,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  script_writing: {
    key: "script_writing",
    displayName: "Script Writing",
    featureCharge: 10,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 200,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  weekly_report: {
    key: "weekly_report",
    displayName: "Weekly Report",
    featureCharge: 12, // high-value insight feature
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerMonth: 4,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  rate_card: {
    key: "rate_card",
    displayName: "Rate Card Generator",
    featureCharge: 8,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerMonth: 10,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  brand_alert: {
    key: "brand_alert",
    displayName: "Brand Alert",
    featureCharge: 5,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },

  // ── Premium AI actions (heavy model, pro/max only) ───────────────────────
  growth_roadmap: {
    key: "growth_roadmap",
    displayName: "Growth Roadmap",
    featureCharge: 15, // +AI dynamic (4o) ~8cr = ~23cr total
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: true,
    maxPerMonth: 4,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  archetype_detection: {
    key: "archetype_detection",
    displayName: "Archetype Detection",
    featureCharge: 12,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: true,
    maxPerMonth: 2,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  voice_portrait: {
    key: "voice_portrait",
    displayName: "Voice Portrait",
    featureCharge: 15,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: true,
    maxPerDay: 1,
    maxPerMonth: 3,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  brand_pitch: {
    key: "brand_pitch",
    displayName: "Brand Pitch",
    featureCharge: 20,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: true,
    maxPerDay: 3,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },

  // ── Max/Brand tier only ──────────────────────────────────────────────────
  video_analysis: {
    key: "video_analysis",
    displayName: "Video DNA Analysis",
    featureCharge: 30,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 200,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  competitor_gap: {
    key: "competitor_gap",
    displayName: "Competitor Gap Analysis",
    featureCharge: 25,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: false,
    maxPerDay: 3,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  rival_spy: {
    key: "rival_spy",
    displayName: "Rival Spy",
    featureCharge: 0,
    modelMini: "gpt-4o-mini",
    modelHeavy: "gpt-4o",
    useHeavy: true,
    maxPerDay: 200,
    freeTierAllowed: true,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
  shoot_plan: {
    key: "shoot_plan",
    displayName: "Director's Shoot Plan",
    featureCharge: 3,
    modelMini: "gpt-4o-mini",
    modelHeavy: "claude-sonnet-4-6",
    useHeavy: false,
    freeTierAllowed: false,
    starterTierAllowed: true,
    proTierAllowed: true,
    maxTierAllowed: true,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function resolveModel(config: ActionConfig): string {
  return config.useHeavy ? config.modelHeavy : config.modelMini;
}

export function isTierAllowed(config: ActionConfig, tier: string): boolean {
  if (tier === "free") return config.freeTierAllowed;
  if (tier === "starter") return config.starterTierAllowed;
  if (tier === "pro") return config.proTierAllowed;
  if (tier === "max") return config.maxTierAllowed;
  if (tier === "brand") return config.maxTierAllowed; // brand = max+
  return false;
}

// ── OpenAI pricing (per 1M tokens, USD) ──────────────────────────────────────
export const OPENAI_PRICING: Record<string, { input: number; output: number }> =
  {
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
    "gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.6 },
    "gpt-4o": { input: 2.5, output: 10.0 },
    "gpt-4o-2024-05-13": { input: 5.0, output: 15.0 },
    "gpt-4o-2024-08-06": { input: 2.5, output: 10.0 },
    "gpt-4o-2024-11-20": { input: 2.5, output: 10.0 },
    "gpt-4-turbo": { input: 10.0, output: 30.0 },
    "gpt-4": { input: 30.0, output: 60.0 },
    "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  };

/**
 * Calculate OpenAI API cost in USD from token counts.
 */
export function calculateOpenAICost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = OPENAI_PRICING[model] ?? OPENAI_PRICING["gpt-4o-mini"];
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

/**
 * Convert USD cost → credits (float).
 *
 * Calibration:
 *   Target: Pro plan (1500cr / ₹499). At ~80% margin, we can "afford" to
 *   spend ~₹100 in OpenAI costs per Pro user/month.
 *   ₹100 ÷ 83 (₹/USD) ≈ $1.20 OpenAI budget per user/month.
 *   1500 credits allocated for AI portion ≈ 700cr (rest is feature charges).
 *   So 1 credit ≈ $1.20/700 ≈ $0.00171 in AI spend.
 *   Use $0.002/credit to stay profitable with headroom.
 *
 * 1 credit = $0.002 USD of OpenAI spend
 * Typical gpt-4o-mini action (2000in/800out): $0.00048 → 0.24 credits AI charge
 * Typical gpt-4o action (3000in/1200out): $0.0195 → 9.75 credits AI charge
 */
export function usdToCredits(usdCost: number): number {
  const CREDIT_VALUE_USD = 0.002; // 1 credit = $0.002 of OpenAI cost
  return usdCost / CREDIT_VALUE_USD; // returns FLOAT — do NOT Math.ceil here
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
