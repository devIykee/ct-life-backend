/**
 * Rugpull Factory routes.
 *
 *   GET  /v1/factory/me
 *   POST /v1/factory/coins                  410 FACTORY_CASH_RETIRED (real launches: factory-real.ts)
 *   GET  /v1/factory/coins?view=trending|new|mine&limit=   (old Cash coins, read-only history)
 *   GET  /v1/factory/coins/:coinId
 *
 * The Cash sandbox is retired: launching and buying a Cash player coin answer
 * 410; selling an old Cash position still works so nobody's Cash is stuck.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { FactoryCashRetiredError, ValidationFailedError } from '../../shared/domain/errors.js';
import { getFactoryCoin, getFactoryMe, listFactoryCoins } from '../../application/factory.js';

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
  app.get('/v1/factory/me', { preHandler: requireAuth }, async (req, reply) =>
    reply.send(await getFactoryMe(req.ctx, req.user!.sub)),
  );

  app.post('/v1/factory/coins', { preHandler: [requireAuth] }, async () => {
    throw new FactoryCashRetiredError({ use: 'POST /v1/factory/launch/prepare' });
  });

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
