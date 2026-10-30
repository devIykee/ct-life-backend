/**
 * Devnet test tokens (unlock WP-C; capability `devnetDrip`). Devnet only.
 *
 *   GET  /v1/devnet/test-tokens   USDC faucet link + my SOL drip status
 *   POST /v1/devnet/drip          today's SOL drip (0.02 SOL by default) to my wallet
 */
import type { FastifyInstance } from 'fastify';
import { requireCapability } from '../middleware/capability.js';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requestDrip, testTokensInfo } from '../../application/devnet-drip.js';

/**
 * Register the devnet test-token routes.
 * @param app - The Fastify instance.
 */
export function registerDevnetDripRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/devnet/test-tokens',
    { preHandler: [requireCapability('devnetDrip'), requireAuth] },
    async (req, reply) => reply.send(await testTokensInfo(req.ctx, req.user!.sub)),
  );

  app.post(
    '/v1/devnet/drip',
    { preHandler: [requireCapability('devnetDrip'), requireAuth, withIdempotency()] },
    async (req, reply) => reply.send(await requestDrip(req.ctx, req.user!.sub)),
  );
}
