/**
 * Gigs routes (M5 #63).
 *
 *   GET  /v1/gigs
 *   POST /v1/gigs/{gigId}/run
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { listGigs, runGig } from '../../application/gigs.js';

const GIG_IDS = [
  'food_delivery',
  'data_entry',
  'dog_walking',
  'ad_clicks',
  'social_moderation',
] as const;

const RunBody = z
  .object({
    distanceKm: z.number().nonnegative().optional(),
    correctRows: z.number().nonnegative().optional(),
    blocks30min: z.number().nonnegative().optional(),
    clicks: z.number().nonnegative().optional(),
    hoursOnline: z.number().nonnegative().optional(),
  })
  .optional();

/**
 * Register the gigs routes.
 */
export function registerGigRoutes(app: FastifyInstance): void {
  app.get('/v1/gigs', { preHandler: requireAuth }, async (_req, reply) => {
    return reply.send({ gigs: listGigs() });
  });

  app.post(
    '/v1/gigs/:gigId/run',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { gigId } = req.params as { gigId: string };
      if (!(GIG_IDS as readonly string[]).includes(gigId)) {
        throw new ValidationFailedError({ reason: `unknown gigId ${gigId}` });
      }
      const parsed = RunBody.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationFailedError({ issues: parsed.error.issues });
      const out = await runGig(
        req.ctx,
        req.user!.sub,
        gigId as (typeof GIG_IDS)[number],
        parsed.data ?? {},
      );
      return reply.status(201).send(out);
    },
  );
}
