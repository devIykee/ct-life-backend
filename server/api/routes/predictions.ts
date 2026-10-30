/**
 * Prediction routes.
 *
 *   GET  /v1/predictions/markets?status=&cursor=        (app capability predict)
 *   POST /v1/predictions/markets/:marketId/bets         (app capability predict)
 *   GET  /v1/predictions?status=                        the caller's bets
 *   POST /v1/predictions                                410 GONE {reason:'use_market_bets'}
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireCapability } from '../middleware/capability.js';
import { requireNotJailed } from '../middleware/jail.js';
import { GoneError, ValidationFailedError } from '../../shared/domain/errors.js';
import { listPredictions, placeBet, type PredictionStatus } from '../../application/predictions.js';
import { listMarkets } from '../../application/prediction-markets.js';

const BetBody = z
  .object({
    outcomeId: z.string().min(1).max(64),
    stakeCents: z.number().int().positive(),
  })
  .strict();

const MarketParams = z.object({ marketId: z.string().min(1).max(200) });

const ListQuery = z.object({
  status: z.enum(['open', 'won', 'lost', 'cancelled']).optional(),
});

/**
 * Register prediction routes.
 * @param app - The Fastify instance.
 */
export function registerPredictionRoutes(app: FastifyInstance): void {
  // The legacy route took any outcome id and was never wired to a market list.
  app.post('/v1/predictions', { preHandler: requireAuth }, async () => {
    throw new GoneError({
      reason: 'use_market_bets',
      use: 'POST /v1/predictions/markets/{marketId}/bets',
    });
  });

  app.get(
    '/v1/predictions/markets',
    { preHandler: [requireCapability('predict'), requireAuth] },
    async (req, reply) => reply.send(await listMarkets(req.ctx, req.query)),
  );

  app.post(
    '/v1/predictions/markets/:marketId/bets',
    {
      preHandler: [requireCapability('predict'), requireAuth, requireNotJailed, withIdempotency()],
    },
    async (req, reply) => {
      const p = MarketParams.safeParse(req.params);
      const body = BetBody.safeParse(req.body);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const receipt = await placeBet(req.ctx, {
        userId: req.user!.sub,
        marketId: p.data.marketId,
        outcomeId: body.data.outcomeId,
        stakeCents: body.data.stakeCents,
      });
      return reply.code(201).send(receipt);
    },
  );

  app.get('/v1/predictions', { preHandler: requireAuth }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const predictions = await listPredictions(
      req.ctx,
      req.user!.sub,
      (q.data.status ?? null) as PredictionStatus | null,
    );
    return reply.send(predictions); // B22: return unwrapped array, not {predictions}
  });
}
