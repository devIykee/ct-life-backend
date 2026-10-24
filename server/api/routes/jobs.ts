/**
 * Job routes: the Rekt Burger fallback job.
 *
 *   GET  /v1/jobs/rekt-burger
 *   POST /v1/jobs/rekt-burger/shift/start
 *   POST /v1/jobs/rekt-burger/shift/finish   {result: {orders: [...]}}
 *   POST /v1/jobs/rekt-burger/leave
 *
 * Every route works on the caller's own job state and shifts (the user id comes from the
 * token, never from the path or body); a shift id that is not the caller's is a 404.
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { RateLimitedError, ValidationFailedError } from '../../shared/domain/errors.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';
import { finishShift, getRektBurger, leaveJob, startShift } from '../../application/rekt-burger.js';

const Order = z
  .object({
    i: z.number().int().min(0).max(1000),
    startedMs: z.number().int().min(0).max(3_600_000),
    servedMs: z.number().int().min(0).max(3_600_000),
    correct: z.boolean(),
  })
  .strict();

const FinishBody = z
  .object({
    shiftId: z.string().uuid().optional(),
    result: z.object({ orders: z.array(Order).max(200) }).strict(),
  })
  .strict();

/** Per-player bucket: `capacity` burst, `perSec` refill. */
function limit(name: string, capacity: number, perSec: number): preHandlerHookHandler {
  return async (req) => {
    const d = await perUserTokenBucket(
      req.ctx.redis.main,
      `rl:job:${name}:${req.user?.sub ?? 'anon'}`,
      capacity,
      perSec,
      1,
    );
    if (!d.allowed) throw new RateLimitedError(d.retryAfterMs, { limit: perSec });
  };
}

/** Register the job routes. */
export function registerJobRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/jobs/rekt-burger',
    { preHandler: [requireAuth, limit('read', 20, 2)] },
    async (req, reply) => reply.send(await getRektBurger(req.ctx, req.user!.sub)),
  );

  app.post(
    '/v1/jobs/rekt-burger/shift/start',
    { preHandler: [requireAuth, withIdempotency(), limit('start', 5, 0.1)] },
    async (req, reply) => reply.send(await startShift(req.ctx, req.user!.sub)),
  );

  app.post(
    '/v1/jobs/rekt-burger/shift/finish',
    { preHandler: [requireAuth, withIdempotency(), limit('finish', 5, 0.1)] },
    async (req, reply) => {
      const body = FinishBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.send(
        await finishShift(
          req.ctx,
          req.user!.sub,
          body.data.shiftId ?? null,
          body.data.result.orders,
        ),
      );
    },
  );

  app.post(
    '/v1/jobs/rekt-burger/leave',
    { preHandler: [requireAuth, withIdempotency(), limit('leave', 5, 0.1)] },
    async (req, reply) => reply.send(await leaveJob(req.ctx, req.user!.sub)),
  );
}
