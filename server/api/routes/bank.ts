/**
 * Bank routes.
 *
 *   POST /v1/bank/repay           - repay debt from cash
 *   GET  /v1/ledger?before=&limit= - cash history, newest first
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { listLedger, repayDebt } from '../../application/bank.js';

const RepayBody = z.object({
  amountCents: z.number().int().min(1).max(100_000_000),
});

const LedgerQuery = z.object({
  before: z
    .string()
    .regex(/^[0-9]{1,18}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * Register bank routes.
 * @param app - The Fastify instance.
 */
export function registerBankRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/bank/repay',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = RepayBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      // withIdempotency has already rejected a missing or short key.
      const key = req.headers['idempotency-key'] as string;
      const out = await repayDebt(req.ctx, req.user!.sub, body.data.amountCents, key);
      return reply.send(out);
    },
  );

  app.get('/v1/ledger', { preHandler: requireAuth }, async (req, reply) => {
    const q = LedgerQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const page = await listLedger(req.ctx, req.user!.sub, q.data.before ?? null, q.data.limit);
    return reply.send(page);
  });
}
