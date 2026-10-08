/**
 * Alpha + smart-money routes.
 *
 *   POST /v1/alpha-calls
 *   GET  /v1/alpha-calls?userId=
 *   GET  /v1/smart-money?limit=50
 *   POST /v1/me/smart-money
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  listCalls,
  listSmartMoney,
  placeAlphaCall,
  setSmartMoneyOptIn,
} from '../../application/alpha.js';

const PlaceBody = z.object({
  coinId: z.string().uuid(),
  entryMicros: z.string().regex(/^[0-9]+$/),
  targetMicros: z.string().regex(/^[0-9]+$/),
  stopMicros: z.string().regex(/^[0-9]+$/),
});

const ListQuery = z.object({ userId: z.string().uuid().optional() });

const SmartMoneyQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50) });

const OptInBody = z.object({ optIn: z.boolean() });

/**
 * Register alpha + smart-money routes.
 * @param app - The Fastify instance.
 */
export function registerAlphaRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/alpha-calls',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = PlaceBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const result = await placeAlphaCall(req.ctx, {
        userId: req.user!.sub,
        coinId: body.data.coinId,
        entryMicros: body.data.entryMicros,
        targetMicros: body.data.targetMicros,
        stopMicros: body.data.stopMicros,
      });
      return reply.send(result); // B22: return 200, not 201
    },
  );

  app.get('/v1/alpha-calls', { preHandler: requireAuth }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const userId = q.data.userId ?? req.user!.sub;
    const result = await listCalls(req.ctx, userId);
    return reply.send(result);
  });

  app.get('/v1/smart-money', { preHandler: requireAuth }, async (req, reply) => {
    const q = SmartMoneyQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const result = await listSmartMoney(req.ctx, q.data.limit);
    return reply.send({ trades: result });
  });

  app.post(
    '/v1/me/smart-money',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = OptInBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      await setSmartMoneyOptIn(req.ctx, req.user!.sub, body.data.optIn);
      return reply.status(204).send();
    },
  );
}
