// src/services/discovery/scrape-health.service.ts
// ══════════════════════════════════════════════════════════════════════════════
// Scrape Health Monitor
// Tracks success/failure per source — prevents silent data loss
// ══════════════════════════════════════════════════════════════════════════════

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import type { DiscoverySource } from './scoring.service';

const MIN_RESULTS_THRESHOLD: Record<DiscoverySource, number> = {
  youtube:   10,
  reddit:    5,
  tiktok:    5,
  pinterest: 3,
  google:    3,
  instagram: 5,
};

// Call at start of each scrape run
export async function markScrapeRunning(source: DiscoverySource): Promise<void> {
  try {
    await (prisma as any).scrape_health.upsert({
      where:  { source },
      create: { source, status: 'running', last_run_at: new Date() },
      update: { status: 'running', last_run_at: new Date(), updated_at: new Date() },
    });
  } catch (err) {
    logger.warn({ err, source }, 'scrape_health: markRunning failed');
  }
}

// Call after successful scrape with result count
export async function markScrapeSuccess(source: DiscoverySource, resultCount: number): Promise<boolean> {
  const threshold = MIN_RESULTS_THRESHOLD[source] || 5;

  // If result count is suspiciously low — treat as failed
  if (resultCount < threshold) {
    logger.warn({ source, resultCount, threshold }, 'scrape_health: result count below threshold — marking failed');
    await markScrapeFailed(source, `Result count ${resultCount} below threshold ${threshold}`);
    return false;
  }

  try {
    await (prisma as any).scrape_health.upsert({
      where:  { source },
      create: {
        source,
        status:               'ok',
        last_run_at:          new Date(),
        last_success_at:      new Date(),
        last_result_count:    resultCount,
        consecutive_failures: 0,
        last_error:           null,
      },
      update: {
        status:               'ok',
        last_success_at:      new Date(),
        last_result_count:    resultCount,
        consecutive_failures: 0,
        last_error:           null,
        updated_at:           new Date(),
      },
    });
    return true;
  } catch (err) {
    logger.warn({ err, source }, 'scrape_health: markSuccess failed');
    return true; // don't block scrape for health tracking failure
  }
}

// Call when scrape throws
export async function markScrapeFailed(source: DiscoverySource, errorMsg: string): Promise<void> {
  try {
    const current = await (prisma as any).scrape_health.findUnique({ where: { source } });
    const failures = (current?.consecutive_failures || 0) + 1;

    await (prisma as any).scrape_health.upsert({
      where:  { source },
      create: {
        source,
        status:               'failed',
        last_run_at:          new Date(),
        consecutive_failures: 1,
        last_error:           errorMsg.slice(0, 500),
      },
      update: {
        status:               failures >= 3 ? 'stale' : 'failed',
        consecutive_failures: failures,
        last_error:           errorMsg.slice(0, 500),
        updated_at:           new Date(),
      },
    });

    if (failures >= 3) {
      logger.error({ source, failures }, 'scrape_health: source has failed 3+ consecutive times — DATA IS STALE');
    }
  } catch (err) {
    logger.warn({ err, source }, 'scrape_health: markFailed itself failed');
  }
}

// Check if a source is healthy enough to overwrite existing data
export async function isSourceHealthy(source: DiscoverySource): Promise<boolean> {
  try {
    const health = await (prisma as any).scrape_health.findUnique({ where: { source } });
    if (!health) return true; // no history = allow
    return health.status !== 'stale' && (health.consecutive_failures || 0) < 3;
  } catch {
    return true; // if health check itself fails, don't block scraping
  }
}

// Extend expiry of existing live_trends data for a source when scrape fails
export async function extendSourceData(source: DiscoverySource, extraHours = 6): Promise<void> {
  try {
    const newExpiry = new Date(Date.now() + extraHours * 60 * 60 * 1000);
    await (prisma as any).live_trends.updateMany({
      where:  { source, expires_at: { gt: new Date() } },
      data:   { expires_at: newExpiry },
    });
    logger.info({ source, extraHours }, 'scrape_health: extended existing data expiry');
  } catch (err) {
    logger.warn({ err, source }, 'scrape_health: extendSourceData failed');
  }
}
