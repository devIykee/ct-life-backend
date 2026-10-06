/**
 * Leagues routes (M7 #2).
 *
 *   GET /v1/leagues
 *   GET /v1/leagues/:slug
 *   GET /v1/me/league?seasonIso=...
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { getLeague, getMyLeague, listLeagues } from '../../application/leagues.js';
import { currentSeasonIso } from '../../application/season-clock.js';

const SeasonQuery = z.object({
  seasonIso: z.string().min(1).max(40).optional(),
});

/**
 * Register the leagues routes on the Fastify app.
 */
export function registerLeagueRoutes(app: FastifyInstance): void {
  app.get('/v1/leagues', { preHandler: requireAuth }, async (req, reply) => {
    const rows = await listLeagues(req.ctx);
    return reply.send({ leagues: rows });
  });

  app.get('/v1/leagues/:slug', { preHandler: requireAuth }, async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const out = await getLeague(req.ctx, slug);
    return reply.send(out);
  });

  app.get('/v1/me/league', { preHandler: requireAuth }, async (req, reply) => {
    const q = SeasonQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const seasonIso = q.data.seasonIso ?? currentSeasonIso();
    const out = await getMyLeague(req.ctx, req.user!.sub, seasonIso);
    return reply.send({ seasonIso, membership: out });
  });
}
