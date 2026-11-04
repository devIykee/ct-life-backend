import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withRateLimit } from '../middleware/rate-limit.js';
import { RateLimitedError, ValidationFailedError } from '../../shared/domain/errors.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';
import { EconomyOrders } from '../../application/economy-orders.js';
import type { EconomyChain } from '../../application/economy-chain.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationFailedError({ issues: result.error.issues });
  return result.data;
}
const idSchema = z.object({ id: z.string().uuid() });
const transactionSchema = z.object({ transactionId: z.string().min(1).max(200) }).strict();

/** Register authenticated orders with durable, non-cached reconciliation writes. */
export function registerEconomyRoutes(app: FastifyInstance, chain: EconomyChain): void {
  const reconcileLimit: import('fastify').preHandlerHookHandler = async (req) => {
    const decision = await perUserTokenBucket(
      req.ctx.redis.main,
      `rl:economy:${req.user!.sub}`,
      5,
      0.5,
    );
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterMs);
  };
  const reads = { preHandler: [requireAuth] };
  // DB order keys and globally unique receipts are durable idempotency. Do not
  // cache a pending 200 in Redis: the same submission must be able to finalize.
  const writes = {
    preHandler: [
      requireAuth,
      withRateLimit(),
      async (req: import('fastify').FastifyRequest) => {
        parse(z.string().uuid(), req.headers['idempotency-key']);
      },
    ],
  };
  app.get('/v1/economy/catalog', reads, (req) => new EconomyOrders(req.ctx, chain).catalog());
  app.post('/v1/economy/orders', writes, async (req, reply) => {
    const body = parse(
      z.object({ offerId: z.string().uuid(), walletLinkId: z.string().uuid() }).strict(),
      req.body,
    );
    return reply
      .code(201)
      .send(
        await new EconomyOrders(req.ctx, chain).create(
          req.user!.sub,
          body.offerId,
          body.walletLinkId,
          req.headers['idempotency-key'] as string,
        ),
      );
  });
  app.get('/v1/economy/orders/:id', { preHandler: [requireAuth, reconcileLimit] }, (req) => {
    const { id } = parse(idSchema, req.params);
    return new EconomyOrders(req.ctx, chain).get(req.user!.sub, id);
  });
  app.get('/v1/economy/orders/:id/payment-request', reads, (req) => {
    const { id } = parse(idSchema, req.params);
    return new EconomyOrders(req.ctx, chain).prepare(req.user!.sub, id);
  });
  app.post('/v1/economy/orders/:id/cancel', writes, (req) => {
    const { id } = parse(idSchema, req.params);
    parse(z.object({}).strict(), req.body ?? {});
    return new EconomyOrders(req.ctx, chain).cancel(req.user!.sub, id);
  });
  for (const kind of ['payment', 'refund'] as const) {
    app.post(`/v1/economy/orders/:id/${kind}`, writes, (req) => {
      const { id } = parse(idSchema, req.params);
      const { transactionId } = parse(transactionSchema, req.body);
      return new EconomyOrders(req.ctx, chain).record(req.user!.sub, id, transactionId, kind);
    });
  }
}
