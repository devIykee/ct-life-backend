/**
 * Event calendar routes.
 *
 *   GET  /v1/events/active             (capability worldEvents)
 *   GET  /v1/events/current
 *   GET  /v1/events/upcoming?limit=
 *   GET  /v1/events/:slug
 *   POST /v1/events/:slug/progress     { step, proof: { id, answer? } }
 *   POST /v1/events/:slug/irl/:handle/dm   { text }
 *   PUT  /v1/admin/events/:slug        (ADMIN_WALLETS)
 *
 * Same pattern as `GET /v1/meta/current`. See server/application/events.ts
 * for what the progress proof verifies and what it cannot.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { listActiveWorldEvents } from '../../application/world-events.js';
import { withIdempotency } from '../middleware/idempotency.js';
import {
  checkIn,
  IRL_DM_PER_HOUR,
  listAttendees,
  messageAttendee,
  setVisibility,
} from '../../application/events-irl.js';
import { RateLimitedError, ValidationFailedError } from '../../shared/domain/errors.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';
import {
  GEOFENCE_MAX_RADIUS_M,
  GEOFENCE_MIN_RADIUS_M,
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
    // The venue geofence for the opt-in IRL check-in; null turns the check-in off.
    // All four fields are required together; bounds are re-checked in the service.
    geofence: z
      .object({
        lat: z.number().finite().min(-90).max(90),
        lng: z.number().finite().min(-180).max(180),
        radiusM: z.number().int().min(GEOFENCE_MIN_RADIUS_M).max(GEOFENCE_MAX_RADIUS_M),
        source: z.string().trim().min(1).max(500),
      })
      .strict()
      .nullable(),
  })
  .partial()
  .strict();

const CheckinBody = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    accuracyM: z.number().finite().min(0).max(100_000),
    isMock: z.boolean(),
  })
  .strict();
const HandleParams = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(64),
  handle: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});
const IrlDmBody = z.object({ text: z.string().min(1).max(500) }).strict();
const VisibilityBody = z.object({ visible: z.boolean() }).strict();
const IrlQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(100).optional(),
});

/** Check-in attempts per player per hour. */
export const CHECKIN_ATTEMPTS_PER_HOUR = 3;

/** Progress calls allowed in a burst, and refilled per second, per player. */
export const PROGRESS_BURST = 8;
export const PROGRESS_REFILL_PER_SEC = 0.5;

/**
 * Register the event calendar routes.
 * @param app - The Fastify instance.
 */
export function registerEventRoutes(app: FastifyInstance): void {
  // Recent world events (evt_*), newest first: last 2 h, at most 50. Registered
  // before /v1/events/:slug so `active` is never read as a slug.
  app.get(
    '/v1/events/active',
    { preHandler: [requireCapability('worldEvents'), requireAuth] },
    async (req, reply) => reply.send({ events: await listActiveWorldEvents(req.ctx.redis.main) }),
  );

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

  // The body of this route is a position. It is never logged (redacted), never
  // stored, and never echoed; see docs/PRIVACY_IRL_CHECKIN.md.
  app.post(
    '/v1/events/:slug/checkin',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = SlugParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      const b = CheckinBody.safeParse(req.body);
      // Issues name fields only, never the submitted values.
      if (!b.success)
        throw new ValidationFailedError({ fields: b.error.issues.map((i) => i.path) });
      const userId = req.user!.sub;
      const decision = await perUserTokenBucket(
        req.ctx.redis.main,
        `rl:event-checkin:${userId}`,
        CHECKIN_ATTEMPTS_PER_HOUR,
        CHECKIN_ATTEMPTS_PER_HOUR / 3600,
        1,
      );
      if (!decision.allowed) {
        reply.header('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
        throw new RateLimitedError(decision.retryAfterMs, { limit: CHECKIN_ATTEMPTS_PER_HOUR });
      }
      return reply.send(await checkIn(req.ctx, userId, p.data.slug, b.data));
    },
  );

  app.put(
    '/v1/events/:slug/checkin/visibility',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = SlugParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      const b = VisibilityBody.safeParse(req.body);
      if (!b.success) throw new ValidationFailedError({ issues: b.error.issues });
      return reply.send(await setVisibility(req.ctx, req.user!.sub, p.data.slug, b.data.visible));
    },
  );

  app.get('/v1/events/:slug/irl', { preHandler: requireAuth }, async (req, reply) => {
    const p = SlugParams.safeParse(req.params);
    if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
    const q = IrlQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    return reply.send(
      await listAttendees(req.ctx, req.user!.sub, p.data.slug, q.data.limit, q.data.cursor ?? null),
    );
  });

  app.post(
    '/v1/events/:slug/irl/:handle/dm',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = HandleParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      const b = IrlDmBody.safeParse(req.body);
      if (!b.success) throw new ValidationFailedError({ issues: b.error.issues });
      const userId = req.user!.sub;
      const decision = await perUserTokenBucket(
        req.ctx.redis.main,
        `rl:event-irl-dm:${userId}`,
        IRL_DM_PER_HOUR,
        IRL_DM_PER_HOUR / 3600,
        1,
      );
      if (!decision.allowed) {
        reply.header('Retry-After', String(Math.ceil(decision.retryAfterMs / 1000)));
        throw new RateLimitedError(decision.retryAfterMs, { limit: IRL_DM_PER_HOUR });
      }
      return reply
        .status(201)
        .send(await messageAttendee(req.ctx, userId, p.data.slug, p.data.handle, b.data.text));
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
