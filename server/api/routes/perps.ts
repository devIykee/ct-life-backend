/**
 * Perps routes.
 *
 *   POST /v1/perps
 *   POST /v1/perps/:perpId/close
 *   GET  /v1/perps?status=open|closed
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  closePerp,
  listPerps,
  openPerp,
  type PerpSide,
  type PerpStatus,
} from '../../application/perp-pit.js';

const OpenPerpBody = z.object({
  coinId: z.string().uuid(),
  side: z.enum(['long', 'short']),
  leverage: z.number().int().min(1).max(20), // B38: fix from 25 to 20
  marginCents: z.number().int().positive(),
});

const ListPerpsQuery = z.object({
  status: z.enum(['open', 'closed', 'liquidated']).optional(),
});

/**
 * Register perps routes.
 * @param app - The Fastify instance.
 */
export function registerPerpRoutes(app: FastifyInstance): void {
  app.post('/v1/perps', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = OpenPerpBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const perp = await openPerp(req.ctx, {
      userId: req.user!.sub,
      coinId: body.data.coinId,
      side: body.data.side as PerpSide,
      leverage: body.data.leverage,
      marginCents: body.data.marginCents,
    });
    return reply.send(perp); // B38: return 200, not 201
  });

  app.post(
    '/v1/perps/:perpId/close',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { perpId } = req.params as { perpId: string };
      const perp = await closePerp(req.ctx, req.user!.sub, perpId);
      return reply.send(perp);
    },
  );

  app.get('/v1/perps', { preHandler: requireAuth }, async (req, reply) => {
    const q = ListPerpsQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const perps = await listPerps(
      req.ctx,
      req.user!.sub,
      (q.data.status ?? null) as PerpStatus | null,
    );
    return reply.send(perps); // B38: return unwrapped array, not {perps}
  });
}
