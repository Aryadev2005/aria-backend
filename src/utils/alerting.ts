// src/utils/alerting.ts
// ══════════════════════════════════════════════════════════════════════════════
// Production alerting — fires on credit debit failures and scrape stalls
// Uses a webhook (Slack / Discord / ntfy) configured via ALERT_WEBHOOK_URL env
// Falls back to logger.error if webhook is not set — never throws
// ══════════════════════════════════════════════════════════════════════════════
import axios from 'axios';
import { logger } from './logger';

const WEBHOOK = process.env.ALERT_WEBHOOK_URL?.trim();
const ENV = process.env.NODE_ENV || 'development';

async function sendWebhook(text: string): Promise<void> {
  if (!WEBHOOK) return;
  try {
    await axios.post(WEBHOOK, { text: `[TrendAI ${ENV.toUpperCase()}] ${text}` }, { timeout: 5000 });
  } catch {
    // webhook failure is never fatal
  }
}

export async function alertDebitFailed(userId: string, actionKey: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ userId, actionKey, err: msg }, 'CREDIT DEBIT FAILED — billing gap detected');
  await sendWebhook(`🔴 *Credit debit FAILED*\nUser: \`${userId}\`\nAction: \`${actionKey}\`\nError: ${msg}`);
}

export async function alertScrapeStalledTooLong(source: string, hoursSinceSuccess: number): Promise<void> {
  logger.error({ source, hoursSinceSuccess }, 'SCRAPE SOURCE STALLED — data may be hallucinated');
  await sendWebhook(`⚠️ *Scrape source stalled*\nSource: \`${source}\`\nLast success: ${hoursSinceSuccess}h ago\nARIA may be hallucinating on this data.`);
}

export async function alertApifyEmptyReturn(source: string, niche: string, userId: string): Promise<void> {
  logger.warn({ source, niche, userId }, 'Apify returned zero results — hallucination risk for this user');
  await sendWebhook(`⚠️ *Apify empty return*\nSource: \`${source}\`\nNiche: \`${niche}\`\nUser: \`${userId}\``);
}
