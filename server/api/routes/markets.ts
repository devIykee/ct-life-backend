/**
 * Markets routes.
 *
 *   GET  /v1/market/coins
 *   GET  /v1/market/coins/:coinId
 *   POST /v1/market/trades
 *   GET  /v1/market/positions
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  executeTrade,
  getCoin,
  listCoins,
  listPositions,
  type Stage,
  type TradeSide,
} from '../../application/terminal-cafe.js';

const ListCoinsQuery = z.object({
  stage: z.enum(['new', 'final', 'graduated']).optional(),
  cursor: z.string().optional(),
});

const TradeBody = z.object({
  coinId: z.string().uuid(),
  side: z.enum(['buy', 'sell']),
  cashCents: z.number().int().positive().optional(),
  units: z.string().optional(),
  maxSlippageBps: z.number().int().min(0).max(10_000),
});

/**
 * Register market routes.
 * @param app - The Fastify instance.
 */
export function registerMarketRoutes(app: FastifyInstance): void {
  app.get('/v1/market/coins', async (req, reply) => {
    const q = ListCoinsQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const result = await listCoins(
      req.ctx,
      (q.data.stage ?? null) as Stage | null,
      q.data.cursor ?? null,
    );
    return reply.send(result);
  });

  app.get('/v1/market/coins/:coinId', { preHandler: requireAuth }, async (req, reply) => {
    const { coinId } = req.params as { coinId: string };
    const detail = await getCoin(req.ctx, req.user!.sub, coinId);
    return reply.send(detail);
  });

  app.post(
    '/v1/market/trades',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = TradeBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const result = await executeTrade(req.ctx, {
        userId: req.user!.sub,
        coinId: body.data.coinId,
        side: body.data.side as TradeSide,
        cashCents: body.data.cashCents,
        units: body.data.units,
        maxSlippageBps: body.data.maxSlippageBps,
      });
      return reply.send(result);
    },
  );

  app.get('/v1/market/positions', { preHandler: requireAuth }, async (req, reply) => {
    const positions = await listPositions(req.ctx, req.user!.sub);
    return reply.send({ positions });
  });
}
