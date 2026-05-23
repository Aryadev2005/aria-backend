// src/services/weeklyReport.service.ts
import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';
import OpenAI from 'openai';

let _openai: OpenAI | null = null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const groq = (): OpenAI => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!_openai) _openai = new OpenAI({ apiKey });
  return _openai;
};

export const WEEKLY_REPORT_CACHE_KEY = (userId: string) => `weekly-report:${userId}`;
const CACHE_TTL = 7 * 24 * 60 * 60; // 7 days

export interface WeeklyReport {
  week: string;
  summary: string;
  highlights: string[];
  topPost: { caption: string; views: number; likes: number; saves: number; comments: number };
  nextWeekPlan: string[];
  generatedAt: string;
  fromWorker?: boolean;
}

export const generateWeeklyReport = async (userId: string): Promise<WeeklyReport> => {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      niches: true,
      primary_platform: true,
      follower_range: true,
      archetype: true,
      archetype_label: true,
    },
  });

  if (!user) throw new Error(`User ${userId} not found`);

  const niche    = Array.isArray(user.niches) ? (user.niches as string[])[0] : 'general';
  const platform = user.primary_platform || 'instagram';

  const prompt = `You are ARIA — India's creator intelligence engine.

Creator:
- Niche: ${niche}
- Platform: ${platform}
- Followers: ${user.follower_range || 'Under 1K'}
- Archetype: ${user.archetype_label || user.archetype || 'CREATOR'}

Generate a motivating weekly performance summary and next-week plan for this Indian creator.

Respond ONLY with valid JSON:
{
  "week": "current week date range",
  "summary": "One sentence headline about this week",
  "highlights": [
    "Specific highlight 1",
    "Specific highlight 2",
    "Specific highlight 3"
  ],
  "topPost": {
    "caption": "Example top post caption relevant to their niche",
    "views": 0,
    "likes": 0,
    "saves": 0,
    "comments": 0
  },
  "nextWeekPlan": [
    "Specific action 1 with day and time in IST",
    "Specific action 2 referencing Indian trends",
    "Specific action 3 with format recommendation"
  ]
}`;

  const res = await groq().chat.completions.create({
    model:       OPENAI_MODEL,
    max_tokens:  600,
    temperature: 0.6,
    messages:    [{ role: 'user', content: prompt }],
  });

  const text = res.choices[0].message.content;
  if (!text) throw new Error('Empty response from LLM');

  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(clean) as WeeklyReport;
  parsed.generatedAt = new Date().toISOString();
  return parsed;
};

export const getOrGenerateWeeklyReport = async (userId: string): Promise<WeeklyReport & { fromCache: boolean }> => {
  const key = WEEKLY_REPORT_CACHE_KEY(userId);
  try {
    const cached = await cache.get(key);
    if (cached) {
      return { ...(JSON.parse(cached as string) as WeeklyReport), fromCache: true };
    }
  } catch (_) { /* redis miss */ }

  const report = await generateWeeklyReport(userId);
  try {
    await cache.set(key, JSON.stringify(report), 'EX', CACHE_TTL);
  } catch (_) { /* non-fatal */ }
  return { ...report, fromCache: false };
};

export const preGenerateForActiveUsers = async (): Promise<{ generated: number; failed: number }> => {
  // Active = users with at least one ARIA chat in the last 14 days
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  let activeUserIds: string[] = [];
  try {
    const rows = await prisma.aria_chat_sessions.findMany({
      where:  { created_at: { gte: cutoff }, role: 'user' },
      select: { user_id: true },
      distinct: ['user_id'],
      take: 200,
    });
    activeUserIds = rows.map((r) => r.user_id);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'weeklyReport: failed to fetch active users');
    return { generated: 0, failed: 0 };
  }

  let generated = 0;
  let failed    = 0;

  for (const userId of activeUserIds) {
    try {
      const key    = WEEKLY_REPORT_CACHE_KEY(userId);
      const exists = await cache.get(key).catch(() => null);
      if (exists) { generated++; continue; } // already cached

      const report = await generateWeeklyReport(userId);
      report.fromWorker = true;
      await cache.set(key, JSON.stringify(report), 'EX', CACHE_TTL).catch(() => {});
      generated++;
      await new Promise((r) => setTimeout(r, 800)); // stay under API rate
    } catch (err: any) {
      failed++;
      logger.warn({ err: err.message, userId }, 'weeklyReport: pre-generation failed for user');
    }
  }

  return { generated, failed };
};
