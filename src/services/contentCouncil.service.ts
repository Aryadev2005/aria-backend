import OpenAI from 'openai';
import { logger } from '../utils/logger';
import type {
  MetadataStream, AuralStream, VisualStream, HeatmapData,
  HookAnalysis, RetentionAnalysis, SeoViralAnalysis, ValueDensityAnalysis,
} from '../types/videoIntelligence.types';

let _openai: OpenAI | null = null;
const getAI = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 45_000 });
  return _openai;
};

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 1: The Hook Analyst
// Focuses on first 30 seconds + thumbnail/title promise alignment
// ─────────────────────────────────────────────────────────────────────────────
export const runHookAnalyst = async (
  metadata: MetadataStream,
  aural: AuralStream | null,
  visual: VisualStream | null,
  creatorNiche: string,
): Promise<HookAnalysis> => {
  const first30sTranscript = aural?.segments
    .filter(s => s.start <= 30)
    .map(s => s.text)
    .join(' ') ?? '';

  const first30sFrameTypes = visual?.frames
    .filter(f => f.timestamp <= 30)
    .map(f => `${f.timestamp}s: ${f.frameType} (energy:${f.energyScore})`)
    .join(', ') ?? 'No visual data';

  const prompt = `You are ARIA's Hook Analyst — India's sharpest video hook critic.

VIDEO:
Title: "${metadata.title}"
Channel: ${metadata.channelName}
Niche: ${creatorNiche}
Views: ${metadata.viewCount.toLocaleString()} | Likes: ${metadata.likeCount.toLocaleString()}
Engagement: ${metadata.engagementRate}%

FIRST 30 SECONDS TRANSCRIPT:
"${first30sTranscript || 'No transcript available'}"

FIRST 30 SECONDS VISUAL DATA:
${first30sFrameTypes}

Analyse the hook with brutal honesty. Rate how well the title/thumbnail promise is delivered in the first 30 seconds.

RESPOND ONLY with this exact JSON:
{
  "hookScore": <0-100>,
  "thumbnailTitleAlignment": <0-100>,
  "firstFrameStrength": "<one sentence: what the viewer sees first and if it works>",
  "firstThirtySeconds": "<2-3 sentence summary of what happens in first 30s>",
  "ariaVerdict": "<2-3 sentences: brutally honest take with India context>",
  "improvements": ["<specific fix 1 with timestamp>", "<specific fix 2>", "<specific fix 3>"]
}`;

  const res = await getAI().chat.completions.create({
    model: MODEL,
    max_tokens: 600,
    temperature: 0.4,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseJsonResponse<HookAnalysis>(res.choices[0]?.message?.content ?? '', {
    hookScore: 50,
    thumbnailTitleAlignment: 50,
    firstFrameStrength: 'Unable to analyse',
    firstThirtySeconds: 'Unable to analyse',
    ariaVerdict: 'Analysis failed — try uploading the video file directly.',
    improvements: [],
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 2: The Retention Architect
// Correlates heatmap drop-offs with audio/visual context at those timestamps
// ─────────────────────────────────────────────────────────────────────────────
export const runRetentionArchitect = async (
  metadata: MetadataStream,
  aural: AuralStream | null,
  visual: VisualStream | null,
  heatmap: HeatmapData,
  creatorArchetype: string,
): Promise<RetentionAnalysis> => {
  // Build rich context for each drop-off event
  const dropOffContexts = heatmap.dropOffTimestamps.slice(0, 5).map(ts => {
    const audioSeg = aural?.segments.find(s => s.start <= ts && s.end >= ts);
    const visualFrame = visual?.frames.reduce((best, f) =>
      Math.abs(f.timestamp - ts) < Math.abs(best.timestamp - ts) ? f : best,
      visual.frames[0] ?? { timestamp: 0, frameType: 'talking_head', energyScore: 0, ocrText: [], pointsOfInterest: [], isCutPoint: false }
    );
    return {
      ts,
      audioText: audioSeg?.text ?? 'No speech',
      audioSentiment: audioSeg?.sentiment ?? 'neutral',
      visualType: visualFrame?.frameType ?? 'unknown',
      visualEnergy: visualFrame?.energyScore ?? 50,
    };
  });

  const rewatchContexts = heatmap.rewatchTimestamps.slice(0, 3).map(ts => {
    const audioSeg = aural?.segments.find(s => s.start <= ts && s.end >= ts);
    return {
      ts,
      audioText: audioSeg?.text ?? 'No speech',
    };
  });

  const prompt = `You are ARIA's Retention Architect — you correlate viewer drop-off data with content quality.

VIDEO: "${metadata.title}" | ${metadata.channelName}
Duration: ${metadata.duration}s | Views: ${metadata.viewCount.toLocaleString()}
Creator Archetype: ${creatorArchetype}

HEATMAP ANALYSIS:
Average Retention Intensity: ${heatmap.avgIntensity}/100
Peak Moment Timestamp: ${heatmap.peakMoment}s

DROP-OFF EVENTS (where viewers left):
${dropOffContexts.map(d => `  - At ${d.ts}s: Audio="${d.audioText.slice(0, 80)}" | Visual=${d.visualType} (energy:${d.visualEnergy}) | Mood=${d.audioSentiment}`).join('\n') || '  No heatmap data available — provide general analysis'}

REWATCH EVENTS (where viewers rewound):
${rewatchContexts.map(r => `  - At ${r.ts}s: "${r.audioText.slice(0, 80)}"`).join('\n') || '  No rewatch data'}

Talking Head: ${visual?.talkingHeadPercent ?? 'N/A'}% | B-Roll: ${visual?.brollPercent ?? 'N/A'}%
Average Cut Frequency: ${visual?.avgCutFrequency ?? 'N/A'} cuts/sec

RESPOND ONLY with this exact JSON:
{
  "retentionScore": <0-100>,
  "dropOffEvents": [
    {
      "timestamp": <seconds>,
      "reason": "<specific reason why viewers left here>",
      "audioContext": "<what was being said>",
      "visualContext": "<what was on screen>",
      "fix": "<concrete 1-sentence fix for this exact moment>"
    }
  ],
  "rewatchEvents": [
    {
      "timestamp": <seconds>,
      "reason": "<why viewers rewound>",
      "whatWorked": "<what made this worth rewatching>"
    }
  ],
  "pacingVerdict": "<2-3 sentences on overall pacing with specific timestamp recommendations>",
  "talkingHeadWarning": <true if talking head % is too high for this archetype>
}`;

  const res = await getAI().chat.completions.create({
    model: MODEL,
    max_tokens: 900,
    temperature: 0.3,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseJsonResponse<RetentionAnalysis>(res.choices[0]?.message?.content ?? '', {
    retentionScore: 50,
    dropOffEvents: [],
    rewatchEvents: [],
    pacingVerdict: 'Retention analysis unavailable.',
    talkingHeadWarning: false,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 3: The SEO & Viral Strategist
// Keyword density, tag analysis, Shorts timestamp extraction
// ─────────────────────────────────────────────────────────────────────────────
export const runSeoViralStrategist = async (
  metadata: MetadataStream,
  aural: AuralStream | null,
  visual: VisualStream | null,
  heatmap: HeatmapData,
  creatorNiche: string,
): Promise<SeoViralAnalysis> => {
  const ocrKeywords = visual?.allOcrText.join(' ') ?? '';
  const transcriptSample = aural?.fullTranscript.slice(0, 2000) ?? '';
  const keyPhrases = aural?.keyPhrases.join(', ') ?? '';

  // Find high-energy moments (good Shorts candidates)
  const shortsWindowCandidates = visual?.highEnergyMoments
    .slice(0, 10)
    .map(ts => `${ts}s (energy peak)`)
    .join(', ') ?? '';

  const rewatchCandidates = heatmap.rewatchTimestamps
    .slice(0, 5)
    .map(ts => `${ts}s (rewatch peak)`)
    .join(', ') ?? '';

  const prompt = `You are ARIA's SEO & Viral Strategist — India's expert in YouTube growth.

VIDEO DATA:
Title: "${metadata.title}"
Description (first 300 chars): "${metadata.description.slice(0, 300)}"
Current Tags: ${metadata.tags.slice(0, 10).join(', ') || 'none'}
Niche: ${creatorNiche} | Category: ${metadata.categoryId}
Duration: ${metadata.duration}s

CONTENT INTELLIGENCE:
Key Phrases in Transcript: ${keyPhrases || 'N/A'}
On-Screen Text (OCR): "${ocrKeywords.slice(0, 200) || 'N/A'}"
High Energy Moments: ${shortsWindowCandidates || 'N/A'}
Rewatch Peaks (best Shorts candidates): ${rewatchCandidates || 'N/A'}

PERFORMANCE: ${metadata.viewCount.toLocaleString()} views | ${metadata.engagementRate}% engagement

RESPOND ONLY with this exact JSON:
{
  "seoScore": <0-100>,
  "keywordDensity": { "<keyword>": <count>, "<keyword>": <count> },
  "missingKeywords": ["<keyword that should be in title/desc but isn't>"],
  "titleOptimization": "<rewritten title that would perform 20-30% better — keep creator's intent>",
  "descriptionOptimization": "<first 125 chars of an improved description>",
  "tagSuggestions": ["<tag1>", "<tag2>", "<tag3>", "<tag4>", "<tag5>"],
  "shortsTimestamps": [
    {
      "start": <seconds>,
      "end": <seconds — max 60s window>,
      "caption": "<pre-written Shorts/Reels caption with 3 hashtags>",
      "viralScore": <0-100>,
      "reason": "<why this segment will perform as a Short>"
    }
  ]
}

Return 3-5 shortsTimestamps. Prioritise rewatch peaks and high-energy moments. Use Indian creator economy context.`;

  const res = await getAI().chat.completions.create({
    model: MODEL,
    max_tokens: 1000,
    temperature: 0.5,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseJsonResponse<SeoViralAnalysis>(res.choices[0]?.message?.content ?? '', {
    seoScore: 50,
    keywordDensity: {},
    missingKeywords: [],
    titleOptimization: metadata.title,
    descriptionOptimization: '',
    tagSuggestions: [],
    shortsTimestamps: [],
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 4: The Semantic Router (Value Density)
// Filters fluff, creates cheat sheet, measures information density
// ─────────────────────────────────────────────────────────────────────────────
export const runSemanticRouter = async (
  metadata: MetadataStream,
  aural: AuralStream | null,
  creatorNiche: string,
): Promise<ValueDensityAnalysis> => {
  const transcript = aural?.fullTranscript.slice(0, 3000) ?? '';
  const sentimentArc = aural?.sentimentFlux
    .filter((_, i) => i % 3 === 0) // sample every 3rd
    .map(s => `${s.timestamp}s:${s.sentiment}`)
    .join(', ') ?? '';

  const prompt = `You are ARIA's Semantic Router — you measure how much real value a video delivers vs how much is filler.

VIDEO: "${metadata.title}"
Niche: ${creatorNiche} | Duration: ${metadata.duration}s

FULL TRANSCRIPT:
"${transcript || 'No transcript available'}"

SENTIMENT ARC (timestamp:sentiment):
${sentimentArc || 'N/A'}

Analyse this video for INFORMATION DENSITY. Identify fluff segments (intros, outros, sponsor reads, tangents) vs value segments (actual useful content).

RESPOND ONLY with this exact JSON:
{
  "valueDensityScore": <0-100, 100=every second is pure value>,
  "fluffTimestamps": [<seconds where filler begins>],
  "cheatSheet": [
    { "point": "<key insight or fact from the video — must be genuinely useful>", "timestamp": <seconds> }
  ],
  "contentSummary": "<3 sentences: what this video is actually about, no fluff>",
  "uniqueInsights": ["<something genuinely novel in this video vs typical content>"],
  "actionableCount": <number of actionable takeaways in the video>
}

Return 5-8 cheat sheet points. Be brutally honest about value density.`;

  const res = await getAI().chat.completions.create({
    model: MODEL,
    max_tokens: 800,
    temperature: 0.3,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseJsonResponse<ValueDensityAnalysis>(res.choices[0]?.message?.content ?? '', {
    valueDensityScore: 50,
    fluffTimestamps: [],
    cheatSheet: [],
    contentSummary: 'Analysis unavailable.',
    uniqueInsights: [],
    actionableCount: 0,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Safe JSON parse with fallback
// ─────────────────────────────────────────────────────────────────────────────
const parseJsonResponse = <T>(raw: string, fallback: T): T => {
  try {
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return fallback;
  }
};
