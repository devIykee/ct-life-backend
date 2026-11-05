/**
 * Map Travel routes (docs/TRAVEL.md). Dark behind capability `travel` (503 CAPABILITY_OFF).
 *
 *   GET  /v1/travel/quote?to=<venueId>
 *   POST /v1/travel/trips               { quoteId, mode: bus | taxi }   Idempotency-Key
 *   GET  /v1/travel/trips/current
 *   POST /v1/travel/trips/:id/cancel    Idempotency-Key
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireNotJailed } from '../middleware/jail.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  bookTrip,
  cancelTrip,
  currentTrip,
  quoteTravel,
  RIDE_MODES,
} from '../../application/travel.js';

const QuoteQuery = z.object({ to: z.string().min(1).max(64) });
// Walking is never booked: `mode: walk` fails validation (400).
const TripBody = z.object({
  quoteId: z.string().uuid(),
  mode: z.enum(RIDE_MODES),
});
const TripParams = z.object({ id: z.string().uuid() });

/**
 * Register the Map Travel routes.
 * @param app - The Fastify instance.
 */
export function registerTravelRoutes(app: FastifyInstance): void {
  const gate = requireCapability('travel');

  app.get('/v1/travel/quote', { preHandler: [gate, requireAuth] }, async (req, reply) => {
    const q = QuoteQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    return reply.send(await quoteTravel(req.ctx, req.user!.sub, q.data.to));
  });

  app.post(
    '/v1/travel/trips',
    { preHandler: [gate, requireAuth, requireNotJailed, withIdempotency()] },
    async (req, reply) => {
      const body = TripBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const key = req.headers['idempotency-key'] as string;
      const trip = await bookTrip(req.ctx, req.user!.sub, body.data, key);
      return reply.status(201).send(trip);
    },
  );

  app.get('/v1/travel/trips/current', { preHandler: [gate, requireAuth] }, async (req, reply) =>
    reply.send(await currentTrip(req.ctx, req.user!.sub)),
  );

  app.post(
    '/v1/travel/trips/:id/cancel',
    { preHandler: [gate, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = TripParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      return reply.send(await cancelTrip(req.ctx, req.user!.sub, p.data.id));
    },
  );
}
