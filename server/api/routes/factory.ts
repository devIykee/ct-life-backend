/**
 * Rugpull Factory routes.
 *
 *   GET  /v1/factory/config
 *   GET  /v1/factory/me
 *   POST /v1/factory/coins
 *   GET  /v1/factory/coins?view=trending|new|mine&limit=
 *   GET  /v1/factory/coins/:coinId
 *
 * Buying and selling a player coin uses `POST /v1/market/trades`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  FACTORY_TEMPLATES,
  getFactoryConfig,
  getFactoryCoin,
  getFactoryMe,
  launchFactoryCoin,
  listFactoryCoins,
  MAX_DEV_ALLOCATION_BPS,
  MAX_LIQUIDITY_CENTS,
  MIN_LIQUIDITY_CENTS,
} from '../../application/factory.js';

const LaunchBody = z
  .object({
    name: z.string().min(1).max(64),
    ticker: z.string().min(1).max(16),
    templateId: z.enum(FACTORY_TEMPLATES),
    liquidityCents: z.number().int().min(MIN_LIQUIDITY_CENTS).max(MAX_LIQUIDITY_CENTS),
    devAllocationBps: z.number().int().min(0).max(MAX_DEV_ALLOCATION_BPS),
  })
  .strict();

const ListQuery = z.object({
  view: z.enum(['trending', 'new', 'mine']).optional().default('trending'),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});
const CoinParams = z.object({ coinId: z.string().uuid() });

/**
 * Register the Rugpull Factory routes.
 * @param app - The Fastify instance.
 */
export function registerFactoryRoutes(app: FastifyInstance): void {
  app.get('/v1/factory/config', { preHandler: requireAuth }, async (req, reply) =>
    reply.send(getFactoryConfig(req.ctx)),
  );

  app.get('/v1/factory/me', { preHandler: requireAuth }, async (req, reply) =>
    reply.send(await getFactoryMe(req.ctx, req.user!.sub)),
  );

  app.post(
    '/v1/factory/coins',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = LaunchBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const key = req.headers['idempotency-key'] as string;
      const out = await launchFactoryCoin(req.ctx, req.user!.sub, body.data, key);
      return reply.status(201).send(out.coin);
    },
  );

  app.get('/v1/factory/coins', { preHandler: requireAuth }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const coins = await listFactoryCoins(req.ctx, req.user!.sub, q.data.view, q.data.limit);
    return reply.send({ coins });
  });

  app.get('/v1/factory/coins/:coinId', { preHandler: requireAuth }, async (req, reply) => {
    const p = CoinParams.safeParse(req.params);
    if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
    return reply.send(await getFactoryCoin(req.ctx, req.user!.sub, p.data.coinId));
  });
}
