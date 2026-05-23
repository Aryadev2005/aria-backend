// ── Thumbnail Vision Analysis Service ──────────────────────────────────
// Analyzes thumbnails using GPT-4o vision, generates variants, and scores against titles

import { OpenAI } from 'openai';
import { ThumbnailVisionAnalysis, ThumbnailVariant } from '../types/thumbnail.types';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';

// ── OpenAI Client Singleton ────────────────────────────────────────────────────
let _openai: OpenAI | null = null;

const getAI = () => {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY?.trim(),
      timeout: 30_000,
    });
  }
  return _openai;
};

// ── 1. Thumbnail Vision Analysis ───────────────────────────────────────────────

/**
 * Analyzes a thumbnail image using GPT-4o vision model.
 *
 * Detects text, faces, colors, emotional signals, and clutter to produce
 * structured ThumbnailVisionAnalysis. Results cached for 24 hours.
 *
 * @param thumbnailUrl - Direct URL to thumbnail image (supports http/https)
 * @param videoTitle - Video title for titleSync evaluation
 * @param niche - Creator's niche for context-aware scoring
 * @returns ThumbnailVisionAnalysis if successful, null if vision call fails
 *
 * @example
 * const analysis = await analyzeThumbnailVision(
 *   'https://i.ytimg.com/vi/abc123/maxresdefault.jpg',
 *   'How I Made $10K in 1 Week',
 *   'entrepreneurship'
 * );
 */
export async function analyzeThumbnailVision(
  thumbnailUrl: string,
  videoTitle: string,
  niche: string,
): Promise<ThumbnailVisionAnalysis | null> {
  try {
    // Generate cache key from last 40 chars of URL to avoid excessive key length
    const cacheKey = `thumb_vision:${thumbnailUrl.substring(
      Math.max(0, thumbnailUrl.length - 40),
    )}`;

    // Check cache first (24-hour TTL)
    const cached = await cache.get(cacheKey);
    if (cached) {
      logger.debug(`[ThumbnailVision] Cache hit for ${cacheKey}`);
      return JSON.parse(cached) as ThumbnailVisionAnalysis;
    }

    logger.debug(`[ThumbnailVision] Analyzing thumbnail: ${thumbnailUrl}`);

    const client = getAI();

    // System prompt establishes role and expectations
    const systemPrompt = `You are ARIA's thumbnail analyst. Analyze this YouTube/Instagram thumbnail image with expert precision.

Focus on:
- Text legibility and size appropriateness for mobile viewers
- Emotional impact and viewer engagement potential
- Visual hierarchy and focal point
- Clutter level (1-5: 1=minimalist, 5=chaotic)
- Face detection and expression analysis
- Color psychology and palette consistency
- How well the thumbnail matches the video title promise
- Common Indian YouTube patterns (arrows, circles, highlighting)
- Brand consistency indicators

Return ONLY valid JSON with no markdown formatting, no code blocks, no explanations.`;

    // User prompt includes context for scoring accuracy
    const userPrompt = `Video Title: "${videoTitle}"
Creator Niche: "${niche}"

Analyze this thumbnail and return a JSON object matching this exact structure:
{
  "hasText": boolean,
  "textContent": ["word1", "word2", ...],
  "dominantColors": ["#HEX1", "#HEX2", "#HEX3"],
  "faceDetected": boolean,
  "faceCount": number (0-5),
  "expressionType": "shock" | "smile" | "serious" | "none" | "other",
  "clutter": number (1-5),
  "titleSync": number (1-10),
  "emotionalValence": "positive" | "negative" | "neutral",
  "arrowOrCircle": boolean,
  "brandConsistency": number (1-5),
  "analysisConfidence": number (0-1),
  "issues": ["issue1", "issue2", ...],
  "strengths": ["strength1", "strength2", ...]
}`;

    // Call GPT-4o vision with image URL
    const response = await client.messages.create({
      model: 'gpt-4o',
      max_tokens: 600,
      temperature: 0.1, // Near-deterministic for consistency
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'url',
                url: thumbnailUrl,
              },
            },
            {
              type: 'text',
              text: userPrompt,
            },
          ],
        },
      ],
    });

    // Extract text response
    const textContent = response.content.find((block) => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      logger.warn('[ThumbnailVision] No text response from vision model');
      return null;
    }

    // Parse JSON response
    let analysis: ThumbnailVisionAnalysis;
    try {
      analysis = JSON.parse(textContent.text);
    } catch (parseError) {
      logger.warn(
        `[ThumbnailVision] JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      );
      return null;
    }

    // Validate critical fields exist
    if (
      !('clutter' in analysis) ||
      !('titleSync' in analysis) ||
      !('faceDetected' in analysis)
    ) {
      logger.warn('[ThumbnailVision] Missing critical fields in analysis');
      return null;
    }

    // Cache for 24 hours (86400 seconds)
    await cache.set(cacheKey, JSON.stringify(analysis), 86400);

    logger.debug(`[ThumbnailVision] Analysis complete, cached for 24h`);
    return analysis;
  } catch (error) {
    // Log error but return null — never break parent flow
    logger.warn(
      `[ThumbnailVision] Vision analysis failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

// ── 2. Thumbnail Variant Generation ────────────────────────────────────────────

/**
 * Generates 3 distinct thumbnail variant concepts using GPT-4o-mini JSON mode.
 *
 * Creates conceptually different designs (text-heavy, face-focused, minimal/mystery)
 * with distinct color palettes and DALL-E-ready image prompts.
 *
 * @param params - Generation parameters
 * @param params.hookLine - Hook text from script (e.g., "How I Made $10K")
 * @param params.idea - Video idea/concept description
 * @param params.niche - Creator's niche
 * @param params.platform - 'instagram' | 'youtube'
 * @param params.archetype - Creator archetype (e.g., "STORYTELLER")
 * @param params.toneSignature - Optional voice tone descriptor
 * @returns Array of 3 ThumbnailVariant objects (or 2 if generation fails)
 *
 * @example
 * const variants = await generateThumbnailVariants({
 *   hookLine: 'How I Made $10K',
 *   idea: 'Entrepreneur sharing profit breakdown',
 *   niche: 'entrepreneurship',
 *   platform: 'youtube',
 *   archetype: 'ENTREPRENEUR',
 *   toneSignature: 'confident, inspiring'
 * });
 */
export async function generateThumbnailVariants(params: {
  hookLine: string;
  idea: string;
  niche: string;
  platform: 'instagram' | 'youtube';
  archetype: string;
  toneSignature?: string;
}): Promise<ThumbnailVariant[]> {
  try {
    logger.debug(
      `[ThumbnailVariants] Generating variants for hook: "${params.hookLine}"`,
    );

    const client = getAI();

    const systemPrompt = `You are ARIA's thumbnail designer. Generate 3 completely distinct, high-performing thumbnail variant concepts.

Each variant must have:
1. A unique visual approach (not just color changes)
2. DALL-E 3 compatible image prompt (max 400 chars, no real faces, no copyrighted content)
3. Distinct color psychology
4. Culturally relevant design principles for Indian creators

Return ONLY a JSON object with this exact structure:
{
  "variants": [
    {
      "id": "a",
      "concept": "one-sentence description of the visual concept",
      "colorPalette": ["#HEX1", "#HEX2", "#HEX3"],
      "textOverlay": "main text that appears on thumbnail",
      "hookLine": "hook from script",
      "imagePrompt": "DALL-E 3 prompt (max 400 chars)",
      "rationale": "why this variant works"
    },
    ...
  ]
}

No markdown, no code blocks, no extra text.`;

    const userPrompt = `Hook: "${params.hookLine}"
Idea: ${params.idea}
Niche: ${params.niche}
Platform: ${params.platform}
Creator Archetype: ${params.archetype}
Tone: ${params.toneSignature || 'neutral'}

Generate 3 COMPLETELY different approaches:
- Variant A: Bold, text-heavy design with large emotional words
- Variant B: Face/emotion focused (animated character or expression mockup, no real people)
- Variant C: Curiosity/mystery minimal design with intrigue elements

Each must be visually distinct, culturally appropriate, and high-CTR potential.`;

    const response = await client.messages.create({
      model: 'gpt-4o-mini',
      max_tokens: 1200,
      temperature: 0.7, // More creative for ideation
      messages: [
        {
          role: 'user',
          content: systemPrompt + '\n\n' + userPrompt,
        },
      ],
    });

    const textContent = response.content.find((block) => block.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      logger.warn('[ThumbnailVariants] No text response from generation model');
      return getFallbackVariants(params.hookLine);
    }

    // Parse JSON response
    let parsedResponse: { variants: ThumbnailVariant[] };
    try {
      parsedResponse = JSON.parse(textContent.text);
    } catch (parseError) {
      logger.warn(
        `[ThumbnailVariants] Initial JSON parse failed: ${parseError instanceof Error ? parseError.message : String(parseError)}. Attempting cleanup.`,
      );

      // Retry once with cleanup attempt
      try {
        const cleaned = textContent.text.replace(/```json\n?|\n?```/g, '').trim();
        parsedResponse = JSON.parse(cleaned);
      } catch (cleanupError) {
        logger.warn('[ThumbnailVariants] Cleanup retry failed, using fallbacks');
        return getFallbackVariants(params.hookLine);
      }
    }

    // Validate structure
    if (!Array.isArray(parsedResponse.variants) || parsedResponse.variants.length === 0) {
      logger.warn('[ThumbnailVariants] Invalid variants structure');
      return getFallbackVariants(params.hookLine);
    }

    // Ensure we have 3 variants, filter out invalid ones
    const validVariants = parsedResponse.variants
      .filter(
        (v) =>
          v.id &&
          v.concept &&
          Array.isArray(v.colorPalette) &&
          v.textOverlay &&
          v.hookLine &&
          v.imagePrompt &&
          v.rationale,
      )
      .slice(0, 3) as ThumbnailVariant[];

    if (validVariants.length === 0) {
      logger.warn('[ThumbnailVariants] No valid variants after validation');
      return getFallbackVariants(params.hookLine);
    }

    // If we have fewer than 3 valid variants, pad with fallbacks
    if (validVariants.length < 3) {
      logger.debug(
        `[ThumbnailVariants] Only ${validVariants.length} valid variants, using fallbacks for remainder`,
      );
      const fallbacks = getFallbackVariants(params.hookLine);
      return [...validVariants, ...fallbacks.slice(validVariants.length)];
    }

    logger.debug(`[ThumbnailVariants] Successfully generated 3 variants`);
    return validVariants;
  } catch (error) {
    logger.warn(
      `[ThumbnailVariants] Generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return getFallbackVariants(params.hookLine);
  }
}

/**
 * Fallback thumbnail variants used when generation fails.
 * These are safe, culturally appropriate templates.
 *
 * @param hookLine - Hook text to use in variants
 * @returns Array of 2-3 ThumbnailVariant objects
 */
function getFallbackVariants(hookLine: string): ThumbnailVariant[] {
  return [
    {
      id: 'a',
      concept: 'Bold text-heavy design with high contrast',
      colorPalette: ['#FF6B35', '#FFFFFF', '#1A1A1A'],
      textOverlay: hookLine,
      hookLine: hookLine,
      imagePrompt:
        'Clean, bold background with large typography. High contrast design suitable for YouTube thumbnails. Modern gradient background in orange and white.',
      rationale:
        'Text-dominant approach maximizes hook visibility on small screens. Bold colors ensure mobile legibility.',
    },
    {
      id: 'b',
      concept: 'Expressive character focus with emotional gesture',
      colorPalette: ['#00D4FF', '#FFB700', '#2A2A2A'],
      textOverlay: hookLine,
      hookLine: hookLine,
      imagePrompt:
        'Illustration of an animated character with an amazed or shocked expression. Bright background, arrow pointing up. Cartoon style, no photorealism.',
      rationale:
        'Face/expression focus drives emotional engagement. Animated character avoids real-face copyright issues. Motion arrow adds intrigue.',
    },
    {
      id: 'c',
      concept: 'Minimal curiosity design with mystery element',
      colorPalette: ['#1A1A1A', '#00D4FF', '#FFB700'],
      textOverlay: hookLine,
      hookLine: hookLine,
      imagePrompt:
        'Minimalist design with selective color highlights. Question mark or curiosity symbol. Dark background with neon accent colors. Geometric shapes.',
      rationale:
        'Minimal approach reduces clutter while maintaining brand consistency. Mystery element encourages clicks.',
    },
  ];
}

// ── 3. Vision-Derived Score Calculation ────────────────────────────────────────

/**
 * Converts ThumbnailVisionAnalysis into RawSignals-compatible scores.
 *
 * This is pure, deterministic math — no AI involved. Takes vision analysis
 * results and produces the exact scores needed to override/augment RawSignals:
 * - thumbnailTitleSync (1–10): how well thumbnail matches video title
 * - thumbnailClutter (1–5): visual complexity and information density
 *
 * @param analysis - ThumbnailVisionAnalysis from vision model
 * @returns Object with thumbnailTitleSync and thumbnailClutter scores
 *
 * @example
 * const scores = scoreThumbnailFromVision(analysis);
 * // { thumbnailTitleSync: 8, thumbnailClutter: 2 }
 */
export function scoreThumbnailFromVision(
  analysis: ThumbnailVisionAnalysis,
): { thumbnailTitleSync: number; thumbnailClutter: number } {
  // ── Score 1: thumbnailTitleSync (1–10) ─────────────────────────────────────
  // Measures how well thumbnail visual promise matches video title
  let titleSync = 5; // baseline neutral

  // Text content matching title keywords
  if (
    analysis.textContent &&
    analysis.textContent.length > 0 &&
    analysis.hasText
  ) {
    titleSync += 2; // Text clearly visible and relevant
  }

  // Emotional valence alignment
  if (
    analysis.emotionalValence === 'positive' ||
    analysis.emotionalValence === 'negative'
  ) {
    titleSync += 1; // Strong emotional signal
  }

  // Face expression boosts title sync if it reinforces the hook
  if (
    analysis.faceDetected &&
    (analysis.expressionType === 'shock' || analysis.expressionType === 'smile')
  ) {
    titleSync += 1; // Emotional expression supports title promise
  }

  // Arrow or circle misplacement can confuse viewers (misalignment penalty)
  // Only penalize if it's the only element (high faceCount or low textContent suggests decoration, not guidance)
  if (
    analysis.arrowOrCircle &&
    !analysis.hasText &&
    analysis.faceCount === 0
  ) {
    titleSync -= 2; // Misleading visual decoration
  }

  // Clamp to valid range 1–10
  titleSync = Math.max(1, Math.min(10, titleSync));

  // ── Score 2: thumbnailClutter (1–5) ────────────────────────────────────────
  // Direct mapping from analysis.clutter with face count adjustment
  let clutter = analysis.clutter; // Base score 1–5

  // Multiple faces increase perceived clutter
  if (analysis.faceCount > 2) {
    clutter = Math.min(5, clutter + 1);
  }

  // Clamp to valid range 1–5
  clutter = Math.max(1, Math.min(5, clutter));

  logger.debug(
    `[ThumbnailScoring] titleSync: ${titleSync}/10, clutter: ${clutter}/5`,
  );

  return { thumbnailTitleSync: titleSync, thumbnailClutter: clutter };
}
