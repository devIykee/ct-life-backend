/**
 * Dubai Marina + Cabal Lounge routes (M7 #7).
 *
 *   POST /v1/homes/:id/marina/visit
 *   POST /v1/cabal/invites               {guestUserId?} (targeted: capability cabalInvites)
 *   POST /v1/cabal/invites/:id/accept
 *   POST /v1/cabal/invites/:id/revoke    (capability cabalRevoke)
 *   GET  /v1/cabal/invites
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireCapability } from '../middleware/capability.js';
import { assertCapabilityOn } from '../../application/capabilities.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  acceptCabalInvite,
  createCabalInvite,
  listCabalInvites,
  marinaVisit,
  revokeCabalInvite,
  getMyCabal,
  getVenueAccess,
} from '../../application/venues-gating.js';

const CreateInviteBody = z
  .object({ guestUserId: z.string().uuid().nullable().optional() })
  .strict()
  .nullable()
  .optional();
const InviteParams = z.object({ id: z.string().uuid() });

const CabalListQuery = z.object({
  hostId: z.string().uuid().optional(),
  guestId: z.string().uuid().optional(),
  used: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Register the venues-gating routes on the Fastify app.
 */
export function registerVenuesGatingRoutes(app: FastifyInstance): void {
  // GET /v1/venues/{venueId}/access - was 404 "No route". Lets the client
  // explain a refusal before joinOrCreate instead of failing blind.
  app.get('/v1/venues/:venueId/access', { preHandler: requireAuth }, async (req, reply) => {
    const { venueId } = req.params as { venueId: string };
    return reply.send(await getVenueAccess(req.ctx, req.user!.sub, venueId));
  });

  // GET /v1/me/cabal - was 404 "No route".
  app.get('/v1/me/cabal', { preHandler: requireAuth }, async (req, reply) => {
    return reply.send(await getMyCabal(req.ctx, req.user!.sub));
  });

  app.post(
    '/v1/homes/:id/marina/visit',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await marinaVisit(req.ctx, req.user!.sub, id);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/cabal/invites',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const b = CreateInviteBody.safeParse(req.body ?? undefined);
      if (!b.success) throw new ValidationFailedError({ issues: b.error.issues });
      const guestUserId = b.data?.guestUserId ?? null;
      // Open invites predate the unlock; inviting one player is the new capability.
      if (guestUserId !== null) assertCapabilityOn(req.ctx, 'cabalInvites');
      const out = await createCabalInvite(req.ctx, req.user!.sub, guestUserId);
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/cabal/invites/:id/accept',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await acceptCabalInvite(req.ctx, req.user!.sub, id);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/cabal/invites/:id/revoke',
    { preHandler: [requireCapability('cabalRevoke'), requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = InviteParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      return reply.send(await revokeCabalInvite(req.ctx, req.user!.sub, p.data.id));
    },
  );

  app.get('/v1/cabal/invites', { preHandler: requireAuth }, async (req, reply) => {
    const q = CabalListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const used = q.data.used === undefined ? undefined : q.data.used === 'true';
    // B2 fix: restrict to caller's invites only (as host or guest)
    const out = await listCabalInvites(
      req.ctx,
      req.user!.sub,
      {
        hostUserId: q.data.hostId,
        guestUserId: q.data.guestId,
        used,
      },
      q.data.limit ?? 30,
    );
    return reply.send({ invites: out });
  });
}
