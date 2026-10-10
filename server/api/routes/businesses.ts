/**
 * Businesses routes (build spec #30).
 *
 *   GET  /v1/businesses
 *   POST /v1/businesses               {kindId}
 *   GET  /v1/businesses/{id}
 *   POST /v1/businesses/{id}/collect
 *   POST /v1/businesses/{id}/sell
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireUuidParam } from '../middleware/uuid-param.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  buyBusiness,
  collectBusiness,
  getBusiness,
  listOwned,
  sellBusiness,
} from '../../application/businesses.js';

const BuyBody = z.object({ kindId: z.string().min(1).max(64) });

/**
 * Register the businesses routes.
 * @param app - The Fastify instance.
 */
export function registerBusinessRoutes(app: FastifyInstance): void {
  app.get('/v1/businesses', { preHandler: requireAuth }, async (req, reply) => {
    return reply.send(await listOwned(req.ctx, req.user!.sub));
  });

  app.post(
    '/v1/businesses',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = BuyBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await buyBusiness(req.ctx, req.user!.sub, body.data.kindId);
      return reply.status(201).send(out);
    },
  );

  app.get(
    '/v1/businesses/:id',
    { preHandler: [requireAuth, requireUuidParam('id')] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply.send(await getBusiness(req.ctx, req.user!.sub, id));
    },
  );

  app.post(
    '/v1/businesses/:id/collect',
    { preHandler: [requireAuth, requireUuidParam('id'), withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply.send(await collectBusiness(req.ctx, req.user!.sub, id));
    },
  );

  app.post(
    '/v1/businesses/:id/sell',
    { preHandler: [requireAuth, requireUuidParam('id'), withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply.send(await sellBusiness(req.ctx, req.user!.sub, id));
    },
  );
}
