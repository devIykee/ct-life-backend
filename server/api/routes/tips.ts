/**
 * Tips routes (M4 #53).
 *
 *   POST /v1/tips            (410 CASH_NOT_TRANSFERABLE: Cash tips were removed)
 *   POST /v1/tips/onchain
 *   GET  /v1/tips?toUserId=&limit=
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { listTipsTo, recordOnchainTip, sendCashTip } from '../../application/tips.js';

const OnchainBody = z.object({
  toUserId: z.string().uuid(),
  signature: z.string().min(10).max(200),
  amountLamports: z.string().regex(/^[0-9]+$/),
  mint: z.string().nullable().optional(),
  message: z.string().max(200).optional(),
});

const ListQuery = z.object({
  toUserId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 *
 */
export function registerTipRoutes(app: FastifyInstance): void {
  // Cash tips were removed: Cash never moves between players.
  app.post('/v1/tips', { preHandler: [requireAuth] }, async () => sendCashTip());

  app.post(
    '/v1/tips/onchain',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = OnchainBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await recordOnchainTip(
        req.ctx,
        req.user!.sub,
        body.data.toUserId,
        body.data.signature,
        body.data.amountLamports,
        body.data.mint ?? null,
        body.data.message ?? null,
      );
      return reply.status(201).send(out);
    },
  );

  app.get('/v1/tips', { preHandler: requireAuth }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const rows = await listTipsTo(req.ctx, q.data.toUserId, q.data.limit);
    return reply.send({ tips: rows });
  });
}
