/**
 * Duo Shop routes: catalogue, orders, owned items and home placements.
 *
 *   GET  /v1/shop/catalog?category=
 *   POST /v1/shop/orders
 *   GET  /v1/shop/orders
 *   GET  /v1/shop/orders/:id
 *   POST /v1/shop/orders/:id/cancel
 *   GET  /v1/me/items
 *   PUT  /v1/homes/:homeId/placements
 *   GET  /v1/homes/:homeId/placements
 *
 * The cosmetics shop keeps `/v1/shop` and `/v1/shop/purchase`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  cancelOrder,
  getOrder,
  listCatalog,
  listOrders,
  MAX_LINES_PER_ORDER,
  MAX_QTY_PER_LINE,
  placeOrder,
  SHOP_CATEGORIES,
} from '../../application/shop.js';
import {
  getPlacements,
  listMyItems,
  MAX_PLACEMENTS_PER_HOME,
  setPlacements,
} from '../../application/player-items.js';

const CatalogQuery = z.object({
  category: z.enum(SHOP_CATEGORIES as [string, ...string[]]).optional(),
});

const OrderBody = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().min(1).max(64),
        qty: z.number().int().min(1).max(MAX_QTY_PER_LINE),
      }),
    )
    .min(1)
    .max(MAX_LINES_PER_ORDER),
  window: z.enum(['asap', '30m', '1h']),
  destination: z.enum(['door', 'locker']),
});

const OrderParams = z.object({ id: z.string().uuid() });
const HomeParams = z.object({ homeId: z.string().min(1).max(100) });

const PlacementsBody = z.object({
  placements: z
    .array(
      z.object({
        itemInstanceId: z.string().uuid(),
        x: z.number().finite(),
        z: z.number().finite(),
        rotY: z.number().finite(),
      }),
    )
    .max(MAX_PLACEMENTS_PER_HOME),
});

/**
 * Register the Duo Shop routes.
 * @param app - The Fastify instance.
 */
export function registerShopRoutes(app: FastifyInstance): void {
  app.get('/v1/shop/catalog', { preHandler: requireAuth }, async (req, reply) => {
    const q = CatalogQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const out = await listCatalog(
      req.ctx,
      (q.data.category as (typeof SHOP_CATEGORIES)[number] | undefined) ?? null,
    );
    return reply.send(out);
  });

  app.post(
    '/v1/shop/orders',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = OrderBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const key = req.headers['idempotency-key'] as string;
      const out = await placeOrder(req.ctx, req.user!.sub, body.data, key);
      return reply.status(201).send(out);
    },
  );

  app.get('/v1/shop/orders', { preHandler: requireAuth }, async (req, reply) => {
    const items = await listOrders(req.ctx, req.user!.sub);
    return reply.send({ items });
  });

  app.get('/v1/shop/orders/:id', { preHandler: requireAuth }, async (req, reply) => {
    const p = OrderParams.safeParse(req.params);
    if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
    return reply.send(await getOrder(req.ctx, req.user!.sub, p.data.id));
  });

  app.post(
    '/v1/shop/orders/:id/cancel',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = OrderParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      return reply.send(await cancelOrder(req.ctx, req.user!.sub, p.data.id));
    },
  );

  app.get('/v1/me/items', { preHandler: requireAuth }, async (req, reply) => {
    const items = await listMyItems(req.ctx, req.user!.sub);
    return reply.send({ items });
  });

  app.put(
    '/v1/homes/:homeId/placements',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const p = HomeParams.safeParse(req.params);
      if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
      const body = PlacementsBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await setPlacements(req.ctx, p.data.homeId, req.user!.sub, body.data.placements);
      return reply.send(out);
    },
  );

  app.get('/v1/homes/:homeId/placements', { preHandler: requireAuth }, async (req, reply) => {
    const p = HomeParams.safeParse(req.params);
    if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
    return reply.send(await getPlacements(req.ctx, p.data.homeId, req.user!.sub));
  });
}
