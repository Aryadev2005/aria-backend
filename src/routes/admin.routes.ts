import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

export default async function adminRoutes(app: FastifyInstance) {
  // GET /api/v1/admin/scrape-health
  app.get('/scrape-health', async (req: FastifyRequest, reply: FastifyReply) => {
    const secret = req.headers['x-admin-secret'];
    if (secret !== process.env.ADMIN_SECRET) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    try {
      const rows = await (prisma as any).scrape_health.findMany({ orderBy: { source: 'asc' } });

      const now = Date.now();
      const annotated = rows.map((r: any) => ({
        ...r,
        hoursStale: r.last_success_at
          ? Math.round((now - new Date(r.last_success_at).getTime()) / 3_600_000)
          : null,
        isStale: r.last_success_at
          ? (now - new Date(r.last_success_at).getTime()) > 8 * 3_600_000
          : true,
      }));

      return reply.send({ success: true, data: annotated });
    } catch (err: any) {
      logger.error({ err: err.message }, 'scrape-health endpoint failed');
      return reply.status(500).send({ error: 'internal' });
    }
  });
}
