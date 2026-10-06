/**
 * NFT mint routes (M5 #66).
 *
 *   POST /v1/nft/mint
 *   GET  /v1/nft/inventory
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { listInventory, mint } from '../../application/nft-mint.js';

const MintBody = z.object({
  itemId: z.string().uuid(),
  network: z.enum(['devnet', 'mainnet']).optional(),
});

/**
 * Register the NFT mint routes.
 */
export function registerNftMintRoutes(app: FastifyInstance): void {
  app.post('/v1/nft/mint', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = MintBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const out = await mint(req.ctx, req.user!.sub, {
      itemId: body.data.itemId,
      network: body.data.network,
    });
    return reply.status(201).send(out);
  });

  app.get('/v1/nft/inventory', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await listInventory(req.ctx, req.user!.sub);
    return reply.send({ items: rows });
  });
}
