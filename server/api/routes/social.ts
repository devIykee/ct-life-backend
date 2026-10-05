/**
 * Social routes.
 *
 *   GET  /v1/leaderboards/{boardId}?scope=global|friends|league
 *   POST /v1/blocks/{userId}
 *   DELETE /v1/blocks/{userId}
 *   POST /v1/reports
 *   GET  /v1/rekt/tombstones
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { BoardsService } from '../../application/boards.js';
import { BlocksService } from '../../application/blocks.js';
import { ReportsService } from '../../application/reports.js';
import { listTombstones } from '../../application/launchpad.js';

const LeaderboardQuery = z.object({
  scope: z.enum(['global', 'friends', 'league']).default('global'),
  cursor: z.string().optional(),
});

const ReportBody = z.object({
  targetType: z.enum(['user', 'message', 'space', 'call', 'post', 'ad']),
  targetId: z.string().min(1),
  reasonId: z.string().min(1),
  note: z.string().max(500).optional(),
});

/**
 *
 */
export function registerSocialRoutes(app: FastifyInstance): void {
  // GET /v1/leaderboards/{boardId}
  app.get('/v1/leaderboards/:boardId', { preHandler: requireAuth }, async (req, reply) => {
    const { boardId } = req.params as { boardId: string };
    const q = LeaderboardQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const svc = new BoardsService(req.ctx);
    const entries = await svc.top(boardId, q.data.scope, 50);
    return reply.send({ entries, me: null });
  });

  // POST /v1/blocks/{userId}
  app.post(
    '/v1/blocks/:userId',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const svc = new BlocksService(req.ctx);
      await svc.block(req.user!.sub, userId);
      return reply.status(204).send();
    },
  );

  // DELETE /v1/blocks/{userId}
  app.delete(
    '/v1/blocks/:userId',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const svc = new BlocksService(req.ctx);
      await svc.unblock(req.user!.sub, userId);
      return reply.status(204).send();
    },
  );

  // POST /v1/reports
  app.post('/v1/reports', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = ReportBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const svc = new ReportsService(req.ctx);
    await svc.submit(req.user!.sub, body.data);
    return reply.status(204).send();
  });

  // GET /v1/rekt/tombstones
  app.get('/v1/rekt/tombstones', { preHandler: requireAuth }, async (req, reply) => {
    const limit = Number((req.query as { limit?: string }).limit ?? '50');
    const tombstones = await listTombstones(req.ctx, limit);
    return reply.send({ tombstones });
  });
}
