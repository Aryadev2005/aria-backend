// src/controllers/rival.controller.ts

import { FastifyRequest, FastifyReply } from 'fastify';
import { success, errors } from '../utils/response';
import { logger } from '../utils/logger';
import { User } from '../types';
import { debitCredits, grantCredits } from '../services/credits.service';
import { markTrialUsed } from '../services/firstExperience.service';
import { runRivalSpy, generateRivalScript } from '../services/rival.service';
import { prisma } from '../config/database';

export const streamRivalSpy = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const { handles, platform = 'auto' } = req.body as { handles: string[]; platform?: string };

  if (!handles || !Array.isArray(handles) || handles.length === 0) {
    return reply.status(400).send({ success: false, error: 'handles array is required' });
  }

  // ── TRIAL LOGIC: enforce max 3 handles for trials ──────────────────────
  const isTrialRun = req.creditCheck?.isTrial;
  const maxHandles = isTrialRun ? 3 : 8;
  
  if (handles.length > maxHandles) {
    const message = isTrialRun 
      ? 'Free trial supports up to 3 handles. Upgrade to Pro for 8.'
      : 'Maximum 8 handles per session';
    return reply.status(400).send({ success: false, error: message });
  }

  // SSE headers
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const sendSSE = (event: any) => {
    try { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
  };

  const keepAlive = setInterval(() => {
    try { reply.raw.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
  }, 15_000);

  // Stop processing immediately if the client disconnects mid-stream
  let clientClosed = false;
  req.raw.on('close', () => {
    clientClosed = true;
    clearInterval(keepAlive);
  });

  const modelToUse = req.creditCheck?.modelToUse ?? 'gpt-4o-mini';
  const featureCharge = req.creditCheck?.featureCharge ?? 0;

  // Pre-reserve the feature charge before any AI work.
  // If debit fails the user genuinely has no credits — abort early.
  // (Trials have featureCharge = 0, so this is a no-op for trials)
  try {
    await debitCredits(user.id, 'rival_spy', modelToUse, 0, 0);
  } catch (preDebitErr: any) {
    sendSSE({ type: 'error', message: 'Insufficient credits to run Rival Spy.' });
    clearInterval(keepAlive);
    reply.raw.end();
    return;
  }

  try {
    const niche = (user as any).niches?.[0] || 'general';

    const report = await runRivalSpy(
      handles,
      platform as any,
      niche,
      user.id,
      (progress) => {
        if (!clientClosed) {
          // Add trial flag to progress events
          sendSSE({ 
            type: 'progress', 
            ...progress,
            isTrial: isTrialRun 
          });
        }
      },
    );

    // Save to DB for re-use (non-fatal)
    await (prisma as any).rival_spy_sessions
      .create({
        data: {
          user_id: user.id,
          handles,
          platform: platform || 'auto',
          result: report as any,
          expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000),
        },
      })
      .catch((err: any) => logger.warn({ err }, 'rival: session save failed — non-fatal'));

    sendSSE({ type: 'report', data: report, isTrial: isTrialRun });

    // Debit AI token usage on top of the already-reserved feature charge (non-fatal)
    // For trials, this is also a no-op since modelToUse forces gpt-4o-mini
    await debitCredits(user.id, 'rival_spy', modelToUse, 3500, 1500, 0).catch(
      (err: any) => logger.warn({ err }, 'rival: AI token debit failed — non-fatal'),
    );

    sendSSE({ type: 'done', isTrial: isTrialRun });

    // ── MARK TRIAL AS USED ───────────────────────────────────────────────
    if (isTrialRun && req.creditCheck?.trialAction) {
      const resultData = { handles, platform, report };
      markTrialUsed(user.id, req.creditCheck.trialAction, resultData)
        .catch(err => logger.warn({ err }, 'rival: trial mark failed — non-fatal'));
    }
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, 'streamRivalSpy failed');
    // Refund the pre-reserved feature charge since the operation failed
    await grantCredits(user.id, featureCharge, 'Rival Spy failed — refund').catch(() => {});
    sendSSE({ type: 'error', message: err.message || 'Rival Spy failed. Please try again.', isTrial: isTrialRun });
  } finally {
    clearInterval(keepAlive);
    reply.raw.end();
  }
};

export const streamRivalScript = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const { stealCard, cardIndex, niche } = req.body as {
    stealCard: any;
    cardIndex: number;
    niche?: string;
  };

  if (!stealCard || cardIndex === undefined) {
    return reply.status(400).send({ success: false, error: 'stealCard and cardIndex required' });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const sendSSE = (event: any) => {
    try { reply.raw.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
  };

  const keepAlive = setInterval(() => {
    try { reply.raw.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
  }, 15_000);

  let clientClosed = false;
  req.raw.on('close', () => {
    clientClosed = true;
    clearInterval(keepAlive);
  });

  const modelToUse = (req as any).creditCheck?.modelToUse ?? 'gpt-4o-mini';
  const featureCharge = (req as any).creditCheck?.featureCharge ?? 0;

  // Pre-reserve feature charge before AI work
  try {
    await debitCredits(user.id, 'rival_script', modelToUse, 0, 0);
  } catch (preDebitErr: any) {
    sendSSE({ type: 'error', message: 'Insufficient credits to generate script.' });
    clearInterval(keepAlive);
    reply.raw.end();
    return;
  }

  try {
    const userNiche = niche || (user as any).niches?.[0] || 'general';
    const archetype = (user as any).archetype || 'EDUCATOR';

    const result = await generateRivalScript(
      stealCard,
      user.id,
      userNiche,
      archetype,
      cardIndex,
      (progress) => { if (!clientClosed) sendSSE({ type: 'progress', ...progress }); },
    );

    sendSSE({ type: 'script_ready', data: result });

    // Debit AI token usage on top of the already-reserved feature charge (non-fatal)
    await debitCredits(user.id, 'rival_script', modelToUse, 4000, 2000, 0).catch(
      (err: any) => logger.warn({ err }, 'rival_script: AI token debit failed — non-fatal'),
    );

    sendSSE({ type: 'done' });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, 'streamRivalScript failed');
    await grantCredits(user.id, featureCharge, 'Rival Script failed — refund').catch(() => {});
    sendSSE({ type: 'error', message: err.message || 'Script generation failed. Please try again.' });
  } finally {
    clearInterval(keepAlive);
    reply.raw.end();
  }
};

export const getRecentSessions = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  try {
    const sessions = await (prisma as any).rival_spy_sessions.findMany({
      where: { user_id: user.id, expires_at: { gt: new Date() } },
      orderBy: { created_at: 'desc' },
      take: 5,
      select: { id: true, handles: true, platform: true, created_at: true },
    });
    return success(reply, { sessions });
  } catch (err: any) {
    logger.error({ err: err.message }, 'getRecentSessions failed');
    return errors.internal(reply);
  }
};
