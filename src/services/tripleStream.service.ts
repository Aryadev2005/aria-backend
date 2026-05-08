import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';
import type {
  AuralStream, VisualStream, FrameAnalysis, SpeakerSegment,
} from '../types/videoIntelligence.types';

const execFileAsync = promisify(execFile);

let _openai: OpenAI | null = null;
const getAI = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!_openai) _openai = new OpenAI({ apiKey, timeout: 60_000 });
  return _openai;
};

const VISION_MODEL   = process.env.VISION_MODEL   || 'gpt-4o';
const WHISPER_MODEL  = 'whisper-1';
const FRAME_INTERVAL = 4; // seconds between sampled frames

// ─────────────────────────────────────────────────────────────────────────────
// STREAM A: Aural Processing (Whisper + Sentiment Flux)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if FFmpeg is available
 */
const checkFFmpeg = async (): Promise<boolean> => {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

/**
 * Extract audio from video file and return mp3 path.
 */
const extractAudio = async (videoPath: string, outputDir: string): Promise<string | null> => {
  const ffmpegAvailable = await checkFFmpeg();
  if (!ffmpegAvailable) {
    logger.warn('FFmpeg not available — skipping audio extraction');
    return null;
  }

  const audioPath = path.join(outputDir, 'audio.mp3');
  try {
    await execFileAsync('ffmpeg', [
      '-i', videoPath, '-q:a', '0', '-map', 'a',
      '-ar', '16000', '-ac', '1',
      audioPath, '-y',
    ], { timeout: 60_000 });
    return fs.existsSync(audioPath) ? audioPath : null;
  } catch (err) {
    logger.warn({ err }, 'Audio extraction failed');
    return null;
  }
};

/**
 * Transcribe audio with Whisper, then compute sentiment flux over time windows.
 */
export const processAuralStream = async (
  videoPath: string,
  outputDir: string,
  durationSeconds: number,
): Promise<AuralStream | null> => {
  const audioPath = await extractAudio(videoPath, outputDir);
  if (!audioPath) return null;

  try {
    const ai = getAI();

    // Whisper transcription with verbose_json for timestamps
    const transcription = await ai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: WHISPER_MODEL,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    }) as any;

    const segments = transcription.segments ?? [];
    const fullText = transcription.text ?? '';

    // Sentiment analysis over each segment
    const sentimentFlux: AuralStream['sentimentFlux'] = [];
    const speakerSegments: SpeakerSegment[] = [];

    // Batch sentiment for all segments in one prompt
    if (segments.length > 0) {
      const batchPrompt = `Analyse the sentiment of each transcript segment. Return ONLY a JSON array with one object per segment in this exact format:
[{"index":0,"sentiment":"positive","score":0.7},...]

Segments:
${segments.map((s: any, i: number) => `${i}: "${s.text?.trim()}"`).join('\n')}`;

      try {
        const sentRes = await ai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          max_tokens: 800,
          temperature: 0,
          messages: [{ role: 'user', content: batchPrompt }],
        });
        const raw = sentRes.choices[0]?.message?.content ?? '[]';
        const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const sentiments: Array<{ index: number; sentiment: string; score: number }> = JSON.parse(clean);

        segments.forEach((seg: any, i: number) => {
          const sdata = sentiments[i] ?? { sentiment: 'neutral', score: 0 };
          speakerSegments.push({
            speaker: 'SPEAKER_00', // single speaker default; diarization needs pyannote
            start: seg.start,
            end: seg.end,
            text: seg.text?.trim() ?? '',
            sentiment: sdata.sentiment as any,
            sentimentScore: sdata.score,
          });
          sentimentFlux.push({
            timestamp: seg.start,
            sentiment: sdata.sentiment,
            score: sdata.score,
          });
        });
      } catch (_) {
        // Fallback: neutral sentiment
        segments.forEach((seg: any) => {
          speakerSegments.push({
            speaker: 'SPEAKER_00',
            start: seg.start,
            end: seg.end,
            text: seg.text?.trim() ?? '',
            sentiment: 'neutral',
            sentimentScore: 0,
          });
          sentimentFlux.push({ timestamp: seg.start, sentiment: 'neutral', score: 0 });
        });
      }
    }

    // Extract key phrases
    const keyPhrases = extractKeyPhrases(fullText);
    const wordCount = fullText.split(/\s+/).filter(Boolean).length;
    const wordsPerMinute = durationSeconds > 0 ? Math.round((wordCount / durationSeconds) * 60) : 0;

    return {
      fullTranscript: fullText,
      segments: speakerSegments,
      speakerCount: 1,
      sentimentFlux,
      keyPhrases,
      wordCount,
      wordsPerMinute,
    };

  } catch (err: any) {
    logger.warn({ err: err.message }, 'Aural stream processing failed');
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STREAM B: Visual Processing (GPT-4o Vision)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract frames from video at regular intervals, return paths.
 */
const extractFrames = async (
  videoPath: string,
  outputDir: string,
  durationSeconds: number,
): Promise<Array<{ path: string; timestamp: number }>> => {
  const ffmpegAvailable = await checkFFmpeg();
  if (!ffmpegAvailable) {
    logger.warn('FFmpeg not available — skipping frame extraction');
    return [];
  }

  const frames: Array<{ path: string; timestamp: number }> = [];
  const maxFrames = Math.min(30, Math.ceil(durationSeconds / FRAME_INTERVAL));

  const timestamps = Array.from({ length: maxFrames }, (_, i) =>
    Math.round((i / (maxFrames - 1)) * durationSeconds),
  );

  for (const ts of timestamps) {
    const framePath = path.join(outputDir, `frame_${ts}.jpg`);
    try {
      await execFileAsync('ffmpeg', [
        '-ss', String(ts), '-i', videoPath,
        '-vframes', '1', '-q:v', '3',
        '-vf', 'scale=640:-2',
        framePath, '-y',
      ], { timeout: 10_000 });
      if (fs.existsSync(framePath)) {
        frames.push({ path: framePath, timestamp: ts });
      }
    } catch (_) {
      // Skip failed frames
    }
  }

  return frames;
};

/**
 * Encode image file to base64 for OpenAI vision.
 */
const toBase64 = (filePath: string): string =>
  fs.readFileSync(filePath).toString('base64');

/**
 * Analyse a batch of frames with GPT-4o vision for OCR, frame type, and energy.
 * We batch 5 frames per API call to stay efficient.
 */
const analyseFrameBatch = async (
  frames: Array<{ path: string; timestamp: number }>,
): Promise<FrameAnalysis[]> => {
  if (frames.length === 0) return [];

  const ai = getAI();
  const BATCH_SIZE = 5;
  const results: FrameAnalysis[] = [];

  for (let i = 0; i < frames.length; i += BATCH_SIZE) {
    const batch = frames.slice(i, i + BATCH_SIZE);

    const imageContent: any[] = [];
    for (const f of batch) {
      imageContent.push({
        type: 'text',
        text: `Frame at ${f.timestamp}s:`,
      });
      imageContent.push({
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${toBase64(f.path)}`,
          detail: 'low',
        },
      });
    }

    const systemPrompt = `You are a video frame analyser. For each frame, return ONLY a JSON array:
[{
  "timestamp": <seconds>,
  "frameType": "talking_head"|"broll"|"screen_recording"|"text_overlay"|"product_shot",
  "ocrText": ["text visible on screen"],
  "pointsOfInterest": ["specific products, graphics, notable elements"],
  "energyScore": <0-100>,
  "isCutPoint": <true if this looks like a new scene>
}]
Return ONLY the JSON array, no markdown.`;

    try {
      const res = await ai.chat.completions.create({
        model: VISION_MODEL,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: imageContent },
        ],
      });

      const raw = res.choices[0]?.message?.content ?? '[]';
      const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed: FrameAnalysis[] = JSON.parse(clean);
      results.push(...parsed);
    } catch (err) {
      // Fallback: basic entries for failed batch
      batch.forEach(f => {
        results.push({
          timestamp: f.timestamp,
          frameType: 'talking_head',
          ocrText: [],
          pointsOfInterest: [],
          energyScore: 50,
          isCutPoint: false,
        });
      });
    }
  }

  return results;
};

/**
 * Full visual stream processing.
 */
export const processVisualStream = async (
  videoPath: string,
  outputDir: string,
  durationSeconds: number,
): Promise<VisualStream | null> => {
  try {
    const frameFiles = await extractFrames(videoPath, outputDir, durationSeconds);
    if (frameFiles.length === 0) return null;

    const frames = await analyseFrameBatch(frameFiles);

    const talkingHeadCount = frames.filter(f => f.frameType === 'talking_head').length;
    const brollCount = frames.filter(f => f.frameType === 'broll').length;
    const total = frames.length || 1;

    const cutPoints = frames.filter(f => f.isCutPoint).length;
    const avgCutFrequency = durationSeconds > 0 ? parseFloat((cutPoints / durationSeconds).toFixed(3)) : 0;

    const highEnergyMoments = frames
      .filter(f => f.energyScore >= 75)
      .map(f => f.timestamp);

    const allOcrText = [...new Set(frames.flatMap(f => f.ocrText))];
    const productMentions = [...new Set(frames.flatMap(f => f.pointsOfInterest))];

    return {
      frames,
      talkingHeadPercent: Math.round((talkingHeadCount / total) * 100),
      brollPercent: Math.round((brollCount / total) * 100),
      avgCutFrequency,
      highEnergyMoments,
      allOcrText,
      productMentions,
    };

  } catch (err: any) {
    logger.warn({ err: err.message }, 'Visual stream processing failed');
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','is','was','are','were','be','been','has','have','had','do','does','did','will','would','could','should','may','might','can','this','that','these','those','i','you','he','she','we','they','it','its','my','your','our','their']);

export const extractKeyPhrases = (text: string): string[] => {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  const freq: Record<string, number> = {};
  words.filter(w => w.length > 3 && !STOP_WORDS.has(w)).forEach(w => {
    freq[w] = (freq[w] ?? 0) + 1;
  });
  return Object.entries(freq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([w]) => w);
};
