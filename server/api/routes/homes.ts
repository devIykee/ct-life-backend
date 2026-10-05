/**
 * Homes routes (M4 #52).
 *
 *   POST /v1/homes
 *   POST /v1/homes/:homeId/rent
 *   POST /v1/homes/:ownerId/visit
 *   GET  /v1/homes/:id
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { createHome, getHome, payRent, recordVisit } from '../../application/homes.js';

const HomeKind = z.enum([
  'parents_basement',
  'hacker_house',
  'studio',
  'penthouse',
  'marina_villa',
]);

const CreateBody = z.object({ kind: HomeKind });

/**
 * Register homes routes.
 * @param app - The Fastify instance.
 */
export function registerHomeRoutes(app: FastifyInstance): void {
  app.post('/v1/homes', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const out = await createHome(req.ctx, req.user!.sub, body.data.kind);
    return reply.status(201).send(out);
  });

  app.post(
    '/v1/homes/:homeId/rent',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { homeId } = req.params as { homeId: string };
      const out = await payRent(req.ctx, homeId, req.user!.sub);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/homes/:ownerId/visit',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { ownerId } = req.params as { ownerId: string };
      const out = await recordVisit(req.ctx, ownerId, req.user!.sub);
      return reply.status(201).send(out);
    },
  );

  app.get('/v1/homes/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await getHome(req.ctx, id);
    return reply.send(out);
  });
}
