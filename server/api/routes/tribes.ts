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
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  changeTribe,
  getDistrict,
  getDistrictOwner,
  getTribe,
  listDistricts,
  listTribes,
} from '../../application/tribes.js';

const ChangeTribeBody = z.object({
  tribeId: z.string().min(1).max(40),
});

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

  // POST /v1/me/tribe — change the caller's tribe. Refused if the
  // caller already changed tribe in the current ISO-8601 week.
  app.post('/v1/me/tribe', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = ChangeTribeBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const out = await changeTribe(req.ctx, req.user!.sub, body.data.tribeId);
    return reply.send(out);
  });
}
