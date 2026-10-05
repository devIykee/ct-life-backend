/**
 * Season pass routes (M5 #61).
 *
 *   POST /v1/season-pass/buy
 *   GET  /v1/season-pass/me
 *   POST /v1/season-pass/claim
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { buy, claim, getByUser } from '../../application/season-pass.js';

/**
 * Register the season-pass routes on the Fastify app.
 */
export function registerSeasonPassRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/season-pass/buy',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const out = await buy(req.ctx, req.user!.sub);
      return reply.status(201).send(out);
    },
  );

  app.get('/v1/season-pass/me', { preHandler: requireAuth }, async (req, reply) => {
    const out = await getByUser(req.ctx, req.user!.sub);
    if (!out) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'no season pass', details: {} },
      });
    }
    return reply.send(out);
  });

  app.post(
    '/v1/season-pass/claim',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const out = await claim(req.ctx, req.user!.sub);
      return reply.send(out);
    },
  );
}
