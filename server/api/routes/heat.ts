/**
 * Sleuth heat, police pursuit and CT Jail routes.
 *
 *   GET  /v1/heat/me      heat, level, decayAt, wantedUntil, pursuit, jail
 *   POST /v1/heat/caught  the client reports a cruiser caught it (server verifies)
 *   POST /v1/heat/bail    pay bail, leave CT Jail
 *
 * There is no endpoint to report an escape: the server referee decides it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { getHeatMe, payBail, reportCaught } from '../../application/heat.js';

const CaughtBody = z
  .object({
    pursuitId: z.string().uuid(),
    x: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();

/**
 * Register the heat routes.
 * @param app - The Fastify instance.
 */
export function registerHeatRoutes(app: FastifyInstance): void {
  app.get('/v1/heat/me', { preHandler: requireAuth }, async (req, reply) =>
    reply.send(await getHeatMe(req.ctx, req.user!.sub)),
  );

  app.post('/v1/heat/caught', { preHandler: requireAuth }, async (req, reply) => {
    const body = CaughtBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    return reply.send(await reportCaught(req.ctx, req.user!.sub, body.data));
  });

  app.post('/v1/heat/bail', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) =>
    reply.send(await payBail(req.ctx, req.user!.sub)),
  );
}
