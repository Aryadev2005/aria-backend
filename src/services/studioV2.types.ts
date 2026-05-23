// src/services/studioV2.types.ts
// ══════════════════════════════════════════════════════════════════
// ARIA Studio v2 — Shared type definitions
// Algorithm Signal Layer + Shoot Plan + Signal Map
// Used by: algoSignalAnalyzer, shootPlan, deep_analysis (upgraded)
// ══════════════════════════════════════════════════════════════════

// ── Algorithm Signal Types ────────────────────────────────────────

export type AlgoSignal =
  // Instagram signals
  | "WATCH_PAST_3S"        // Retains viewer in the 3s audition window
  | "COMPLETION_BOOST"     // Drives watch-to-end / completion rate
  | "DM_SHARE_TRIGGER"     // Engineered for DM forward (3-5x weight vs likes)
  | "SAVE_TRIGGER"         // Reference content — earns saves
  | "REWATCH_LOOP"         // Closing loop that drives immediate replay
  | "COMMENT_BAIT"         // Provokes typed response
  | "FOLLOW_TRIGGER"       // Converts viewer to follower
  | "TRUST_SCORE_BUILD"    // Consistent identity — builds account trust score
  // YouTube signals
  | "CTR_HOOK"             // Thumbnail/title promise delivered in opening 5s
  | "SATISFACTION_LOCK"    // First-30s prediction window — satisfaction model
  | "CHAPTER_PROMISE"      // Each chapter's micro-resolution (AVD boost)
  | "SESSION_EXTENSION"    // End-screen / CTA that keeps viewer on YouTube
  | "PATTERN_INTERRUPT";   // Re-engagement beat every 20-40s

export type AlgoSignalStrength = "weak" | "medium" | "strong";

export interface AlgoSignalPresence {
  present: boolean;
  sectionIds: string[];     // which script sections trigger this signal
  shotNumbers: number[];    // which shots in the shoot plan trigger this signal
  strength: AlgoSignalStrength;
}

// ── Shot Plan Types ───────────────────────────────────────────────

export type ShotType =
  // Algorithm shots (serve signals directly)
  | "MUTE_HOOK_FRAME"       // First 1.5s — designed for silent viewers
  | "SPOKEN_HOOK"           // 1.5-3s — the line that confirms keep watching
  | "PATTERN_INTERRUPT_CUT" // Sudden angle/subject change — resets attention
  | "SHARE_TRIGGER_CLOSE"   // ECU at emotional peak — engineered for DM share
  | "REWATCH_LOOP_CLOSE"    // Final shot that loops back to opening visual
  // Director shots (serve visual storytelling)
  | "KUBRICK_CENTER"        // Dead-center symmetrical — authority/identity
  | "NOLAN_INSERT"          // Object close-up — narrative depth + B-roll
  | "SPIELBERG_DOLLY"       // Slow push-in — emotional intimacy
  | "ANDERSON_FLAT"         // Perpendicular framing — visual brand identity
  | "SCORSESE_HANDHELD"     // Energy, urgency, authenticity
  // Solo creator shots (practical phone-only)
  | "PHONE_PROP_STATIC"     // Phone propped at eye level
  | "SELFIE_LOW_ANGLE"      // Phone below eye level — authoritative
  | "BROLL_HANDS"           // Close-up of hands doing topic-relevant action
  | "BROLL_ENVIRONMENT"     // Wide shot of creator's space — context
  | "WALK_AND_TALK"         // Moving phone — energy and momentum
  | "TALKING_HEAD_MCU";     // Medium close-up — standard teaching

export type DirectorArchetype =
  | "ARCHITECT"    // Nolan — tension, cross-cutting, pattern interrupts
  | "OBSERVER"     // Kubrick — centered symmetry, deliberate, authoritative
  | "STORYTELLER"  // Spielberg — wide→close emotional arc
  | "ARTIST"       // Wes Anderson — flat perpendicular, color, identity
  | "ENERGY"       // Scorsese — handheld, fast cuts, raw intensity
  | "REALIST";     // Bong Joon-ho — observational, unexpected angles

export type EnergyLevel = "calm" | "building" | "peak" | "release";

export interface ShotCard {
  shotNumber: number;
  scriptSectionId: string;       // maps to ScriptSection.id
  scriptSectionLabel: string;    // display label
  
  // What to capture
  shotType: ShotType;
  subject: string;               // "Your face" / "Your hands" / "The product label"
  cameraPosition: string;        // Plain English for solo creator
  cameraMovement: string;        // "Static" | "Slow push in" | "Walk forward"
  
  // What to say/do
  dialogue: string;              // Exact words pulled from script section (max 2 sentences)
  action: string;                // What to physically do while saying it
  
  // Screen design (mute viewers)
  onScreenText: string | null;
  textPosition: "top" | "center" | "bottom";
  
  // Timing
  durationSeconds: number;
  timestampStart: string;        // "0:00"
  timestampEnd: string;          // "0:03"
  
  // Director intelligence
  directorNote: string;          // Why this shot at this moment
  algoSignals: AlgoSignal[];     // Which signals this shot serves
  algoReason: string;            // Plain English — why this serves the algorithm
  
  // Practical
  brollNeeded: boolean;
  brollDescription: string | null;
  soloTip: string;               // How to do this alone with a phone
  
  // Energy + lighting
  energyLevel: EnergyLevel;
  lightingNote: string;
}

export interface BrollShot {
  id: string;
  description: string;           // What to capture
  shotType: ShotType;
  usedInShots: number[];         // shotNumbers that reference this
  soloTip: string;
}

export interface ShootPlan {
  platform: string;
  format: string;
  directorArchetype: DirectorArchetype;
  directorArchetypeLabel: string;  // "The Architect (Christopher Nolan)"
  totalShots: number;
  estimatedShootTime: string;      // "~15 minutes solo"
  equipmentNeeded: string[];
  lightingSetup: string;
  locationSuggestion: string;
  shots: ShotCard[];
  brollBank: BrollShot[];
  soloMode: boolean;
}

// ── Signal Map Types ──────────────────────────────────────────────

export interface SignalMapWarning {
  type: "missing_critical" | "weak_signal" | "drop_zone_gap";
  signal?: AlgoSignal;
  message: string;
  secondRange?: [number, number];
  fix: string;
}

export interface SignalMap {
  platform: string;
  signals: Record<AlgoSignal, AlgoSignalPresence>;
  missingCritical: AlgoSignal[];
  viralReadinessScore: number;         // 0-100 deterministic
  predictedCompletionRate: number;     // 0-100%
  predictedShareRate: "low" | "medium" | "high";
  warnings: SignalMapWarning[];
  grade: "S" | "A" | "B" | "C" | "D";
  gradeSummary: string;                // "Strong hook, weak share trigger"
}

// ── Extended SSE Events (to add to deep_analysis.service.ts) ──────

// Add these to the SSEEvent union type in deep_analysis.service.ts:
// | { type: "shoot_plan"; plan: ShootPlan }
// | { type: "signal_map"; map: SignalMap }
// | { type: "director_archetype"; archetype: DirectorArchetype; label: string }
