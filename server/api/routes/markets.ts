/**
 * Markets routes.
 *
 *   GET  /v1/market/coins
 *   GET  /v1/market/coins/:coinId
 *   POST /v1/market/trades
 *   GET  /v1/market/positions
 *   POST /v1/market/launchpad             — create a new coin
 *   POST /v1/market/launchpad/:coinId/buy — buy on the bonding curve
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { assertNotJailed } from '../../application/heat.js';
import { requireNotJailed } from '../middleware/jail.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  executeTrade,
  getCoin,
  listCoins,
  listPositions,
  type Stage,
  type TradeSide,
} from '../../application/terminal-cafe.js';
import { launchCoin, launchpadBuy } from '../../application/launchpad.js';

const ListCoinsQuery = z.object({
  stage: z.enum(['new', 'final', 'graduated']).optional(),
  cursor: z.string().optional(),
});

const TradeBody = z.object({
  coinId: z.string().uuid(),
  side: z.enum(['buy', 'sell']),
  cashCents: z.number().int().positive().optional(),
  units: z.string().optional(),
  maxSlippageBps: z.number().int().min(0).max(10_000).optional().default(500), // B20: optional with default
});

const LaunchBody = z.object({
  name: z.string().min(1).max(64),
  ticker: z.string().min(2).max(8),
  supply: z.string().optional(),
});

const LaunchpadBuyBody = z.object({
  cashCents: z.number().int().positive(),
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
      // Buying opens new risk and is refused in jail; selling stays open.
      if (body.data.side === 'buy') await assertNotJailed(req.ctx, req.user!.sub);
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

  app.post(
    '/v1/market/launchpad',
    { preHandler: [requireAuth, requireNotJailed, withIdempotency()] },
    async (req, reply) => {
      const body = LaunchBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const result = await launchCoin(req.ctx, {
        userId: req.user!.sub,
        name: body.data.name,
        ticker: body.data.ticker,
        supply: body.data.supply,
      });
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/v1/market/launchpad/:coinId/buy',
    { preHandler: [requireAuth, requireNotJailed, withIdempotency()] },
    async (req, reply) => {
      const { coinId } = req.params as { coinId: string };
      const body = LaunchpadBuyBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const result = await launchpadBuy(
        req.ctx,
        req.user!.sub,
        coinId,
        body.data.cashCents,
        body.data.maxSlippageBps,
      );
      return reply.send(result);
    },
  );
}
