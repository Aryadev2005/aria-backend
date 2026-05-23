// src/services/algoSignalAnalyzer.service.ts
// ══════════════════════════════════════════════════════════════════
// ARIA Algorithm Signal Analyzer
//
// DETERMINISTIC scoring engine — mirrors the VideoDNA principle:
// AI does nothing here. All scoring is explicit TypeScript formulas.
//
// Input:  ScriptSection[] + ShootPlan + platform + format
// Output: SignalMap with viralReadinessScore, warnings, grade
// ══════════════════════════════════════════════════════════════════

import {
  AlgoSignal, AlgoSignalPresence, AlgoSignalStrength,
  ShootPlan, ShotCard, SignalMap, SignalMapWarning,
} from "./studioV2.types";
import { ScriptSection } from "./deep_analysis.service";

// ── Signal keyword maps (deterministic text scanning) ────────────

const SECTION_SIGNAL_KEYWORDS: Record<AlgoSignal, string[]> = {
  WATCH_PAST_3S:      ["hook", "stop", "wait", "before you scroll", "first", "opening", "0:00", "0:03", "3 second"],
  COMPLETION_BOOST:   ["value", "drop", "key point", "main", "here's why", "this is", "the truth", "number"],
  DM_SHARE_TRIGGER:   ["send this", "share this", "tag someone", "forward", "your friend", "send to", "dm this", "yaar ko bhej", "share karo"],
  SAVE_TRIGGER:       ["save", "bookmark", "screenshot", "keep this", "reference", "come back", "checklist", "save kar"],
  REWATCH_LOOP:       ["from the start", "back to", "loop", "circle back", "one more time", "rewatch"],
  COMMENT_BAIT:       ["comment", "tell me", "what do you think", "agree", "disagree", "let me know", "batao", "reply", "drop a"],
  FOLLOW_TRIGGER:     ["follow", "subscribe", "more like this", "next video", "part 2", "follow karo", "bell"],
  TRUST_SCORE_BUILD:  ["consistent", "every week", "series", "always", "I always", "I never"],
  CTR_HOOK:           ["thumbnail", "title", "promised", "here's the", "you clicked", "you're here because"],
  SATISFACTION_LOCK:  ["in this video", "by the end", "you'll learn", "I'll show", "we'll cover", "first 30", "stay till"],
  CHAPTER_PROMISE:    ["in this chapter", "next up", "chapter", "section", "part", "step"],
  SESSION_EXTENSION:  ["watch this next", "click here", "next video", "playlist", "end screen", "recommended"],
  PATTERN_INTERRUPT:  ["but wait", "actually", "plot twist", "here's the thing", "wait—", "hold on", "actually though", "re-hook"],
};

const SHOT_SIGNAL_MAP: Record<string, AlgoSignal[]> = {
  MUTE_HOOK_FRAME:       ["WATCH_PAST_3S"],
  SPOKEN_HOOK:           ["WATCH_PAST_3S", "TRUST_SCORE_BUILD"],
  PATTERN_INTERRUPT_CUT: ["PATTERN_INTERRUPT", "COMPLETION_BOOST"],
  SHARE_TRIGGER_CLOSE:   ["DM_SHARE_TRIGGER"],
  REWATCH_LOOP_CLOSE:    ["REWATCH_LOOP", "FOLLOW_TRIGGER"],
  KUBRICK_CENTER:        ["TRUST_SCORE_BUILD", "WATCH_PAST_3S"],
  NOLAN_INSERT:          ["COMPLETION_BOOST", "PATTERN_INTERRUPT"],
  SPIELBERG_DOLLY:       ["DM_SHARE_TRIGGER", "SATISFACTION_LOCK"],
  ANDERSON_FLAT:         ["TRUST_SCORE_BUILD"],
  SCORSESE_HANDHELD:     ["WATCH_PAST_3S", "COMPLETION_BOOST"],
  PHONE_PROP_STATIC:     ["COMPLETION_BOOST"],
  SELFIE_LOW_ANGLE:      ["WATCH_PAST_3S", "TRUST_SCORE_BUILD"],
  BROLL_HANDS:           ["COMPLETION_BOOST", "PATTERN_INTERRUPT"],
  BROLL_ENVIRONMENT:     ["TRUST_SCORE_BUILD"],
  WALK_AND_TALK:         ["COMPLETION_BOOST", "PATTERN_INTERRUPT"],
  TALKING_HEAD_MCU:      ["COMPLETION_BOOST"],
};

// ── Critical signals per platform ────────────────────────────────

const CRITICAL_SIGNALS: Record<string, AlgoSignal[]> = {
  instagram: ["WATCH_PAST_3S", "DM_SHARE_TRIGGER", "COMPLETION_BOOST"],
  youtube:   ["CTR_HOOK", "SATISFACTION_LOCK", "CHAPTER_PROMISE", "SESSION_EXTENSION"],
  youtube_short: ["WATCH_PAST_3S", "COMPLETION_BOOST", "REWATCH_LOOP"],
};

// ── Score weights per signal ──────────────────────────────────────

const SIGNAL_WEIGHTS: Record<AlgoSignal, number> = {
  WATCH_PAST_3S:      20,
  COMPLETION_BOOST:   15,
  DM_SHARE_TRIGGER:   20,
  SAVE_TRIGGER:       8,
  REWATCH_LOOP:       10,
  COMMENT_BAIT:       5,
  FOLLOW_TRIGGER:     7,
  TRUST_SCORE_BUILD:  5,
  CTR_HOOK:           20,
  SATISFACTION_LOCK:  20,
  CHAPTER_PROMISE:    10,
  SESSION_EXTENSION:  10,
  PATTERN_INTERRUPT:  10,
};

// ── Helpers ───────────────────────────────────────────────────────

function scanSectionForSignals(section: ScriptSection): AlgoSignal[] {
  const text = `${section.label} ${section.content} ${section.tip}`.toLowerCase();
  const found: AlgoSignal[] = [];
  for (const [signal, keywords] of Object.entries(SECTION_SIGNAL_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) {
      found.push(signal as AlgoSignal);
    }
  }
  // Type-based guarantees
  if (section.type === "hook")       { if (!found.includes("WATCH_PAST_3S"))   found.push("WATCH_PAST_3S"); }
  if (section.type === "cta")        { if (!found.includes("FOLLOW_TRIGGER"))  found.push("FOLLOW_TRIGGER"); }
  if (section.type === "transition") { if (!found.includes("PATTERN_INTERRUPT")) found.push("PATTERN_INTERRUPT"); }
  return found;
}

function getShotSignals(shot: ShotCard): AlgoSignal[] {
  return SHOT_SIGNAL_MAP[shot.shotType] ?? [];
}

function signalStrength(
  sectionIds: string[],
  shotNumbers: number[],
  isCritical: boolean,
): AlgoSignalStrength {
  const total = sectionIds.length + shotNumbers.length;
  if (total === 0) return "weak";
  if (isCritical && total >= 2) return "strong";
  if (total >= 3) return "strong";
  if (total >= 1) return "medium";
  return "weak";
}

// ── Main analyzer ─────────────────────────────────────────────────

export function analyzeAlgoSignals(
  sections: ScriptSection[],
  shootPlan: ShootPlan | null,
  platform: string,
): SignalMap {
  const allSignals: AlgoSignal[] = [
    "WATCH_PAST_3S", "COMPLETION_BOOST", "DM_SHARE_TRIGGER", "SAVE_TRIGGER",
    "REWATCH_LOOP", "COMMENT_BAIT", "FOLLOW_TRIGGER", "TRUST_SCORE_BUILD",
    "CTR_HOOK", "SATISFACTION_LOCK", "CHAPTER_PROMISE", "SESSION_EXTENSION", "PATTERN_INTERRUPT",
  ];

  const critical = CRITICAL_SIGNALS[platform] ?? CRITICAL_SIGNALS.instagram;

  // Build presence map
  const signalMap: Record<AlgoSignal, AlgoSignalPresence> = {} as any;
  for (const signal of allSignals) {
    signalMap[signal] = { present: false, sectionIds: [], shotNumbers: [], strength: "weak" };
  }

  // Scan sections
  for (const section of sections) {
    const found = scanSectionForSignals(section);
    for (const signal of found) {
      signalMap[signal].sectionIds.push(section.id);
      signalMap[signal].present = true;
    }
  }

  // Scan shoot plan shots
  if (shootPlan) {
    for (const shot of shootPlan.shots) {
      const found = getShotSignals(shot);
      for (const signal of found) {
        if (!signalMap[signal].shotNumbers.includes(shot.shotNumber)) {
          signalMap[signal].shotNumbers.push(shot.shotNumber);
          signalMap[signal].present = true;
        }
      }
    }
  }

  // Compute strength for each
  for (const signal of allSignals) {
    const p = signalMap[signal];
    p.strength = signalStrength(p.sectionIds, p.shotNumbers, critical.includes(signal));
  }

  // Missing critical signals
  const missingCritical = critical.filter((s) => !signalMap[s].present);

  // Compute viral readiness score (0-100)
  let rawScore = 0;
  let maxScore = 0;
  for (const signal of allSignals) {
    const weight = SIGNAL_WEIGHTS[signal];
    maxScore += weight;
    const p = signalMap[signal];
    if (p.present) {
      const mult = p.strength === "strong" ? 1.0 : p.strength === "medium" ? 0.7 : 0.4;
      rawScore += weight * mult;
    }
  }
  const viralReadinessScore = Math.round((rawScore / maxScore) * 100);

  // Predicted completion rate (based on structural signals)
  let completionBase = 40;
  if (signalMap["WATCH_PAST_3S"].present) completionBase += 20;
  if (signalMap["COMPLETION_BOOST"].strength === "strong") completionBase += 15;
  if (signalMap["PATTERN_INTERRUPT"].present) completionBase += 10;
  if (signalMap["REWATCH_LOOP"].present) completionBase += 5;
  const predictedCompletionRate = Math.min(95, completionBase);

  // Predicted share rate
  const shareScore = signalMap["DM_SHARE_TRIGGER"].present
    ? (signalMap["DM_SHARE_TRIGGER"].strength === "strong" ? 3 : 2)
    : 1;
  const predictedShareRate: "low" | "medium" | "high" =
    shareScore === 3 ? "high" : shareScore === 2 ? "medium" : "low";

  // Warnings
  const warnings: SignalMapWarning[] = [];
  for (const signal of missingCritical) {
    const fixes: Record<AlgoSignal, string> = {
      WATCH_PAST_3S:      "Add a MUTE_HOOK_FRAME shot and rewrite hook section to land in ≤3s",
      DM_SHARE_TRIGGER:   "Add a 'Send this to [specific person]' line + SHARE_TRIGGER_CLOSE shot",
      COMPLETION_BOOST:   "Tighten body sections — remove every word that doesn't add value",
      CTR_HOOK:           "Open with the payoff — state the thumbnail promise in first 5s",
      SATISFACTION_LOCK:  "Restructure opening 30s to deliver a mini-payoff before the main promise",
      CHAPTER_PROMISE:    "Add chapter timestamps and state each chapter's micro-promise",
      SESSION_EXTENSION:  "Add explicit 'watch this next' CTA with specific video reference",
      SAVE_TRIGGER:       "Add a checklist, framework, or reference moment worth bookmarking",
      REWATCH_LOOP:       "End on the same visual as the opening to create a seamless loop",
      COMMENT_BAIT:       "Ask one specific question that requires a one-word or emoji answer",
      FOLLOW_TRIGGER:     "Add value-forward follow CTA: 'Follow for [specific weekly benefit]'",
      TRUST_SCORE_BUILD:  "Establish a consistent visual identity — same angle, same framing",
      PATTERN_INTERRUPT:  "Add a re-hook beat at the 8-12s mark: angle change, stat, or question",
    };
    warnings.push({
      type: "missing_critical",
      signal,
      message: `Critical signal missing: ${signal}`,
      fix: fixes[signal] ?? "Review script structure",
    });
  }

  // Drop zone warnings (platform-specific)
  if (platform === "instagram") {
    const hasPatternAt8s = sections.some((s) =>
      s.type === "transition" || SECTION_SIGNAL_KEYWORDS.PATTERN_INTERRUPT.some((kw) => (s.content + s.tip).toLowerCase().includes(kw))
    );
    if (!hasPatternAt8s && sections.length > 2) {
      warnings.push({
        type: "drop_zone_gap",
        message: "No pattern interrupt detected in the 8-15s drop zone",
        secondRange: [8, 15],
        fix: "Add a Re-hook transition section or PATTERN_INTERRUPT_CUT shot between 8-15s",
      });
    }
  }

  // Grade
  let grade: "S" | "A" | "B" | "C" | "D";
  if (viralReadinessScore >= 88)      grade = "S";
  else if (viralReadinessScore >= 75) grade = "A";
  else if (viralReadinessScore >= 60) grade = "B";
  else if (viralReadinessScore >= 45) grade = "C";
  else                                grade = "D";

  const gradeSummary = missingCritical.length === 0
    ? "All critical signals present"
    : `Missing: ${missingCritical.join(", ")}`;

  return {
    platform,
    signals: signalMap,
    missingCritical,
    viralReadinessScore,
    predictedCompletionRate,
    predictedShareRate,
    warnings,
    grade,
    gradeSummary,
  };
}
