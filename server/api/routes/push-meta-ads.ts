/**
 * Push + Meta + Ads routes (M4 #54 + M5 #64).
 *
 *   POST /v1/push/register
 *   GET  /v1/meta/current
 *   POST /v1/admin/meta
 *   GET  /v1/ads/live
 *   GET  /v1/ads/slots
 *   POST /v1/uploads
 *   POST /v1/ads/bookings
 *   GET  /v1/ads/bookings
 *   POST /v1/admin/ads/bookings/{id}/approve
 *   POST /v1/admin/ads/bookings/{id}/reject
 *
 * Admin routes require an admin role from the JWT.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { registerDevice } from '../../application/push.js';
import { getCurrentMeta, setCurrentMeta } from '../../application/meta.js';
import {
  approveBooking,
  bookAd,
  listAdSlots,
  listLiveAds,
  listMyBookings,
  rejectBooking,
  uploadCreative,
} from '../../application/ads.js';

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
  slotId: z.string().min(1),
  termId: z.string().min(1),
  uploadId: z.string().uuid(),
  imageKey: z.string().min(1),
  mimeType: z.enum(['image/png', 'image/jpeg']),
  sizeBytes: z.number().int().min(1).max(1_048_576),
  link: z.string().min(1).max(500),
});

/**
 * Register the push + meta + ads routes.
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
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const body = MetaBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await setCurrentMeta(req.ctx, body.data.value);
      return reply.send(out);
    },
  );

  // Ads
  app.get('/v1/ads/live', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await listLiveAds(req.ctx);
    return reply.send({ ads: rows });
  });

  app.get('/v1/ads/slots', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await listAdSlots(req.ctx);
    return reply.send({ slots: rows });
  });

  // Upload a creative. The body is raw bytes; the
  // content-type parser stores the Buffer in `req.body`.
  app.post('/v1/uploads', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const mime = (req.headers['content-type'] as string | undefined) ?? '';
    if (mime !== 'image/png' && mime !== 'image/jpeg') {
      throw new ValidationFailedError({ reason: 'Content-Type must be image/png or image/jpeg' });
    }
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes)) {
      throw new ValidationFailedError({ reason: 'upload body must be raw bytes' });
    }
    const out = await uploadCreative(req.ctx, req.user!.sub, {
      mimeType: mime,
      bytes,
      filename: 'creative',
    });
    return reply.status(201).send(out);
  });

  app.post(
    '/v1/ads/bookings',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = BookingBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await bookAd(req.ctx, req.user!.sub, body.data);
      return reply.status(201).send({ booking: out.booking, creative: out.creative });
    },
  );

  app.get('/v1/ads/bookings', { preHandler: requireAuth }, async (req, reply) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    const rows = await listMyBookings(req.ctx, req.user!.sub, limit);
    return reply.send({ bookings: rows });
  });

  app.post(
    '/v1/admin/ads/bookings/:id/approve',
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await approveBooking(req.ctx, id);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/admin/ads/bookings/:id/reject',
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await rejectBooking(req.ctx, id);
      return reply.send(out);
    },
  );
}
