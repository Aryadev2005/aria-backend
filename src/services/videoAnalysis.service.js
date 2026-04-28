// src/services/videoAnalysis.service.js
// ARIA Video Analysis — after the creator edits their video
// Frame extraction + audio transcription + full AI analysis
'use strict';

const Groq       = require('groq-sdk');
const axios      = require('axios');
const path       = require('path');
const fs         = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { logger } = require('../utils/logger');

const execFileAsync = promisify(execFile);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Check if FFmpeg is available ────────────────────────────────────────────
const checkFFmpeg = async () => {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

// ─── Extract key frames from video ───────────────────────────────────────────
// Extracts frames at 0s, 3s, 10s, mid, end for hook + pacing analysis
const extractFrames = async (videoPath, outputDir) => {
  const ffmpegAvailable = await checkFFmpeg();
  if (!ffmpegAvailable) {
    logger.warn('FFmpeg not available — skipping frame extraction');
    return [];
  }

  try {
    fs.mkdirSync(outputDir, { recursive: true });

    // Get video duration first
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format',
      videoPath,
    ], { timeout: 15000 });

    const info     = JSON.parse(stdout);
    const duration = parseFloat(info.format?.duration || '30');

    // Extract at: 0s (hook), 3s (hook end), mid, 80% (pre-CTA), last 2s (CTA)
    const timestamps = [
      0,
      Math.min(3, duration * 0.1),
      duration * 0.3,
      duration * 0.6,
      duration * 0.8,
      Math.max(0, duration - 2),
    ].map(t => t.toFixed(1));

    const frames = [];
    for (const ts of timestamps) {
      const outPath = path.join(outputDir, `frame_${ts}s.jpg`);
      try {
        await execFileAsync('ffmpeg', [
          '-ss', ts, '-i', videoPath,
          '-vframes', '1', '-q:v', '3',
          outPath, '-y',
        ], { timeout: 15000 });
        if (fs.existsSync(outPath)) {
          frames.push({ timestamp: parseFloat(ts), path: outPath });
        }
      } catch { /* skip failed frame */ }
    }

    logger.info({ count: frames.length }, 'Frames extracted');
    return frames;
  } catch (err) {
    logger.warn({ err }, 'Frame extraction failed');
    return [];
  }
};

// ─── Extract audio and transcribe ────────────────────────────────────────────
const transcribeAudio = async (videoPath, outputDir) => {
  const ffmpegAvailable = await checkFFmpeg();
  if (!ffmpegAvailable) return null;

  try {
    const audioPath = path.join(outputDir, 'audio.mp3');

    await execFileAsync('ffmpeg', [
      '-i', videoPath, '-q:a', '0', '-map', 'a',
      audioPath, '-y',
    ], { timeout: 30000 });

    if (!fs.existsSync(audioPath)) return null;

    // Use Groq Whisper for transcription
    const audioStream = fs.createReadStream(audioPath);
    const transcription = await groq.audio.transcriptions.create({
      file:  audioStream,
      model: 'whisper-large-v3',
    });

    logger.info('Audio transcribed successfully');
    return transcription.text;
  } catch (err) {
    logger.warn({ err }, 'Transcription failed');
    return null;
  }
};

// ─── Analyse frames with vision (text-based if no vision model) ──────────────
const analyseFramesTextBased = async (frameTimestamps, transcription, videoMeta) => {
  // Since we may not always have vision model access,
  // we do a thorough text-based analysis using transcription + metadata
  const prompt = `You are ARIA — India's expert video analyst.

Analyse this creator's video content for the Indian creator economy.

VIDEO METADATA:
- Duration: ${videoMeta.duration}s
- Platform: ${videoMeta.platform}
- Niche: ${videoMeta.niche}
- Archetype: ${videoMeta.archetype}
- Intended mood: ${videoMeta.mood || 'not specified'}

TRANSCRIPTION:
"${transcription || 'No speech detected or transcription unavailable'}"

FRAME TIMESTAMPS EXTRACTED: ${frameTimestamps.join(', ')}s

Analyse this video like a professional editor and creator coach.
Be specific about timestamps. Be direct. Give actionable fixes.

Respond ONLY with valid JSON:
{
  "overallScore": 74,
  "grade": "B+",
  "verdict": "One sentence honest verdict on this video",
  "hookAnalysis": {
    "score": 80,
    "firstLineWords": "First words from transcription",
    "verdict": "strong|decent|weak",
    "issue": "Specific issue with hook or null",
    "fix": "Exact rewrite of the hook if needed"
  },
  "pacingAnalysis": {
    "score": 70,
    "verdict": "Good pacing|Too slow|Too fast|Uneven",
    "slowestSection": "Describe where it drags (timestamp range)",
    "fix": "Specific edit to improve pacing"
  },
  "scriptAnalysis": {
    "score": 75,
    "strongestLine": "Best line from the transcription",
    "weakestSection": "Part that loses attention",
    "ctaPresent": true,
    "ctaStrength": "strong|decent|weak|missing",
    "ctaFix": "Better CTA if needed"
  },
  "audienceRetentionPrediction": {
    "estimatedCompletion": 65,
    "dropOffPoint": "Viewers likely drop at around Xs because...",
    "retentionTip": "Specific fix to improve completion rate"
  },
  "specificFixes": [
    {
      "timestamp": "0:00-0:03",
      "issue": "Specific problem at this timestamp",
      "fix": "Exact fix — what to cut, change, or add",
      "priority": "high|medium|low"
    }
  ],
  "whatWorked": [
    "Specific thing that worked well in this video"
  ],
  "topPriorityFix": "The single most impactful change to make right now",
  "repostWorthy": true,
  "estimatedReach": "20K-60K views with current version",
  "estimatedReachAfterFixes": "60K-150K views after implementing top fix"
}`;

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1200,
    temperature: 0.65,
    messages: [{ role: 'user', content: prompt }],
  });

  const text  = res.choices[0].message.content;
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
};

// ─── Analyse video from URL (Instagram/YouTube link) ─────────────────────────
const analyseFromUrl = async ({ url, platform, niche, archetype, mood }) => {
  // For URL-based analysis, we do a content-aware analysis
  // based on the URL metadata without downloading the video
  const prompt = `You are ARIA — India's expert video analyst.

A creator shared this video link for analysis: ${url}
Platform: ${platform} | Niche: ${niche} | Archetype: ${archetype}

Since this is a URL submission, provide analysis guidance and what to look for
when the creator watches their own video. Give a framework for self-analysis.

Respond ONLY with valid JSON:
{
  "analysisType": "url_guided",
  "selfAnalysisChecklist": [
    {
      "aspect": "Hook (0-3 seconds)",
      "question": "Does your first frame have movement or text that stops the scroll?",
      "ariaAdvice": "If not, this is your #1 fix. Re-shoot the opening."
    },
    {
      "aspect": "Pacing",
      "question": "Watch without sound. Does it hold your attention every 3 seconds?",
      "ariaAdvice": "If you get bored at any point, your audience will too. Mark that timestamp."
    },
    {
      "aspect": "Audio sync",
      "question": "Does the beat drop / music peak align with your best visual moment?",
      "ariaAdvice": "Re-edit your clips to hit the musical peak. This doubles saves."
    },
    {
      "aspect": "Text overlays",
      "question": "Can someone understand your video with the sound off?",
      "ariaAdvice": "60% of Reels are watched on mute. Add captions if missing."
    },
    {
      "aspect": "CTA",
      "question": "Does your last 3 seconds have a clear ask?",
      "ariaAdvice": "Don't end on music. End with your face saying one specific thing."
    }
  ],
  "topTipForThisNiche": "Specific tip for ${niche} creators on ${platform}",
  "uploadForDeepAnalysis": "Upload the video file directly for ARIA's full AI analysis with timestamps"
}`;

  const res = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 800,
    temperature: 0.65,
    messages: [{ role: 'user', content: prompt }],
  });

  const text  = res.choices[0].message.content;
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
};

// ─── Main analysis function ───────────────────────────────────────────────────
const analyseVideo = async ({
  videoPath,    // local file path (if uploaded)
  videoUrl,     // URL (if link provided)
  platform, niche, archetype, mood,
  userId,
}) => {
  logger.info({ userId, hasFile: !!videoPath, hasUrl: !!videoUrl }, 'Video analysis started');

  // URL-based analysis (lighter weight)
  if (videoUrl && !videoPath) {
    const result = await analyseFromUrl({ url: videoUrl, platform, niche, archetype, mood });
    return { ...result, analysisType: 'url_guided' };
  }

  // File-based deep analysis
  if (videoPath) {
    const outputDir = path.join('/tmp', `aria_analysis_${userId}_${Date.now()}`);

    try {
      // Get video duration
      let duration = 30;
      try {
        const { stdout } = await execFileAsync('ffprobe', [
          '-v', 'quiet', '-print_format', 'json', '-show_format',
          videoPath,
        ], { timeout: 10000 });
        const info = JSON.parse(stdout);
        duration = parseFloat(info.format?.duration || '30');
      } catch { /* use default */ }

      // Extract frames and transcribe in parallel
      const [frames, transcription] = await Promise.all([
        extractFrames(videoPath, outputDir),
        transcribeAudio(videoPath, outputDir),
      ]);

      const frameTimestamps = frames.map(f => f.timestamp);

      // Full AI analysis
      const analysis = await analyseFramesTextBased(
        frameTimestamps,
        transcription,
        { duration, platform, niche, archetype, mood }
      );

      // Cleanup temp files
      try {
        fs.rmSync(outputDir, { recursive: true, force: true });
      } catch { /* ignore cleanup errors */ }

      return {
        ...analysis,
        analysisType:  'deep',
        duration,
        hasTranscription: !!transcription,
        framesAnalysed: frames.length,
      };

    } catch (err) {
      logger.error({ err }, 'Deep video analysis failed');
      // Fall back to guided analysis
      return {
        analysisType: 'fallback',
        error: 'Could not process video file. Try a shorter clip or paste your video URL.',
        verdict: 'Upload failed — see self-analysis checklist below',
        selfAnalysisChecklist: [],
      };
    }
  }

  throw new Error('Either videoPath or videoUrl is required');
};

module.exports = { analyseVideo, analyseFromUrl };
