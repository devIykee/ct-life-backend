/**
 * Homes routes (M4 #52).
 *
 *   GET  /v1/homes
 *   POST /v1/homes
 *   POST /v1/homes/:homeId/rent
 *   POST /v1/homes/:homeId/move-out
 *   POST /v1/homes/:homeId/guests/:userId
 *   DELETE /v1/homes/:homeId/guests/:userId
 *   POST /v1/homes/:ownerId/visit
 *   GET  /v1/homes/:id
 *   GET  /v1/units/:unitId/access
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  addGuest,
  createHome,
  getHome,
  listHomeTypes,
  moveOut,
  payRent,
  recordVisit,
  removeGuest,
} from '../../application/homes.js';
import { unitAccess } from '../../application/home-units.js';

const HomeKind = z.enum([
  'parents_basement',
  'hacker_house',
  'studio',
  'penthouse',
  'marina_villa',
]);

const CreateBody = z.object({ kind: HomeKind });
const GuestParams = z.object({ homeId: z.string().min(1), userId: z.string().uuid() });

/**
 * Register homes routes.
 * @param app - The Fastify instance.
 */
export function registerHomeRoutes(app: FastifyInstance): void {
  // B26: GET /v1/homes - list available home types
  app.get('/v1/homes', { preHandler: requireAuth }, async (req, reply) => {
    const types = await listHomeTypes(req.ctx);
    return reply.send(types);
  });

  app.post('/v1/homes', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const out = await createHome(req.ctx, req.user!.sub, body.data.kind);
    return reply.send(out); // B26: return 200, not 201
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
    '/v1/homes/:homeId/move-out',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { homeId } = req.params as { homeId: string };
      const out = await moveOut(req.ctx, homeId, req.user!.sub);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/homes/:homeId/guests/:userId',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = GuestParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      const out = await addGuest(req.ctx, p.data.homeId, req.user!.sub, p.data.userId);
      return reply.send(out);
    },
  );

  app.delete(
    '/v1/homes/:homeId/guests/:userId',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = GuestParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      const out = await removeGuest(req.ctx, p.data.homeId, req.user!.sub, p.data.userId);
      return reply.send(out);
    },
  );

  // Only ever about the caller: can *I* open this door.
  app.get('/v1/units/:unitId/access', { preHandler: requireAuth }, async (req, reply) => {
    const { unitId } = req.params as { unitId: string };
    const out = await unitAccess(req.ctx, unitId, req.user!.sub);
    return reply.send(out);
  });

  app.post(
    '/v1/homes/:ownerId/visit',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { ownerId } = req.params as { ownerId: string };
      const out = await recordVisit(req.ctx, ownerId, req.user!.sub);
      return reply.send(out); // B26: return 200, not 201
    },
  );

  app.get('/v1/homes/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await getHome(req.ctx, id);
    return reply.send(out);
  });
}
