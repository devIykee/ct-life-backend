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
 *   GET  /v1/ads/slots/{id}/availability
 *   GET  /v1/ads/bookings/{id}
 *   POST /v1/ads/bookings/{id}/cancel
 *   POST /v1/admin/ads/bookings/{id}/approve
 *   POST /v1/admin/ads/bookings/{id}/reject
 *   POST /v1/admin/ads/bookings/{id}/refund
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
  cancelBooking,
  getBooking,
  getSlotAvailability,
  listAdSlots,
  listLiveAds,
  listMyBookings,
  MAX_UPLOAD_BYTES,
  recordRefund,
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

// imageKey/mimeType/sizeBytes may still be echoed by older clients; the
// server ignores them and reads the owned upload record instead.
const BookingBody = z.object({
  slotId: z.string().min(1),
  termId: z.string().min(1),
  uploadId: z.string().uuid(),
  link: z.string().min(1).max(500),
});

const RefundBody = z.object({ signature: z.string().min(64).max(128) });

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

  app.get('/v1/ads/slots/:id/availability', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { termId } = req.query as { termId?: string };
    return reply.send(await getSlotAvailability(req.ctx, id, termId));
  });

  // Upload a creative as raw PNG/JPEG bytes. The parser is scoped to this
  // route, capped at 1 MiB, and auth runs before any bytes are buffered.
  app.register(async (uploads) => {
    uploads.addContentTypeParser(
      ['image/png', 'image/jpeg'],
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );
    uploads.post(
      '/v1/uploads',
      {
        bodyLimit: MAX_UPLOAD_BYTES,
        onRequest: async (req, reply) => {
          await requireAuth(req, reply);
        },
        preHandler: [withIdempotency()],
      },
      async (req, reply) => {
        const mime = req.headers['content-type']?.split(';')[0]?.trim() ?? '';
        if (mime !== 'image/png' && mime !== 'image/jpeg') {
          throw new ValidationFailedError({
            reason: 'Content-Type must be image/png or image/jpeg',
          });
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
      },
    );
  });

  app.post(
    '/v1/ads/bookings',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = BookingBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await bookAd(req.ctx, req.user!.sub, body.data);
      return reply.status(201).send({
        bookingId: out.booking.bookingId,
        intent: out.intent,
        booking: out.booking,
        creative: out.creative,
      });
    },
  );

  app.get('/v1/ads/bookings', { preHandler: requireAuth }, async (req, reply) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 50);
    const rows = await listMyBookings(req.ctx, req.user!.sub, limit);
    return reply.send({ bookings: rows });
  });

  app.get('/v1/ads/bookings/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(await getBooking(req.ctx, req.user!.sub, id));
  });

  app.post(
    '/v1/ads/bookings/:id/cancel',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply.send(await cancelBooking(req.ctx, req.user!.sub, id));
    },
  );

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

  app.post(
    '/v1/admin/ads/bookings/:id/refund',
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = RefundBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.send(await recordRefund(req.ctx, id, body.data.signature));
    },
  );
}
