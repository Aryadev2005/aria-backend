// src/jobs/creditReset.job.ts
// Add to your existing cron/worker setup — run daily at midnight IST

import { prisma } from "../config/database";
import { resetMonthlyCredits } from "../services/credits.service";
import { logger } from "../utils/logger";

export async function runCreditResetJob(): Promise<void> {
  logger.info("Credit reset job started");

  const now = new Date();
  const wallets = await prisma.credit_wallets.findMany({
    where: { next_reset_at: { lte: now } },
    include: { users: { select: { subscription_tier: true } } },
  });

  logger.info({ count: wallets.length }, "Wallets due for reset");

  let success = 0;
  for (const wallet of wallets) {
    try {
      const tier = wallet.users?.subscription_tier ?? "free";
      await resetMonthlyCredits(wallet.user_id, tier);
      success++;
    } catch (err) {
      logger.error({ err, userId: wallet.user_id }, "Reset failed for user");
    }
  }

  logger.info({ success, total: wallets.length }, "Credit reset job complete");
}
