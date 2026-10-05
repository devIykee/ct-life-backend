/**
 * Push + Meta + Ads routes (M4 #54).
 *
 *   POST /v1/push/register
 *   GET  /v1/meta/current
 *   POST /v1/admin/meta
 *   GET  /v1/ads/live
 *   GET  /v1/ads/slots
 *   POST /v1/ads/bookings
 *
 * Admin routes (POST /v1/admin/meta) require an admin role from
 * the JWT; the M2 JWT carries the role claim already.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError, ForbiddenError } from '../../shared/domain/errors.js';
import { registerDevice } from '../../application/push.js';
import { getCurrentMeta, setCurrentMeta } from '../../application/meta.js';
import { bookAd, listAdSlots, listLiveAds } from '../../application/ads.js';

const RegisterBody = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  apnsToken: z.string().nullable().optional(),
  fcmToken: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const MetaBody = z.object({
  value: z.unknown(),
});

const BookingBody = z.object({
  slotId: z.string(),
  termId: z.string(),
  uploadId: z.string(),
  link: z.string().min(1).max(500),
});

/**
 *
 */
export function registerPushMetaAdRoutes(app: FastifyInstance): void {
  // Push
  app.post(
    '/v1/push/register',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = RegisterBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await registerDevice(req.ctx, req.user!.sub, {
        platform: body.data.platform,
        apnsToken: body.data.apnsToken ?? null,
        fcmToken: body.data.fcmToken ?? null,
        enabled: body.data.enabled,
      });
      return reply.status(201).send(out);
    },
  );

  // Meta
  app.get('/v1/meta/current', { preHandler: requireAuth }, async (req, reply) => {
    const out = await getCurrentMeta(req.ctx);
    return reply.send(out);
  });

  app.post(
    '/v1/admin/meta',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      // The M4 slice uses the role claim from the JWT. Admin
      // tokens are minted via /v1/auth/dev (mock) or the CI
      // mint helper.
      const role = (req.user as { role?: string } | undefined)?.role ?? 'user';
      if (role !== 'admin') {
        throw new ForbiddenError({ reason: 'admin role required' });
      }
      const body = MetaBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await setCurrentMeta(req.ctx, body.data.value);
      return reply.send(out);
    },
  );

  // Ads
  app.get('/v1/ads/live', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await listLiveAds(req.ctx);
    void rows;
    void req;
    return reply.send({ ads: rows });
  });

  app.get('/v1/ads/slots', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = await listAdSlots();
    return reply.send({ slots: rows });
  });

  app.post(
    '/v1/ads/bookings',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = BookingBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await bookAd(req.ctx, req.user!.sub, body.data);
      return reply.status(201).send(out);
    },
  );
}

void ForbiddenError;
