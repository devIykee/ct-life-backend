/**
 * Job routes: the Rekt Burger fallback job.
 *
 *   GET  /v1/jobs/rekt-burger
 *   POST /v1/jobs/rekt-burger/shift/start
 *   POST /v1/jobs/rekt-burger/shift/end      (clock out; pays by server time)
 *   GET  /v1/jobs/rekt-burger/shift/current  (restore after a relaunch)
 *   POST /v1/jobs/rekt-burger/shift/finish   (410 Gone: the per-ticket minigame was removed)
 *   POST /v1/jobs/rekt-burger/leave
 *
 * Every route works on the caller's own job state and shifts (the user id comes from the
 * token, never from the path or body); a shift id that is not the caller's is a 404.
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { GoneError, RateLimitedError } from '../../shared/domain/errors.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';
import {
  endShift,
  getCurrentShift,
  getRektBurger,
  leaveJob,
  startShift,
} from '../../application/rekt-burger.js';

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
    '/v1/jobs/rekt-burger/shift/end',
    { preHandler: [requireAuth, withIdempotency(), limit('end', 5, 0.1)] },
    async (req, reply) => reply.send(await endShift(req.ctx, req.user!.sub)),
  );

  app.get(
    '/v1/jobs/rekt-burger/shift/current',
    { preHandler: [requireAuth, limit('current', 20, 2)] },
    async (req, reply) => reply.send(await getCurrentShift(req.ctx, req.user!.sub)),
  );

  // The per-ticket minigame is gone: pay is by time on the clock. Kept as an explicit 410 so an
  // old client gets a clear answer instead of a 404.
  app.post('/v1/jobs/rekt-burger/shift/finish', { preHandler: [requireAuth] }, async () => {
    throw new GoneError({ use: '/v1/jobs/rekt-burger/shift/end' });
  });

  app.post(
    '/v1/jobs/rekt-burger/leave',
    { preHandler: [requireAuth, withIdempotency(), limit('leave', 5, 0.1)] },
    async (req, reply) => reply.send(await leaveJob(req.ctx, req.user!.sub)),
  );
}
