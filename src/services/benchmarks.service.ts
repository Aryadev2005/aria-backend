// src/services/benchmarks.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Dynamic Niche Benchmarks
//
// Reads from niche_benchmarks table with Redis override layer.
// Falls back to hardcoded constants if DB is unavailable.
// Update benchmarks without code deploys via updateBenchmark().
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from '../config/database';
import { cache } from '../config/redis';
import { logger } from '../utils/logger';

export interface NicheBenchmark {
  niche:   string;
  avgER:   number;
  topER:   number;
  cpm:     number;
  label:   string;
}

// ── Hardcoded fallback — identical to old static constants ────────────────────
// These are the safety net. Never removed. Updated quarterly by code.
const FALLBACK_BENCHMARKS: Record<string, NicheBenchmark> = {
  fitness:    { niche: 'fitness',    avgER: 3.8, topER: 7.2, cpm: 140, label: 'Fitness & Wellness'        },
  finance:    { niche: 'finance',    avgER: 2.9, topER: 5.8, cpm: 220, label: 'Finance & Investing'       },
  food:       { niche: 'food',       avgER: 4.1, topER: 8.0, cpm: 120, label: 'Food & Cooking'            },
  fashion:    { niche: 'fashion',    avgER: 3.2, topER: 6.5, cpm: 130, label: 'Fashion & Style'           },
  tech:       { niche: 'tech',       avgER: 2.5, topER: 5.0, cpm: 190, label: 'Tech & Gadgets'            },
  travel:     { niche: 'travel',     avgER: 3.5, topER: 6.8, cpm: 130, label: 'Travel'                    },
  education:  { niche: 'education',  avgER: 3.0, topER: 6.0, cpm: 160, label: 'Education'                 },
  comedy:     { niche: 'comedy',     avgER: 4.5, topER: 9.0, cpm: 100, label: 'Comedy & Entertainment'    },
  beauty:     { niche: 'beauty',     avgER: 3.6, topER: 7.0, cpm: 125, label: 'Beauty & Skincare'         },
  motivation: { niche: 'motivation', avgER: 3.4, topER: 6.5, cpm: 110, label: 'Motivation & Lifestyle'    },
  hustle:     { niche: 'hustle',     avgER: 3.1, topER: 6.2, cpm: 130, label: 'Hustle & Entrepreneurship' },
  bollywood:  { niche: 'bollywood',  avgER: 4.2, topER: 8.5, cpm: 105, label: 'Bollywood & Entertainment' },
  cricket:    { niche: 'cricket',    avgER: 3.9, topER: 7.8, cpm: 115, label: 'Cricket & Sports'          },
  gaming:     { niche: 'gaming',     avgER: 3.3, topER: 6.8, cpm: 135, label: 'Gaming'                    },
  general:    { niche: 'general',    avgER: 3.0, topER: 6.0, cpm:  90, label: 'General'                   },
};

const CACHE_KEY  = 'niche_benchmarks:all';
const CACHE_TTL  = 60 * 60 * 6; // 6 hours

// ── Load all benchmarks — Redis → DB → fallback ──────────────────────────────

export async function getAllBenchmarks(): Promise<Record<string, NicheBenchmark>> {
  // 1. Try Redis
  try {
    const cached = await cache.get(CACHE_KEY) as Record<string, NicheBenchmark> | null;
    if (cached && Object.keys(cached).length > 0) return cached;
  } catch (_) {}

  // 2. Try DB
  try {
    const rows = await (prisma as any).niche_benchmarks.findMany();
    if (rows && rows.length > 0) {
      const map: Record<string, NicheBenchmark> = {};
      for (const r of rows) {
        map[r.niche] = {
          niche: r.niche,
          avgER: Number(r.avg_er),
          topER: Number(r.top_er),
          cpm:   r.cpm,
          label: r.label,
        };
      }
      // Merge with fallbacks so we always have all niches
      const merged = { ...FALLBACK_BENCHMARKS, ...map };
      await cache.set(CACHE_KEY, merged, CACHE_TTL);
      return merged;
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'benchmarks: DB read failed — using fallback');
  }

  // 3. Fallback
  return FALLBACK_BENCHMARKS;
}

// ── Get a single niche benchmark ─────────────────────────────────────────────

export async function getBenchmark(niche: string): Promise<NicheBenchmark> {
  const all = await getAllBenchmarks();
  return all[niche] || all['general'] || FALLBACK_BENCHMARKS.general;
}

// ── Update a benchmark (admin operation — no deploy needed) ──────────────────

export async function updateBenchmark(
  niche: string,
  data: Partial<Pick<NicheBenchmark, 'avgER' | 'topER' | 'cpm' | 'label'>>,
  updatedBy = 'admin'
): Promise<NicheBenchmark> {
  try {
    const row = await (prisma as any).niche_benchmarks.upsert({
      where:  { niche },
      create: {
        niche,
        avg_er:     data.avgER ?? FALLBACK_BENCHMARKS[niche]?.avgER ?? 3.0,
        top_er:     data.topER ?? FALLBACK_BENCHMARKS[niche]?.topER ?? 6.0,
        cpm:        data.cpm   ?? FALLBACK_BENCHMARKS[niche]?.cpm   ?? 90,
        label:      data.label ?? FALLBACK_BENCHMARKS[niche]?.label ?? niche,
        updated_by: updatedBy,
        updated_at: new Date(),
      },
      update: {
        ...(data.avgER !== undefined && { avg_er: data.avgER }),
        ...(data.topER !== undefined && { top_er: data.topER }),
        ...(data.cpm   !== undefined && { cpm:   data.cpm   }),
        ...(data.label !== undefined && { label: data.label }),
        updated_by: updatedBy,
        updated_at: new Date(),
      },
    });

    // Bust the cache so the next request picks up the new value
    await cache.del(CACHE_KEY);

    logger.info({ niche, data, updatedBy }, 'benchmark updated');

    return {
      niche: row.niche,
      avgER: Number(row.avg_er),
      topER: Number(row.top_er),
      cpm:   row.cpm,
      label: row.label,
    };
  } catch (err: any) {
    logger.error({ err: err.message, niche }, 'benchmark update failed');
    throw err;
  }
}

// ── Expose fallbacks directly for emergency use in other services ─────────────
export { FALLBACK_BENCHMARKS };
