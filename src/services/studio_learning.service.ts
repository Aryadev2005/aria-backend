import { prisma } from '../config/database';
import { logger } from '../utils/logger';

export type IntentLabel =
  | 'tightened_language'
  | 'changed_tone'
  | 'voice_was_off'
  | 'facts_were_wrong'
  | 'restructured'
  | 'other';

interface ScriptSection {
  id: string;
  label: string;
  content: string;
}

interface DiffResult {
  sectionId: string;
  label: string;
  changeType: 'identical' | 'shortened' | 'lengthened' | 'rewritten' | 'removed';
  originalLength: number;
  editedLength: number;
  editDistance: number;
}

// ── Simple edit distance (Levenshtein) ───────────────────────────────────────
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── Diff two section arrays ───────────────────────────────────────────────────
function diffSections(
  generated: ScriptSection[],
  edited: ScriptSection[]
): DiffResult[] {
  const editedMap = new Map(edited.map((s) => [s.id, s]));
  const results: DiffResult[] = [];

  for (const gen of generated) {
    const edit = editedMap.get(gen.id);
    if (!edit) {
      results.push({
        sectionId: gen.id,
        label: gen.label,
        changeType: 'removed',
        originalLength: gen.content.length,
        editedLength: 0,
        editDistance: gen.content.length,
      });
      continue;
    }

    const dist = editDistance(gen.content, edit.content);
    const ratio = dist / Math.max(gen.content.length, 1);
    const lenDiff = edit.content.length - gen.content.length;

    let changeType: DiffResult['changeType'];
    if (dist === 0) changeType = 'identical';
    else if (ratio > 0.6) changeType = 'rewritten';
    else if (lenDiff < -20) changeType = 'shortened';
    else if (lenDiff > 20) changeType = 'lengthened';
    else changeType = 'rewritten';

    results.push({
      sectionId: gen.id,
      label: gen.label,
      changeType,
      originalLength: gen.content.length,
      editedLength: edit.content.length,
      editDistance: dist,
    });
  }

  return results;
}

// ── Map diff + intent to structured learnings ────────────────────────────────
function buildLearnings(
  diff: DiffResult[],
  intent: IntentLabel,
  generated: ScriptSection[],
  edited: ScriptSection[]
): Record<string, any> {
  const learnings: Record<string, any> = {};

  // Facts wrong — store nothing, just flag hallucination
  if (intent === 'facts_were_wrong') {
    learnings['studio.quality.hallucination_flag'] = true;
    return learnings;
  }

  const editedMap = new Map(edited.map((s) => [s.id, s]));
  const totalSections = diff.length;
  const shortenedCount = diff.filter((d) => d.changeType === 'shortened').length;
  const rewrittenCount = diff.filter((d) => d.changeType === 'rewritten').length;

  // Brevity preference
  if (intent === 'tightened_language' || shortenedCount >= totalSections * 0.5) {
    learnings['studio.style.brevity_preference'] = 'high';
    const avgOriginal = diff.reduce((a, b) => a + b.originalLength, 0) / totalSections;
    const avgEdited = diff.reduce((a, b) => a + b.editedLength, 0) / totalSections;
    learnings['studio.style.preferred_section_length'] = Math.round(avgEdited);
    learnings['studio.style.original_section_length'] = Math.round(avgOriginal);
  }

  // Tone mismatch
  if (intent === 'changed_tone') {
    learnings['studio.style.tone_mismatch_detected'] = true;
    const rewrittenSections = diff
      .filter((d) => d.changeType === 'rewritten')
      .map((d) => d.label);
    learnings['studio.style.tone_sensitive_sections'] = rewrittenSections;
  }

  // Voice was off — most valuable signal
  if (intent === 'voice_was_off') {
    learnings['studio.voice.mismatch_detected'] = true;
    // Store which sections were rewritten entirely
    const voiceRewritten = diff
      .filter((d) => d.changeType === 'rewritten' || d.changeType === 'removed')
      .map((d) => d.label);
    learnings['studio.voice.problematic_sections'] = voiceRewritten;

    // Try to extract avoided phrases from hook if it was rewritten
    const hookDiff = diff.find((d) => d.sectionId === 'hook');
    if (hookDiff && hookDiff.changeType === 'rewritten') {
      const genHook = generated.find((s) => s.id === 'hook');
      const editHook = editedMap.get('hook');
      if (genHook && editHook) {
        learnings['studio.voice.last_generated_hook'] = genHook.content;
        learnings['studio.voice.last_preferred_hook'] = editHook.content;
      }
    }
  }

  // Restructured
  if (intent === 'restructured') {
    learnings['studio.style.structure_preference'] = 'custom';
    learnings['studio.style.restructure_count'] = rewrittenCount;
  }

  // Universal — hook kept or rewritten
  const hookDiff = diff.find((d) => d.sectionId === 'hook');
  if (hookDiff) {
    learnings['studio.voice.hook_acceptance'] =
      hookDiff.changeType === 'identical' ? 'accepted' : 'rejected';
  }

  // Universal — CTA kept or rewritten
  const ctaDiff = diff.find((d) => d.sectionId === 'cta');
  if (ctaDiff) {
    learnings['studio.voice.cta_acceptance'] =
      ctaDiff.changeType === 'identical' ? 'accepted' : 'rejected';
  }

  return learnings;
}

// ── Write learnings to aria_memory table ─────────────────────────────────────
async function persistLearnings(
  userId: string,
  learnings: Record<string, any>
): Promise<void> {
  const entries = Object.entries(learnings);
  for (const [key, value] of entries) {
    const [, category, ...rest] = key.split('.');
    const memKey = rest.join('.');
    try {
      await (prisma as any).aria_memory.upsert({
        where: { user_id_category_key: { user_id: userId, category, key: memKey } },
        update: { value: JSON.stringify(value), updated_at: new Date() },
        create: {
          user_id: userId,
          category,
          key: memKey,
          value: JSON.stringify(value),
        },
      });
    } catch (err) {
      logger.warn({ err, key }, 'Failed to persist studio learning');
    }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
export const extractScriptLearnings = async ({
  userId,
  generatedSections,
  editedSections,
  intentLabel,
}: {
  userId: string;
  generatedSections: ScriptSection[];
  editedSections: ScriptSection[];
  intentLabel: IntentLabel;
}): Promise<void> => {
  try {
    const diff = diffSections(generatedSections, editedSections);
    const learnings = buildLearnings(diff, intentLabel, generatedSections, editedSections);
    await persistLearnings(userId, learnings);
    logger.info({ userId, intentLabel, keys: Object.keys(learnings) }, 'Studio learnings saved');
  } catch (err) {
    logger.error({ err }, 'extractScriptLearnings failed');
  }
};
