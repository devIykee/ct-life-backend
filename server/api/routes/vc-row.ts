/**
 * VC Row routes (unlock WP-B B2), all behind the `vc` capability
 * (503 CAPABILITY_OFF until it is in CAPABILITIES_ON):
 *
 *   GET  /v1/projects/{id}/vc-offers
 *   POST /v1/vc-offers/{offerId}/accept
 *   POST /v1/vc-offers/{offerId}/decline
 *   GET  /v1/vc-row/deals?cursor&limit
 *
 * Registered from registerProjectRoutes (projects.ts).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  acceptVcOffer,
  declineVcOffer,
  listVcDeals,
  listVcOffers,
} from '../../application/vc-row.js';

const DealQuery = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Register the VC Row routes.
 * @param app - The Fastify instance.
 */
export function registerVcRoutes(app: FastifyInstance): void {
  const vc = requireCapability('vc');

  app.get('/v1/projects/:id/vc-offers', { preHandler: [vc, requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(await listVcOffers(req.ctx, req.user!.sub, id));
  });

  app.post(
    '/v1/vc-offers/:offerId/accept',
    { preHandler: [vc, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { offerId } = req.params as { offerId: string };
      return reply.send(await acceptVcOffer(req.ctx, req.user!.sub, offerId));
    },
  );

  app.post(
    '/v1/vc-offers/:offerId/decline',
    { preHandler: [vc, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { offerId } = req.params as { offerId: string };
      return reply.send(await declineVcOffer(req.ctx, req.user!.sub, offerId));
    },
  );

  app.get('/v1/vc-row/deals', { preHandler: [vc, requireAuth] }, async (req, reply) => {
    const q = DealQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    return reply.send(await listVcDeals(req.ctx, q.data.cursor ?? null, q.data.limit));
  });
}
