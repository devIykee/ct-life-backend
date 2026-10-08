/**
 * Ratio Arena (CT Beef) routes (M7 #5).
 *
 *   POST /v1/beef
 *   POST /v1/beef/:id/accept
 *   POST /v1/beef/:id/decline
 *   POST /v1/beef/:id/settle
 *   GET  /v1/beef
 *   GET  /v1/beef/:id
 *   GET  /v1/beef/elo
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  acceptMatch,
  declineMatch,
  getElo,
  openMatch,
  settleMatch,
} from '../../application/ratio-arena.js';

const OpenBody = z.object({
  stakeCents: z.number().int().positive(),
});

const AcceptBody = z.object({}).optional();

const DeclineBody = z.object({}).optional();

const SettleBody = z.object({
  winnerUserId: z.string().uuid(),
});

/**
 * Register the ratio-arena routes on the Fastify app.
 */
export function registerRatioArenaRoutes(app: FastifyInstance): void {
  app.post('/v1/beef', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = OpenBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const out = await openMatch(req.ctx, req.user!.sub, body.data.stakeCents);
    return reply.status(201).send(out);
  });

  app.post(
    '/v1/beef/:id/accept',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      AcceptBody.safeParse(req.body ?? {});
      const { id } = req.params as { id: string };
      const out = await acceptMatch(req.ctx, req.user!.sub, id);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/beef/:id/decline',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      DeclineBody.safeParse(req.body ?? {});
      const { id } = req.params as { id: string };
      const out = await declineMatch(req.ctx, req.user!.sub, id);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/beef/:id/settle',
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const body = SettleBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const { id } = req.params as { id: string };
      const out = await settleMatch(req.ctx, id, body.data.winnerUserId);
      return reply.send(out);
    },
  );

  app.get('/v1/beef/elo', { preHandler: requireAuth }, async (req, reply) => {
    const out = await getElo(req.ctx, req.user!.sub);
    return reply.send(out);
  });
}
