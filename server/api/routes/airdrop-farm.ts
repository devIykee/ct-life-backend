/**
 * Airdrop Farm + Sybil jail routes (M7 #6).
 *
 *   POST /v1/airdrop/claim
 *   GET  /v1/airdrop/claims
 *   POST /v1/admin/users/{id}/sybil_jail
 *   DELETE /v1/admin/users/{id}/sybil_jail
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ForbiddenError } from '../../shared/domain/errors.js';
import {
  claimAirdrop,
  clearSybilJailed,
  listAirdropClaims,
  setSybilJailed,
} from '../../application/airdrop-farm.js';

/**
 * Register the airdrop + sybil-jail routes on the Fastify app.
 */
export function registerAirdropRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/airdrop/claim',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const out = await claimAirdrop(req.ctx, req.user!.sub);
      return reply.send(out);
    },
  );

  app.get('/v1/airdrop/claims', { preHandler: requireAuth }, async (req, reply) => {
    const out = await listAirdropClaims(req.ctx, req.user!.sub);
    return reply.send({ claims: out });
  });

  app.post(
    '/v1/admin/users/:id/sybil_jail',
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await setSybilJailed(req.ctx, id);
      return reply.send(out);
    },
  );

  app.delete(
    '/v1/admin/users/:id/sybil_jail',
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await clearSybilJailed(req.ctx, id);
      return reply.send(out);
    },
  );
}
