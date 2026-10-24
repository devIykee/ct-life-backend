/**
 * gm streak and daily chest routes.
 *
 *   GET  /v1/daily/status
 *   POST /v1/daily/claim
 *   POST /v1/daily/freeze
 *
 * The server owns the clock and the rewards: none of these reads a time or an amount from
 * the request.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { buyFreeze, claimDaily, getDailyStatus } from '../../application/daily-streak.js';

/**
 * Register the daily streak routes.
 */
export function registerDailyRoutes(app: FastifyInstance): void {
  app.get('/v1/daily/status', { preHandler: requireAuth }, async (req, reply) => {
    return reply.send(await getDailyStatus(req.ctx, req.user!.sub));
  });

  app.post(
    '/v1/daily/claim',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      return reply.send(await claimDaily(req.ctx, req.user!.sub));
    },
  );

  app.post(
    '/v1/daily/freeze',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      return reply.status(201).send(await buyFreeze(req.ctx, req.user!.sub));
    },
  );
}
