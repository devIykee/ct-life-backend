/**
 * Event calendar routes.
 *
 *   GET  /v1/events/current
 *   GET  /v1/events/upcoming?limit=
 *   GET  /v1/events/:slug
 *   POST /v1/events/:slug/progress     { step, proof: { id, answer? } }
 *   PUT  /v1/admin/events/:slug        (ADMIN_WALLETS)
 *
 * Same pattern as `GET /v1/meta/current`. See server/application/events.ts
 * for what the progress proof verifies and what it cannot.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { RateLimitedError, ValidationFailedError } from '../../shared/domain/errors.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';
import {
  getEvent,
  listCurrent,
  listUpcoming,
  submitProgress,
  updateEvent,
} from '../../application/events.js';

const SlugParams = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(64),
});
const UpcomingQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });

const ProgressBody = z.object({
  step: z.string().min(1).max(32),
  proof: z.object({
    id: z.string().min(1).max(64),
    answer: z.string().min(1).max(16).optional(),
  }),
});

const iso = z.string().datetime();
const AdminBody = z
  .object({
    title: z.string().min(1).max(120),
    startsAt: iso,
    endsAt: iso,
    city: z.string().min(1).max(80),
    realVenue: z.string().min(1).max(120),
    streamUrl: z.string().url().startsWith('https://').max(500).nullable(),
    sourceUrl: z.string().url().startsWith('https://').max(500),
  })
  .partial()
  .strict();

/** Progress calls allowed in a burst, and refilled per second, per player. */
export const PROGRESS_BURST = 8;
export const PROGRESS_REFILL_PER_SEC = 0.5;

/**
 * Register the event calendar routes.
 * @param app - The Fastify instance.
 */
export function registerEventRoutes(app: FastifyInstance): void {
  app.get('/v1/events/current', { preHandler: requireAuth }, async (req, reply) =>
    reply.send(await listCurrent(req.ctx)),
  );

  app.get('/v1/events/upcoming', { preHandler: requireAuth }, async (req, reply) => {
    const q = UpcomingQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    return reply.send(await listUpcoming(req.ctx, q.data.limit));
  });

  app.get('/v1/events/:slug', { preHandler: requireAuth }, async (req, reply) => {
    const p = SlugParams.safeParse(req.params);
    if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
    return reply.send(await getEvent(req.ctx, req.user!.sub, p.data.slug));
  });

  app.post(
    '/v1/events/:slug/progress',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = SlugParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      const b = ProgressBody.safeParse(req.body);
      if (!b.success) throw new ValidationFailedError({ issues: b.error.issues });
      const userId = req.user!.sub;
      const decision = await perUserTokenBucket(
        req.ctx.redis.main,
        `rl:event-progress:${userId}`,
        PROGRESS_BURST,
        PROGRESS_REFILL_PER_SEC,
        1,
      );
      if (!decision.allowed) {
        reply.header('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
        throw new RateLimitedError(decision.retryAfterMs, { limit: PROGRESS_REFILL_PER_SEC });
      }
      return reply.send(
        await submitProgress(req.ctx, userId, p.data.slug, b.data.step, b.data.proof),
      );
    },
  );

  app.put(
    '/v1/admin/events/:slug',
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const p = SlugParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      const b = AdminBody.safeParse(req.body);
      if (!b.success) throw new ValidationFailedError({ issues: b.error.issues });
      return reply.send(await updateEvent(req.ctx, p.data.slug, b.data));
    },
  );
}
