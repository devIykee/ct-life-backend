/**
 * CT Beef in the Debate Arena (unlock A6). Every player route needs the app
 * capability `beef`; votes also need `beefVoting`. Settle stays admin-only as
 * a manual override. Rules: server/application/ratio-arena.ts (lifecycle),
 * beef-close.ts (phases, result, reward), beef-votes.ts (votes).
 *
 *   GET  /v1/beef?scope=all|mine|open|arena&status=&cursor=&limit=
 *   POST /v1/beef                     {topicId, invitedUserId?, stakeCents?: 0}
 *   GET  /v1/beef/elo?userId=
 *   GET  /v1/beef/:id
 *   POST /v1/beef/:id/accept
 *   POST /v1/beef/:id/decline        (the invited player)
 *   POST /v1/beef/:id/cancel         (the challenger, while open)
 *   POST /v1/beef/:id/votes          {votedUserId}   (beefVoting)
 *   POST /v1/beef/:id/settle         {winnerUserId}  (admin)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireCapability } from '../middleware/capability.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  acceptMatch,
  cancelMatch,
  declineMatch,
  getElo,
  getMatch,
  listMatches,
  openMatch,
} from '../../application/ratio-arena.js';
import { settleMatch } from '../../application/beef-close.js';
import { castVote } from '../../application/beef-votes.js';

const OpenBody = z
  .object({
    topicId: z.string().min(1).max(64),
    invitedUserId: z.string().uuid().nullable().optional(),
    stakeCents: z.number().int().min(0).optional(),
  })
  .strict();

const IdParams = z.object({ id: z.string().uuid() });
const SettleBody = z.object({ winnerUserId: z.string().uuid() });
const VoteBody = z.object({ votedUserId: z.string().uuid() }).strict();
const EloQuery = z.object({ userId: z.string().uuid().optional() });

const BeefListQuery = z.object({
  scope: z.enum(['all', 'mine', 'open', 'arena']).default('all'),
  status: z
    .enum(['open', 'active', 'voting', 'closed', 'declined', 'cancelled', 'expired'])
    .optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const beef = requireCapability('beef');

function id(params: unknown): string {
  const p = IdParams.safeParse(params);
  if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
  return p.data.id;
}

/**
 * Register the beef routes on the Fastify app.
 */
export function registerRatioArenaRoutes(app: FastifyInstance): void {
  app.get('/v1/beef', { preHandler: [beef, requireAuth] }, async (req, reply) => {
    const q = BeefListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    return reply.send(
      await listMatches(
        req.ctx,
        req.user!.sub,
        q.data.scope,
        q.data.status ?? null,
        q.data.limit,
        q.data.cursor ?? null,
      ),
    );
  });

  app.post(
    '/v1/beef',
    { preHandler: [beef, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = OpenBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.status(201).send(await openMatch(req.ctx, req.user!.sub, body.data));
    },
  );

  // Registered before /v1/beef/:id so `elo` is never read as a match id.
  app.get('/v1/beef/elo', { preHandler: requireAuth }, async (req, reply) => {
    const q = EloQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    return reply.send(await getElo(req.ctx, q.data.userId ?? req.user!.sub));
  });

  app.get('/v1/beef/:id', { preHandler: [beef, requireAuth] }, async (req, reply) =>
    reply.send(await getMatch(req.ctx, req.user!.sub, id(req.params))),
  );

  app.post(
    '/v1/beef/:id/accept',
    { preHandler: [beef, requireAuth, withIdempotency()] },
    async (req, reply) => reply.send(await acceptMatch(req.ctx, req.user!.sub, id(req.params))),
  );

  app.post(
    '/v1/beef/:id/decline',
    { preHandler: [beef, requireAuth, withIdempotency()] },
    async (req, reply) => reply.send(await declineMatch(req.ctx, req.user!.sub, id(req.params))),
  );

  app.post(
    '/v1/beef/:id/cancel',
    { preHandler: [beef, requireAuth, withIdempotency()] },
    async (req, reply) => reply.send(await cancelMatch(req.ctx, req.user!.sub, id(req.params))),
  );

  app.post(
    '/v1/beef/:id/votes',
    {
      preHandler: [beef, requireCapability('beefVoting'), requireAuth, withIdempotency()],
    },
    async (req, reply) => {
      const body = VoteBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await castVote(req.ctx, req.user!.sub, id(req.params), body.data.votedUserId);
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/beef/:id/settle',
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const body = SettleBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.send(await settleMatch(req.ctx, id(req.params), body.data.winnerUserId));
    },
  );
}
