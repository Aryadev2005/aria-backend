import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';

// HMAC-based comparison: pads both sides to equal length without leaking it via timing
function timingSafeStringEqual(a: string, b: string): boolean {
  const key = Buffer.from('aria_admin_cmp_key_v1');
  const aHash = crypto.createHmac('sha256', key).update(a).digest();
  const bHash = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

export const requireAdminSecret = async (
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    reply.code(503).send({ success: false, error: 'Admin endpoint not configured' });
    return;
  }
  const provided = req.headers['x-admin-secret'];
  if (!provided || typeof provided !== 'string') {
    reply.code(401).send({ success: false, error: 'Missing x-admin-secret header' });
    return;
  }
  if (!timingSafeStringEqual(secret, provided)) {
    reply.code(401).send({ success: false, error: 'Invalid admin secret' });
    return;
  }
};
