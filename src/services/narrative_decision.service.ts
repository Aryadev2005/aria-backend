// src/services/narrative_decision.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Structural Decision Layer (Pass 1.5)
// Reads the ResearchBrief and makes an explicit narrative architecture decision.
// This becomes a hard constraint in buildSectionBlueprints — not a suggestion.
// ══════════════════════════════════════════════════════════════════════════════

import { routerCall, parseRouterJSON } from "./model_router.service";
import { ResearchBrief } from "./deep_analysis.service";
import { logger } from "../utils/logger";

export type NarrativeFramework =
  | "BEFORE_AFTER_BRIDGE"    // Relatable state → transformation → how
  | "PROBLEM_AGITATE_SOLVE"  // Name pain → amplify → offer solution
  | "CURIOSITY_STORY"        // Tease revelation → story → payoff
  | "LIST_COUNTDOWN"         // N things/tips/mistakes (countdown = higher retention)
  | "CONTRARIAN_PIVOT"       // "Everyone says X, but actually Y"
  | "HOW_TO_JOURNEY"         // Step-by-step tutorial with clear milestone sections
  | "DOCUMENTARY_REVEAL";    // Investigation-style, evidence builds to conclusion

export interface StructuralDecision {
  framework: NarrativeFramework;
  frameworkLabel: string;
  whyThisFramework: string;       // One sentence
  openLoops: string[];            // 1–3 curiosity loops to open in the hook
  payoffPromises: string[];       // What the viewer is promised and must get
  retentionRisks: string[];       // Moments where viewers might drop off
  narrativeInstructions: string;  // Injected verbatim into every section prompt
}

const FRAMEWORK_LABELS: Record<NarrativeFramework, string> = {
  BEFORE_AFTER_BRIDGE:  "Before/After/Bridge",
  PROBLEM_AGITATE_SOLVE:"Problem/Agitate/Solve",
  CURIOSITY_STORY:      "Curiosity Story",
  LIST_COUNTDOWN:       "List/Countdown",
  CONTRARIAN_PIVOT:     "Contrarian Pivot",
  HOW_TO_JOURNEY:       "How-To Journey",
  DOCUMENTARY_REVEAL:   "Documentary Reveal",
};

const FRAMEWORK_DESCRIPTIONS: Record<NarrativeFramework, string> = {
  BEFORE_AFTER_BRIDGE:
    "Open with the relatable 'before' state. Jump to the dramatic 'after'. The script is the bridge explaining how. Emotional resonance is highest here.",
  PROBLEM_AGITATE_SOLVE:
    "Name the exact problem in language the viewer has thought but not said. Agitate — make it feel urgent and personal. Then solve. Works for niche pain points.",
  CURIOSITY_STORY:
    "Open a specific curiosity loop (a question, a mystery, a surprising fact). Tell a story that builds toward the answer. Pay off the loop precisely at the end.",
  LIST_COUNTDOWN:
    "Structure as N items. Countdown format (5, 4, 3...) outperforms ascending because viewers stay to see #1. Each item must be genuinely useful, not filler.",
  CONTRARIAN_PIVOT:
    "Establish the conventional wisdom. Pivot hard against it with evidence. Explain why the conventional view is wrong. Provocative — highest share potential.",
  HOW_TO_JOURNEY:
    "Clear step-by-step with visible milestones. Viewer knows exactly where they are. Each step must have a micro-result. Best for educational/tutorial content.",
  DOCUMENTARY_REVEAL:
    "Investigation style — start with a surprising claim or mystery. Reveal evidence layer by layer. Conclusion is earned, not stated upfront. High completion rate.",
};

export async function makeStructuralDecision(params: {
  idea: string;
  platform: string;
  niche: string;
  format: string;
  brief: ResearchBrief;
  totalMinutes: number;
}): Promise<StructuralDecision> {
  const { idea, platform, niche, format, brief, totalMinutes } = params;
  const isLongForm = totalMinutes > 3;

  const prompt = `You are a world-class script architect. 
Choose the optimal narrative framework for this content.

CONTENT BRIEF:
- Idea: "${idea}"
- Platform: ${platform} | Niche: ${niche} | Format: ${format}
- Duration: ${totalMinutes < 1 ? Math.round(totalMinutes * 60) + "s" : Math.round(totalMinutes) + " min"}
- Trend: ${brief.trendStrength} — ${brief.trendSummary}
- Why it works: ${brief.whyItWorks}
- Audience: ${brief.audienceInsights}
- Top angles: ${brief.topViralAngles.slice(0, 3).join(" | ")}
- Competitor gap: ${brief.competitorGaps}

AVAILABLE FRAMEWORKS:
${Object.entries(FRAMEWORK_DESCRIPTIONS).map(([k, v]) => `${k}: ${v}`).join("\n")}

SELECTION RULES:
- Transformation content → BEFORE_AFTER_BRIDGE
- Niche pain content → PROBLEM_AGITATE_SOLVE  
- Mystery/revelation topics → CURIOSITY_STORY or DOCUMENTARY_REVEAL
- Tips/mistakes/habits → LIST_COUNTDOWN (if 3+ items)
- Opinion/takes/unpopular views → CONTRARIAN_PIVOT
- Tutorial/how-to → HOW_TO_JOURNEY
- Long-form investigation → DOCUMENTARY_REVEAL
- Short-form (≤60s): use PROBLEM_AGITATE_SOLVE or LIST_COUNTDOWN or CURIOSITY_STORY only

Return ONLY valid JSON:
{
  "framework": "<FRAMEWORK_KEY>",
  "frameworkLabel": "<display label>",
  "whyThisFramework": "one sentence on why this framework fits this exact content",
  "openLoops": ["curiosity loop 1 to open in hook", "loop 2 if long-form", "loop 3 if long-form"],
  "payoffPromises": ["what viewer is promised", "must be delivered by end"],
  "retentionRisks": ["moment where viewers might drop — e.g. 'between step 2 and 3'"],
  "narrativeInstructions": "3–5 sentence instruction injected into every section. Describes how this framework should feel throughout the script."
}`;

  try {
    const result = await routerCall({
      tier: "fast",
      system: "You are a script architect. Return ONLY valid JSON.",
      user: prompt,
      maxTokens: 600,
      temperature: 0.3, // low temp — this is a strategic decision, not creative
      jsonMode: true,
    });
    const decision = parseRouterJSON<StructuralDecision>(result);
    logger.info({ framework: decision.framework, idea }, "[NarrativeDecision] Framework selected");
    return decision;
  } catch (err: any) {
    logger.warn({ err: err.message }, "[NarrativeDecision] Failed — using default framework");
    return {
      framework: "CURIOSITY_STORY",
      frameworkLabel: "Curiosity Story",
      whyThisFramework: "Fallback framework — always works for Indian creator content.",
      openLoops: ["What is the one thing most people get wrong about this?"],
      payoffPromises: ["A clear answer to the opening question."],
      retentionRisks: ["Middle section losing momentum."],
      narrativeInstructions:
        "Open a strong curiosity loop in the hook. Build toward the answer through the body sections. Each section should feel like progress toward the promised revelation. Pay off the loop precisely in the final section before the CTA.",
    };
  }
}