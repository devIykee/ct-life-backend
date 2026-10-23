/**
 * Quest routes.
 *
 *   GET  /v1/quests
 *   POST /v1/quests/{id}/claim
 *
 * Progress is never written here: only server events advance a quest.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { claimQuest, listQuests } from '../../application/quests.js';

/**
 * Register the quest routes.
 */
export function registerQuestRoutes(app: FastifyInstance): void {
  app.get('/v1/quests', { preHandler: requireAuth }, async (req, reply) => {
    return reply.send(await listQuests(req.ctx, req.user!.sub));
  });

  app.post(
    '/v1/quests/:id/claim',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply.send(await claimQuest(req.ctx, req.user!.sub, id));
    },
  );
}
