/**
 * The Rug Room routes (Cash-only play-money casino, 18+). See
 * server/application/casino.ts for the rules and docs/CASINO.md for the
 * policy and the maths.
 *
 *   GET  /v1/casino/state
 *   POST /v1/casino/slots/spin                     {stakeCents}
 *   POST /v1/casino/crash/bet                      {stakeCents, autoCashout?}
 *   POST /v1/casino/crash/cashout                  {roundId}
 *   POST /v1/casino/coinflip/bet                   {stakeCents, side}
 *   POST /v1/casino/coinflip/challenges            {opponentUserId, stakeCents, side}
 *   GET  /v1/casino/coinflip/challenges
 *   POST /v1/casino/coinflip/challenges/:id/accept | decline | cancel
 *   GET  /v1/casino/rounds?mine&limit&before
 *   GET  /v1/casino/rounds/:id
 *   POST /v1/casino/self-exclude                   {days}
 *
 * Every write needs an Idempotency-Key; a replay returns the first answer
 * and charges once. Writes that stake Cash also pass a tight per-player
 * rate limit. The client never sends an outcome, a multiplier or a price.
 * A settled big win (10x+, $10+) becomes a Timeline city card (city-cards.ts).
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireNotJailed } from '../middleware/jail.js';
import { withRateLimit } from '../middleware/rate-limit.js';
import { RateLimitedError, ValidationFailedError } from '../../shared/domain/errors.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';
import {
  acceptChallenge,
  cashoutCrash,
  closeChallenge,
  createChallenge,
  getCasinoState,
  getMyRound,
  listChallenges,
  listMyRounds,
  placeCrashBet,
  playCoinflip,
  playSlots,
  selfExclude,
} from '../../application/casino.js';
import { cardCasinoWin } from '../../application/city-cards.js';

const Stake = z.number().int().min(1).max(10_000_000);
const Side = z.enum(['heads', 'tails']);
const IdParams = z.object({ id: z.string().uuid() });

const SlotsBody = z.object({ stakeCents: Stake }).strict();
const CrashBetBody = z
  .object({ stakeCents: Stake, autoCashout: z.number().min(1.01).max(1000).optional() })
  .strict();
const CrashCashoutBody = z.object({ roundId: z.string().uuid() }).strict();
const CoinflipBody = z.object({ stakeCents: Stake, side: Side }).strict();
const ChallengeBody = z
  .object({ opponentUserId: z.string().uuid(), stakeCents: Stake, side: Side })
  .strict();
const SelfExcludeBody = z.object({ days: z.number().int().min(1).max(3650) }).strict();
const RoundsQuery = z.object({
  mine: z.enum(['true', '1', '']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

/** Bets: 5-token burst, 2 per second, per player. */
function casinoBetLimit(): preHandlerHookHandler {
  return async (req) => {
    const d = await perUserTokenBucket(
      req.ctx.redis.main,
      `rl:casino:${req.user?.sub ?? 'anon'}`,
      5,
      2,
      1,
    );
    if (!d.allowed) throw new RateLimitedError(d.retryAfterMs, { limit: 2 });
  };
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationFailedError({ issues: r.error.issues });
  return r.data;
}

/**
 * Register the casino routes.
 * @param app - The Fastify instance.
 */
export function registerCasinoRoutes(app: FastifyInstance): void {
  const read = { preHandler: requireAuth };
  const write = { preHandler: [requireAuth, withIdempotency(), withRateLimit()] };
  const bet = {
    preHandler: [
      requireAuth,
      requireNotJailed,
      withIdempotency(),
      withRateLimit(),
      casinoBetLimit(),
    ],
  };

  app.get('/v1/casino/state', read, async (req, reply) =>
    reply.send(await getCasinoState(req.ctx, req.user!.sub)),
  );

  app.post('/v1/casino/slots/spin', bet, async (req, reply) => {
    const body = parse(SlotsBody, req.body);
    const out = await playSlots(req.ctx, req.user!.sub, body.stakeCents);
    await cardCasinoWin(req.ctx, req.user!.sub, out.round);
    return reply.status(201).send(out);
  });

  app.post('/v1/casino/crash/bet', bet, async (req, reply) => {
    const body = parse(CrashBetBody, req.body);
    const out = await placeCrashBet(
      req.ctx,
      req.user!.sub,
      body.stakeCents,
      body.autoCashout ?? null,
    );
    await cardCasinoWin(req.ctx, req.user!.sub, out.round);
    return reply.status(201).send(out);
  });

  app.post('/v1/casino/crash/cashout', bet, async (req, reply) => {
    const body = parse(CrashCashoutBody, req.body);
    const out = await cashoutCrash(req.ctx, req.user!.sub, body.roundId);
    await cardCasinoWin(req.ctx, req.user!.sub, out.round);
    return reply.status(200).send(out);
  });

  app.post('/v1/casino/coinflip/bet', bet, async (req, reply) => {
    const body = parse(CoinflipBody, req.body);
    return reply
      .status(201)
      .send(await playCoinflip(req.ctx, req.user!.sub, body.stakeCents, body.side));
  });

  app.post('/v1/casino/coinflip/challenges', bet, async (req, reply) => {
    const body = parse(ChallengeBody, req.body);
    return reply
      .status(201)
      .send(
        await createChallenge(
          req.ctx,
          req.user!.sub,
          body.opponentUserId,
          body.stakeCents,
          body.side,
        ),
      );
  });

  app.get('/v1/casino/coinflip/challenges', read, async (req, reply) =>
    reply.send(await listChallenges(req.ctx, req.user!.sub)),
  );

  app.post('/v1/casino/coinflip/challenges/:id/accept', bet, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    return reply.send(await acceptChallenge(req.ctx, req.user!.sub, id));
  });

  app.post('/v1/casino/coinflip/challenges/:id/decline', write, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    return reply.send(await closeChallenge(req.ctx, req.user!.sub, id, 'decline'));
  });

  app.post('/v1/casino/coinflip/challenges/:id/cancel', write, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    return reply.send(await closeChallenge(req.ctx, req.user!.sub, id, 'cancel'));
  });

  // `mine` is accepted for readability: there is no other scope. Rounds of
  // other players are never listed.
  app.get('/v1/casino/rounds', read, async (req, reply) => {
    const q = parse(RoundsQuery, req.query);
    return reply.send(
      await listMyRounds(req.ctx, req.user!.sub, {
        limit: q.limit,
        before: q.before === undefined ? null : new Date(q.before),
      }),
    );
  });

  app.get('/v1/casino/rounds/:id', read, async (req, reply) => {
    const { id } = parse(IdParams, req.params);
    return reply.send(await getMyRound(req.ctx, req.user!.sub, id));
  });

  app.post('/v1/casino/self-exclude', write, async (req, reply) => {
    const body = parse(SelfExcludeBody, req.body);
    return reply.send(await selfExclude(req.ctx, req.user!.sub, body.days));
  });
}
