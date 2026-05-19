// src/services/hook_engine.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Hook Archetype Engine
// Generates 3 psychologically-typed hook variants per script.
// Each variant uses a different archetype from the science of viral openers.
// The creator picks one. The system logs which archetype they chose.
// ══════════════════════════════════════════════════════════════════════════════

import { routerCall, parseRouterJSON } from "./model_router.service";
import { ResearchBrief } from "./deep_analysis.service";
import { logger } from "../utils/logger";

// ── Hook archetypes — rooted in viral psychology research ────────────────────
// Sources: retention science (65% of viewers who watch 3s watch 10s),
// psychology of curiosity gaps, pattern interrupt theory, identity signalling.

export type HookArchetype =
  | "CURIOSITY_GAP"       // Open a loop, tease payoff, delay explanation
  | "PATTERN_INTERRUPT"   // Start mid-action, disrupt expectation immediately
  | "PAIN_AMPLIFIER"      // Name the exact pain → amplify → hint at solution
  | "IDENTITY_HOOK"       // Speaks directly to who they are ("If you're a...")
  | "CONTRARIAN_CLAIM"    // Bold statement that challenges conventional wisdom
  | "BEFORE_AFTER"        // Open with the dramatic result, then tease the journey
  | "SOCIAL_PROOF_SHOCK"; // Number/stat that stops scroll + challenges belief

export interface HookVariant {
  archetype: HookArchetype;
  archetypeLabel: string;
  hookLine: string;       // The exact spoken opening line (max 15 words)
  hookTip: string;        // How to deliver it (energy, pause, visual cue)
  psychologyNote: string; // Why this works for this creator's audience
  visualCue: string;      // What the creator should do/show in first 2 seconds
}

export interface HookEngineResult {
  variants: HookVariant[];
  recommendedArchetype: HookArchetype;
  recommendationReason: string;
}

// ── Archetype selector — picks 3 best archetypes for this content ─────────────

function selectArchetypes(
  preferredHookStyle: string | undefined,
  trendStrength: string,
  niche: string,
): HookArchetype[] {
  // Map voice portrait's preferredHookStyle to a primary archetype
  const styleMap: Record<string, HookArchetype> = {
    "question hook":     "CURIOSITY_GAP",
    "relatable story":   "PAIN_AMPLIFIER",
    "shock statement":   "PATTERN_INTERRUPT",
    "bold claim":        "CONTRARIAN_CLAIM",
    "identity hook":     "IDENTITY_HOOK",
    "data hook":         "SOCIAL_PROOF_SHOCK",
    "result reveal":     "BEFORE_AFTER",
  };

  const primary: HookArchetype =
    styleMap[preferredHookStyle?.toLowerCase() ?? ""] ?? "CURIOSITY_GAP";

  // Always pair primary with two high-performing complements
  const complements: Record<HookArchetype, HookArchetype[]> = {
    CURIOSITY_GAP:     ["PATTERN_INTERRUPT", "CONTRARIAN_CLAIM"],
    PATTERN_INTERRUPT: ["CURIOSITY_GAP", "PAIN_AMPLIFIER"],
    PAIN_AMPLIFIER:    ["IDENTITY_HOOK", "BEFORE_AFTER"],
    IDENTITY_HOOK:     ["PAIN_AMPLIFIER", "CURIOSITY_GAP"],
    CONTRARIAN_CLAIM:  ["SOCIAL_PROOF_SHOCK", "PATTERN_INTERRUPT"],
    BEFORE_AFTER:      ["PAIN_AMPLIFIER", "CURIOSITY_GAP"],
    SOCIAL_PROOF_SHOCK:["CURIOSITY_GAP", "CONTRARIAN_CLAIM"],
  };

  return [primary, ...complements[primary]];
}

// ── Archetype display labels ──────────────────────────────────────────────────

const ARCHETYPE_LABELS: Record<HookArchetype, string> = {
  CURIOSITY_GAP:      "Curiosity Gap",
  PATTERN_INTERRUPT:  "Pattern Interrupt",
  PAIN_AMPLIFIER:     "Pain Amplifier",
  IDENTITY_HOOK:      "Identity Hook",
  CONTRARIAN_CLAIM:   "Contrarian Claim",
  BEFORE_AFTER:       "Before/After Reveal",
  SOCIAL_PROOF_SHOCK: "Stat Shock",
};

// ── Main hook generation function ─────────────────────────────────────────────

export async function generateHookVariants(params: {
  idea: string;
  platform: string;
  niche: string;
  format: string;
  brief: ResearchBrief;
  preferredHookStyle?: string;
  voiceContext?: string;
  archetype: string;
}): Promise<HookEngineResult> {
  const { idea, platform, niche, format, brief, preferredHookStyle,
          voiceContext, archetype } = params;

  const selectedArchetypes = selectArchetypes(preferredHookStyle, brief.trendStrength, niche);

  const archetypeDescriptions: Record<HookArchetype, string> = {
    CURIOSITY_GAP:
      "Open a knowledge loop the viewer MUST close. Tease a specific payoff without delivering it. The viewer can't scroll because they need the answer.",
    PATTERN_INTERRUPT:
      "Start mid-sentence, mid-action, or with something visually jarring. Break the brain's pattern-matching. The viewer stops because their brain got confused.",
    PAIN_AMPLIFIER:
      "Name their EXACT pain in words they've thought but never said out loud. Amplify the frustration. Then hint at the solution — don't give it yet.",
    IDENTITY_HOOK:
      "Address them directly by who they are or want to be. 'If you're a creator in India doing X...' They stop because you're talking to THEM specifically.",
    CONTRARIAN_CLAIM:
      "Say the opposite of conventional wisdom in your niche. Bold, specific, slightly provocative. They stop to find out if you're right or crazy.",
    BEFORE_AFTER:
      "Open with the dramatic result or transformation. Show the 'after' first. Then pull back to tease the 'how'. The gap between where they are and the result is magnetic.",
    SOCIAL_PROOF_SHOCK:
      "Lead with a specific number or stat that's surprising or unsettling. Indian context numbers hit harder. Then connect it to their life.",
  };

  const variantPrompts = selectedArchetypes.map((arch) =>
    `ARCHETYPE: ${arch} — ${ARCHETYPE_LABELS[arch]}
PSYCHOLOGY: ${archetypeDescriptions[arch]}
Write ONE hook variant using ONLY this archetype's psychological mechanism.`
  ).join("\n\n---\n\n");

  const prompt = `You are ARIA — India's elite viral scriptwriter.
Generate 3 hook variants for this content. Each uses a DIFFERENT psychological archetype.

CONTENT CONTEXT:
- Idea: "${idea}"
- Platform: ${platform} | Niche: ${niche} | Format: ${format}
- Creator archetype: ${archetype}
${voiceContext ? `- Creator voice: ${voiceContext}` : ""}
- Trend: ${brief.trendStrength} — ${brief.trendSummary}
- Why this topic works: ${brief.whyItWorks}
- Proven hook patterns from research: ${brief.hookPatterns.slice(0, 3).join(" | ")}
- Audience: ${brief.audienceInsights}

VARIANTS TO GENERATE:
${variantPrompts}

RULES FOR ALL VARIANTS:
1. Each hookLine must be ≤15 words of natural spoken dialogue
2. NO "Hey guys", "Welcome back", "In this video", "Today I'm going to"
3. Indian context — Hinglish is fine if natural, use Indian examples/numbers
4. The hook must be SPOKEN — the creator reads this word for word
5. visualCue = exactly what appears on screen or what creator does in first 2s
6. psychologyNote = one sentence on why this specific variant works for this audience

Return ONLY valid JSON:
{
  "variants": [
    {
      "archetype": "${selectedArchetypes[0]}",
      "archetypeLabel": "${ARCHETYPE_LABELS[selectedArchetypes[0]]}",
      "hookLine": "exact spoken line max 15 words",
      "hookTip": "delivery instruction — energy level, pause, emphasis word",
      "psychologyNote": "why this works for this creator's audience",
      "visualCue": "what appears on screen or what creator does at second 0"
    },
    {
      "archetype": "${selectedArchetypes[1]}",
      "archetypeLabel": "${ARCHETYPE_LABELS[selectedArchetypes[1]]}",
      "hookLine": "...",
      "hookTip": "...",
      "psychologyNote": "...",
      "visualCue": "..."
    },
    {
      "archetype": "${selectedArchetypes[2]}",
      "archetypeLabel": "${ARCHETYPE_LABELS[selectedArchetypes[2]]}",
      "hookLine": "...",
      "hookTip": "...",
      "psychologyNote": "...",
      "visualCue": "..."
    }
  ],
  "recommendedArchetype": "${selectedArchetypes[0]}",
  "recommendationReason": "one sentence on why this archetype fits this creator+topic combo"
}`;

  try {
    const result = await routerCall({
      tier: "creative",
      system: "You are ARIA — India's elite viral scriptwriter. Return ONLY valid JSON.",
      user: prompt,
      maxTokens: 1200,
      temperature: 0.85,
      jsonMode: true,
    });
    return parseRouterJSON<HookEngineResult>(result);
  } catch (err: any) {
    logger.warn({ err: err.message }, "[HookEngine] Generation failed, using fallback");
    // Fallback: return single generic variant so pipeline never breaks
    return {
      variants: [{
        archetype: "CURIOSITY_GAP",
        archetypeLabel: "Curiosity Gap",
        hookLine: brief.hookPatterns[0] || "You won't believe what changed everything for me.",
        hookTip: "Say it like you're sharing a secret. Slow down on the last word.",
        psychologyNote: "Opens a loop the audience must close.",
        visualCue: "Close-up face, direct eye contact, slight pause before starting.",
      }],
      recommendedArchetype: "CURIOSITY_GAP",
      recommendationReason: "Default fallback — research agent hook pattern used.",
    };
  }
}