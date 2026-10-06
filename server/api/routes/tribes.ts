/**
 * Tribes + district routes (M7 #1).
 *
 *   GET /v1/tribes
 *   GET /v1/tribes/:id
 *   GET /v1/tribes/:id/districts
 *   GET /v1/districts
 *   GET /v1/districts/:id
 *   GET /v1/districts/:id/owner
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import {
  getDistrict,
  getDistrictOwner,
  getTribe,
  listDistricts,
  listTribes,
} from '../../application/tribes.js';

/**
 * Register the tribes + district routes on the Fastify app.
 */
export function registerTribeRoutes(app: FastifyInstance): void {
  app.get('/v1/tribes', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await listTribes(req.ctx);
    return reply.send({ tribes: rows });
  });

  app.get('/v1/tribes/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await getTribe(req.ctx, id);
    return reply.send(out);
  });

  app.get('/v1/tribes/:id/districts', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await getTribe(req.ctx, id);
    return reply.send({ tribeId: out.tribeId, districtSlugs: out.ownedDistricts });
  });

  app.get('/v1/districts', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await listDistricts(req.ctx);
    return reply.send({ districts: rows });
  });

  app.get('/v1/districts/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await getDistrict(req.ctx, id);
    return reply.send(out);
  });

  app.get('/v1/districts/:id/owner', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await getDistrictOwner(req.ctx, id);
    return reply.send({ districtId: id, owner: out });
  });
}
