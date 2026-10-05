/**
 * Cosmetics routes (M5 #59).
 *
 *   GET  /v1/shop                — list shop items (optional ?slot=)
 *   POST /v1/shop/purchase       — body: { itemId }
 *   GET  /v1/inventory           — list the user's owned cosmetics
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { listInventory, listShop, purchase } from '../../application/cosmetics.js';

const SLOTS = ['skin', 'head', 'hair', 'top', 'bottom', 'shoes', 'acc'] as const;

const PurchaseBody = z.object({
  itemId: z.string().uuid(),
});

const ShopQuery = z.object({
  slot: z.enum(SLOTS).optional(),
});

/**
 * Register the cosmetics routes on the Fastify app.
 *
 *   GET  /v1/shop
 *   POST /v1/shop/purchase
 *   GET  /v1/inventory
 */
export function registerCosmeticRoutes(app: FastifyInstance): void {
  app.get('/v1/shop', { preHandler: requireAuth }, async (req, reply) => {
    const q = ShopQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const items = await listShop(req.ctx, q.data.slot ?? null);
    return reply.send({ items });
  });

  app.post(
    '/v1/shop/purchase',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = PurchaseBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await purchase(req.ctx, req.user!.sub, body.data.itemId);
      return reply.status(201).send(out);
    },
  );

  app.get('/v1/inventory', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await listInventory(req.ctx, req.user!.sub);
    return reply.send({ items: rows });
  });
}
