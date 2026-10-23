/**
 * Entitlement routes.
 *
 *   GET /v1/me/entitlements — the player's owned item keys
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { listEntitlements, syncFromWallet } from '../../application/entitlements.js';

/**
 * Register the entitlement routes on the Fastify app.
 */
export function registerEntitlementRoutes(app: FastifyInstance): void {
  app.get('/v1/me/entitlements', { preHandler: requireAuth }, async (req, reply) => {
    await syncFromWallet(req.ctx, req.user!.sub);
    return reply.send(await listEntitlements(req.ctx, req.user!.sub));
  });
}
