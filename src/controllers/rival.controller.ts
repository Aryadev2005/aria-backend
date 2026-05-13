// src/controllers/rival.controller.ts

import { FastifyRequest, FastifyReply } from 'fastify';
import { success, errors } from '../utils/response';
import { logger } from '../utils/logger';
import { User } from '../types';
import { debitCredits } from '../services/credits.service';
import { runRivalSpy } from '../services/rival.service';
import { prisma } from '../config/database';

export const streamRivalSpy = async (req: FastifyRequest, reply: FastifyReply) => {
  const user = req.user as User;
  const { handles, platform = 'auto' } = req.body as { handles: string[]; platform?: string };

  if (!handles || !Array.isArray(handles) || handles.length === 0) {
    return reply.status(400).send({ success: false, error: 'handles array is required' });
  }
  if (handles.length > 8) {
    return reply.status(400).send({ success: false, error: 'Maximum 8 handles per session' });
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

  try {
    const niche = (user as any).niches?.[0] || 'general';

    const report = await runRivalSpy(
      handles,
      platform as any,
      niche,
      user.id,
      (progress) => {
        sendSSE({ type: 'progress', ...progress });
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

    sendSSE({ type: 'report', data: report });

    // Debit after success (non-fatal)
    const modelToUse = req.creditCheck?.modelToUse ?? 'gpt-4o-mini';
    await debitCredits(user.id, 'rival_spy', modelToUse, 3500, 1500).catch(
      (err: any) => logger.warn({ err }, 'rival: debit failed — non-fatal'),
    );

    sendSSE({ type: 'done' });
  } catch (err: any) {
    logger.error({ err: err.message, userId: user.id }, 'streamRivalSpy failed');
    sendSSE({ type: 'error', message: err.message || 'Rival Spy failed. Please try again.' });
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
