/**
 * ORE routes.
 *
 *   GET  /v1/ore/board
 *   GET  /v1/ore/me
 *   POST /v1/ore/stake/tx
 *   POST /v1/ore/stake/submitted
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  buildStakeTx,
  markStakeSubmitted,
  readBoard,
  readOreMe,
  type StakeAction,
} from '../../application/refinery.js';

const StakeTxBody = z.object({
  action: z.enum(['deposit', 'withdraw', 'claim', 'compound']),
  amount: z.string().optional(),
});

const SubmittedBody = z.object({
  intentId: z.string().uuid(),
  signature: z.string().min(64).max(128),
});

/**
 * Register ORE routes (board, me, stake tx, stake submitted).
 * @param app - The Fastify instance.
 */
export function registerOreRoutes(app: FastifyInstance): void {
  app.get('/v1/ore/board', async (req, reply) => {
    const board = await readBoard(req.ctx);
    return reply.send(board);
  });

  app.get('/v1/ore/me', { preHandler: requireAuth }, async (req, reply) => {
    const me = await readOreMe(req.ctx, req.user!.sub);
    return reply.send(me);
  });

  app.post(
    '/v1/ore/stake/tx',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = StakeTxBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const tx = await buildStakeTx(req.ctx, {
        userId: req.user!.sub,
        action: body.data.action as StakeAction,
        amount: body.data.amount,
      });
      return reply.send(tx);
    },
  );

  app.post(
    '/v1/ore/stake/submitted',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = SubmittedBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      await markStakeSubmitted(req.ctx, req.user!.sub, body.data.intentId, body.data.signature);
      return reply.status(204).send();
    },
  );
}
