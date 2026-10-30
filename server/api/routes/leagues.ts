/**
 * Leagues routes (M7 #2).
 *
 *   GET /v1/leagues
 *   GET /v1/leagues/:slug
 *   GET /v1/me/league?seasonIso=...
 *   GET /v1/me/season-results?seasonId=   (capability seasonResults)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { getSeasonResults } from '../../application/season-results.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { getLeague, getMyLeague, listLeagues } from '../../application/leagues.js';
import { currentSeasonIso } from '../../application/season-clock.js';

const SeasonResultsQuery = z.object({ seasonId: z.string().min(1).max(40).optional() });

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

  // How my last (or a given) finished season ended, for the share card.
  app.get(
    '/v1/me/season-results',
    { preHandler: [requireCapability('seasonResults'), requireAuth] },
    async (req, reply) => {
      const q = SeasonResultsQuery.safeParse(req.query);
      if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
      return reply.send(await getSeasonResults(req.ctx, req.user!.sub, q.data.seasonId));
    },
  );
}
