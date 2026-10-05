/**
 * Businesses routes (M5 #62).
 *
 *   POST /v1/businesses
 *   GET  /v1/businesses/{id}
 *   POST /v1/businesses/{id}/run
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { createBusiness, getBusiness, runBusiness } from '../../application/businesses.js';

const KINDS = ['lemonade_stand', 'laundromat', 'cafe', 'shop', 'arcade'] as const;

const CreateBody = z.object({
  kind: z.enum(KINDS),
});

/**
 * Register the businesses routes.
 */
export function registerBusinessRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/businesses',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = CreateBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await createBusiness(req.ctx, req.user!.sub, body.data.kind);
      return reply.status(201).send(out);
    },
  );

  app.get('/v1/businesses/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await getBusiness(req.ctx, id);
    return reply.send(out);
  });

  app.post(
    '/v1/businesses/:id/run',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await runBusiness(req.ctx, id, req.user!.sub);
      return reply.send(out);
    },
  );
}
