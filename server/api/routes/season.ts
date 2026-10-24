/**
 * Season Pass tracks and the community-nods collection.
 *
 *   GET  /v1/season
 *   POST /v1/season/tiers/:n/claim?track=free|paid
 *   GET  /v1/nods
 *   GET  /v1/nods/leaderboard
 *   POST /v1/nods/:nodId/collect
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { claimTier, getSeason } from '../../application/season-tracks.js';
import { collectNod, getCollection, leaderboard } from '../../application/nods.js';

const TierParams = z.object({ n: z.coerce.number().int().min(1).max(1000) });
const ClaimQuery = z.object({ track: z.enum(['free', 'paid']) });
const NodParams = z.object({ nodId: z.string().regex(/^[a-z0-9_]{1,40}$/) });
const CollectBody = z.object({
  proof: z.object({
    nodId: z.string().regex(/^[a-z0-9_]{1,40}$/),
    x: z.number().finite().min(-5000).max(5000),
    z: z.number().finite().min(-5000).max(5000),
  }),
});

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new ValidationFailedError({ issues: r.error.issues });
  return r.data;
}

/**
 * Register the season and nods routes.
 * @param app - The Fastify instance.
 */
export function registerSeasonRoutes(app: FastifyInstance): void {
  app.get('/v1/season', { preHandler: requireAuth }, async (req, reply) =>
    reply.send(await getSeason(req.ctx, req.user!.sub)),
  );

  app.post(
    '/v1/season/tiers/:n/claim',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { n } = parse(TierParams, req.params);
      const { track } = parse(ClaimQuery, req.query);
      return reply.send(await claimTier(req.ctx, req.user!.sub, n, track));
    },
  );

  app.get('/v1/nods', { preHandler: requireAuth }, async (req, reply) =>
    reply.send(await getCollection(req.ctx, req.user!.sub)),
  );

  app.get('/v1/nods/leaderboard', { preHandler: requireAuth }, async (req, reply) =>
    reply.send(await leaderboard(req.ctx, req.user!.sub)),
  );

  app.post(
    '/v1/nods/:nodId/collect',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { nodId } = parse(NodParams, req.params);
      const { proof } = parse(CollectBody, req.body);
      return reply.send(await collectNod(req.ctx, req.user!.sub, nodId, proof));
    },
  );
}
