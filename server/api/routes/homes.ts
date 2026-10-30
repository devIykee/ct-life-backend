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
 *   POST /v1/homes/move                 (capability homeMove)
 *   GET  /v1/homes/me/settings          (capability visitorPolicy)
 *   PUT  /v1/homes/me/settings          (capability visitorPolicy)
 *   POST /v1/homes/:ownerId/knock       (capability visitorPolicy)
 *   POST /v1/units/:unitId/knock        (capability visitorPolicy)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireCapability } from '../middleware/capability.js';
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
import { moveHome } from '../../application/home-move.js';
import { knock, knockUnit } from '../../application/home-knock.js';
import {
  VisitorPolicySchema,
  getHomeSettings,
  putHomeSettings,
} from '../../application/home-settings.js';

const HomeKind = z.enum([
  'parents_basement',
  'hacker_house',
  'studio',
  'penthouse',
  'marina_villa',
]);

const CreateBody = z.object({ kind: HomeKind });
const SettingsBody = z.object({ visitors: VisitorPolicySchema }).strict();
const KnockParams = z.object({ ownerId: z.string().uuid() });
const UnitParams = z.object({ unitId: z.string().min(1).max(200) });
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

  // Unlock D1: give up the current lease and take a new one, atomically.
  app.post(
    '/v1/homes/move',
    { preHandler: [requireCapability('homeMove'), requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = CreateBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await moveHome(req.ctx, req.user!.sub, body.data.kind);
      return reply.send(out);
    },
  );

  // Unlock D2: who may visit (open | followers | closed).
  app.get(
    '/v1/homes/me/settings',
    { preHandler: [requireCapability('visitorPolicy'), requireAuth] },
    async (req, reply) => reply.send(await getHomeSettings(req.ctx, req.user!.sub)),
  );

  app.put(
    '/v1/homes/me/settings',
    { preHandler: [requireCapability('visitorPolicy'), requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = SettingsBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.send(await putHomeSettings(req.ctx, req.user!.sub, body.data.visitors));
    },
  );

  // Unlock D5: knock on a door; the owner gets `home_knock`.
  app.post(
    '/v1/homes/:ownerId/knock',
    { preHandler: [requireCapability('visitorPolicy'), requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = KnockParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      await knock(req.ctx, req.user!.sub, p.data.ownerId);
      return reply.status(204).send();
    },
  );

  // Knock on a flat door; the owner is resolved here and never shown to the knocker.
  app.post(
    '/v1/units/:unitId/knock',
    { preHandler: [requireCapability('visitorPolicy'), requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = UnitParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      await knockUnit(req.ctx, req.user!.sub, p.data.unitId);
      return reply.status(204).send();
    },
  );

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
    const out = await getHome(req.ctx, id, req.user!.sub);
    return reply.send(out);
  });
}
