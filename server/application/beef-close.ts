/**
 * CT Beef phases and the result (unlock A6).
 *
 * `advanceBeefPhases` (run every 15 s by server/workers/beef.ts) moves every
 * match whose `phase_ends_at` passed:
 *
 *   open   -> expired  (an old stake goes back to its owner)
 *   active -> voting   (in-arena activity is copied to beef_presence)
 *   voting -> closed   (`closeMatch`)
 *
 * Each match moves in its own transaction (`FOR UPDATE SKIP LOCKED`, so two
 * workers never double-close) and the city / arena get `beef_update` (and
 * `beef_result` on close).
 *
 * Closing: player votes (1 each) decide; the arena crowd (beef-rules.ts
 * `crowdSplit` of activity) only breaks a tie in player votes (it is built
 * from client-reported activity, so it never outvotes a real player); a tie
 * in both is a draw. Elo moves (as a
 * draw on a tie) unless the pair already played `maxRatedMatchesPerPairPerDay`
 * rated matches today (anti win-trading). The winner gets `reward_cents` from
 * the house (ledger `beef_reward`, a faucet: no player pays it) only when at
 * least `minPlayerVotes` real players voted and the winner leads on player
 * votes alone (a crowd-decided match moves Elo but pays nothing), and unless a
 * cap holds: `maxRewardedWinsPerDay` for the player, `maxRewardedWinsPerPairPerDay`
 * for the pair, an account younger than `minAccountAgeHours`, or a jail. Cash
 * never moves between players. `settleMatch` is the admin override (same close
 * with a forced winner).
 *
 * Over the 300-line soft limit on purpose: the close (tally, crowd, Elo,
 * reward caps, refunds) is one transaction and reads best in one file.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ConflictError, ValidationFailedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import {
  activityScore,
  beefConfig,
  crowdSplit,
  eloAfter,
  utcDayStart,
  type BeefConfig,
} from './beef-rules.js';
import { takeActivity } from './beef-activity.js';
import { publishBeef } from './beef-events.js';
import {
  lockMatch,
  MATCH_COLS,
  refundStake,
  rowToMatch,
  updatePayload,
  type BeefMatchDbRow,
  type BeefMatchRow,
  type Tx,
} from './ratio-arena.js';
import { isSybilJailed } from './sybil-jail.js';

interface CloseOutcome {
  readonly row: BeefMatchDbRow;
  readonly result: Record<string, unknown>;
}

/**
 * Move every match whose phase ended. Safe to run concurrently.
 * @param ctx - The app context.
 * @param now - Injectable clock.
 * @returns How many matches moved.
 */
export async function advanceBeefPhases(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<{ moved: number }> {
  const cfg = beefConfig(ctx);
  const due = await ctx.db.withConnection((c) =>
    c.query<{ match_id: string }>(
      `SELECT match_id FROM beef_matches
        WHERE status IN ('open', 'active', 'voting') AND phase_ends_at <= $1
        ORDER BY phase_ends_at LIMIT 200`,
      [now.toISOString()],
    ),
  );
  let moved = 0;
  for (const { match_id } of due.rows) {
    if (await advanceOne(ctx, cfg, match_id, now)) moved++;
  }
  return { moved };
}

async function advanceOne(
  ctx: AppContext,
  cfg: BeefConfig,
  matchId: string,
  now: Date,
): Promise<boolean> {
  let close: CloseOutcome | null = null;
  const row = await runInTransaction(async (c) => {
    const r = await c.query<BeefMatchDbRow>(
      `SELECT ${MATCH_COLS} FROM beef_matches
        WHERE match_id = $1 AND status IN ('open', 'active', 'voting') AND phase_ends_at <= $2
        FOR UPDATE SKIP LOCKED`,
      [matchId, now.toISOString()],
    );
    const m = r.rows[0];
    if (!m) return null;
    if (m.status === 'open') {
      await refundStake(c, m, m.challenger_user_id);
      return setStatus(c, matchId, 'expired', null, now);
    }
    if (m.status === 'active') {
      await savePresence(ctx, c, m);
      const ends = new Date(now.getTime() + cfg.phases.votingSeconds * 1000);
      return setStatus(c, matchId, 'voting', ends, now);
    }
    close = await closeMatch(c, cfg, m, null, now);
    return close.row;
  });
  if (!row) return false;
  await publishBeef(ctx, 'beef_update', updatePayload(row, now));
  const done = close as CloseOutcome | null;
  if (done) await publishBeef(ctx, 'beef_result', done.result);
  return true;
}

async function setStatus(
  c: Tx,
  matchId: string,
  status: 'expired' | 'voting',
  phaseEndsAt: Date | null,
  now: Date,
): Promise<BeefMatchDbRow> {
  const r = await c.query<BeefMatchDbRow>(
    `UPDATE beef_matches
        SET status = $2, phase_ends_at = $3,
            settled_at = CASE WHEN $2 = 'expired' THEN $4::timestamptz ELSE settled_at END
      WHERE match_id = $1 RETURNING ${MATCH_COLS}`,
    [matchId, status, phaseEndsAt ? phaseEndsAt.toISOString() : null, now.toISOString()],
  );
  return r.rows[0]!;
}

/** Copy the live counters into beef_presence (once, when the debate ends). */
async function savePresence(ctx: AppContext, c: Tx, m: BeefMatchDbRow): Promise<void> {
  const users = [m.challenger_user_id, m.accepter_user_id].filter((u): u is string => !!u);
  const act = await takeActivity(ctx.redis.main, m.match_id, users);
  for (const [userId, a] of act) {
    await c.query(
      `INSERT INTO beef_presence (match_id, user_id, talk_seconds, emotes, says)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (match_id, user_id) DO UPDATE
         SET talk_seconds = beef_presence.talk_seconds + EXCLUDED.talk_seconds,
             emotes = beef_presence.emotes + EXCLUDED.emotes,
             says = beef_presence.says + EXCLUDED.says`,
      [m.match_id, userId, a.talkSeconds, a.emotes, a.says],
    );
  }
}

/**
 * Close a match: tally, crowd, Elo, reward, old-stake refunds.
 * @param forcedWinner - Admin override, or null to decide by votes.
 */
async function closeMatch(
  c: Tx,
  cfg: BeefConfig,
  m: BeefMatchDbRow,
  forcedWinner: string | null,
  now: Date,
): Promise<CloseOutcome> {
  const ch = m.challenger_user_id;
  const ac = m.accepter_user_id!;
  const votes = await c.query<{ voted_user_id: string; n: number }>(
    `SELECT voted_user_id, COUNT(*)::int AS n FROM beef_votes WHERE match_id = $1 GROUP BY 1`,
    [m.match_id],
  );
  const count = (u: string): number => votes.rows.find((v) => v.voted_user_id === u)?.n ?? 0;
  const pres = await c.query<{
    user_id: string;
    talk_seconds: number;
    emotes: number;
    says: number;
  }>(`SELECT user_id, talk_seconds, emotes, says FROM beef_presence WHERE match_id = $1`, [
    m.match_id,
  ]);
  const score = (u: string): number => {
    const p = pres.rows.find((r) => r.user_id === u);
    return p
      ? activityScore(cfg, { talkSeconds: p.talk_seconds, emotes: p.emotes, says: p.says })
      : 0;
  };
  const crowd = crowdSplit(cfg.crowd.npcVotes, score(ch), score(ac));
  // Real votes decide. The crowd's activity score comes from what clients
  // report (talking, emotes, chat), so it only breaks a tie in player votes and
  // can never outvote a real player (review L9).
  const winner = forcedWinner ?? decideWinner(ch, ac, count(ch), count(ac), crowd);

  const day = utcDayStart(now).toISOString();
  const pairRated = await c.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM beef_matches
      WHERE status = 'closed' AND settled_at >= $3
        AND ((challenger_user_id = $1 AND accepter_user_id = $2)
          OR (challenger_user_id = $2 AND accepter_user_id = $1))`,
    [ch, ac, day],
  );
  const preC = m.elo_challenger_pre ?? cfg.elo.start;
  const preA = m.elo_accepter_pre ?? cfg.elo.start;
  const rated = (pairRated.rows[0]?.n ?? 0) < cfg.elo.maxRatedMatchesPerPairPerDay;
  const post = rated
    ? eloAfter(preC, preA, winner === ch ? 1 : winner === ac ? 0 : 0.5, cfg.elo.kFactor)
    : { challenger: preC, accepter: preA };
  await bumpElo(c, ch, post.challenger, winner === ch, winner === ac, winner === null);
  await bumpElo(c, ac, post.accepter, winner === ac, winner === ch, winner === null);

  // The house only pays when real players decided it: enough player votes, and
  // the winner ahead on player votes alone. A crowd-decided match is Elo only.
  const players = count(ch) + count(ac);
  const loser = winner === ch ? ac : ch;
  const byPlayers =
    winner !== null && players >= cfg.reward.minPlayerVotes && count(winner) > count(loser);
  const paid = winner && byPlayers ? await payReward(c, cfg, m, winner, loser, now) : 0;
  await refundStake(c, m, ch);
  await refundStake(c, m, ac);

  const upd = await c.query<BeefMatchDbRow>(
    `UPDATE beef_matches
        SET status = 'closed', winner_user_id = $2, settled_at = $3, phase_ends_at = NULL,
            elo_challenger_post = $4, elo_accepter_post = $5, reward_paid_cents = $6,
            votes_challenger = $7, votes_accepter = $8, crowd_challenger = $9, crowd_accepter = $10
      WHERE match_id = $1 RETURNING ${MATCH_COLS}`,
    [
      m.match_id,
      winner,
      now.toISOString(),
      post.challenger,
      post.accepter,
      paid,
      count(ch),
      count(ac),
      crowd.challenger,
      crowd.accepter,
    ],
  );
  return {
    row: upd.rows[0]!,
    result: {
      matchId: m.match_id,
      winnerUserId: winner,
      votesChallenger: count(ch),
      votesAccepter: count(ac),
      crowdChallenger: crowd.challenger,
      crowdAccepter: crowd.accepter,
      eloDeltaChallenger: post.challenger - preC,
      eloDeltaAccepter: post.accepter - preA,
      payoutCents: paid,
      rewardCents: Number(m.reward_cents),
      at: now.getTime(),
    },
  };
}

/**
 * Player votes first; the crowd only when players are level (including no
 * votes at all); a level crowd too is a draw.
 */
export function decideWinner(
  ch: string,
  ac: string,
  votesC: number,
  votesA: number,
  crowd: { challenger: number; accepter: number },
): string | null {
  if (votesC !== votesA) return votesC > votesA ? ch : ac;
  if (crowd.challenger !== crowd.accepter) return crowd.challenger > crowd.accepter ? ch : ac;
  return null;
}

async function bumpElo(
  c: Tx,
  userId: string,
  elo: number,
  win: boolean,
  loss: boolean,
  draw: boolean,
): Promise<void> {
  await c.query(
    `INSERT INTO beef_elo (user_id, elo, matches_played, wins, losses, draws, updated_at)
     VALUES ($1, $2, 1, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE
       SET elo = EXCLUDED.elo, matches_played = beef_elo.matches_played + 1,
           wins = beef_elo.wins + $3, losses = beef_elo.losses + $4,
           draws = beef_elo.draws + $5, updated_at = now()`,
    [userId, elo, win ? 1 : 0, loss ? 1 : 0, draw ? 1 : 0],
  );
}

/**
 * Pay the house reward to the winner unless a cap holds. Never touches the
 * loser's Cash.
 * @returns Cents paid (0 when capped).
 */
async function payReward(
  c: Tx,
  cfg: BeefConfig,
  m: BeefMatchDbRow,
  winner: string,
  loser: string,
  now: Date,
): Promise<number> {
  const amount = Number(m.reward_cents);
  if (amount <= 0) return 0;
  const day = utcDayStart(now).toISOString();
  const age = await c.query<{ created_at: Date }>(`SELECT created_at FROM users WHERE id = $1`, [
    winner,
  ]);
  const created = age.rows[0]?.created_at;
  if (!created || now.getTime() - created.getTime() < cfg.reward.minAccountAgeHours * 3_600_000) {
    return 0;
  }
  if (await isSybilJailed(c, winner, now)) return 0;
  const mine = await c.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM beef_matches
      WHERE winner_user_id = $1 AND reward_paid_cents > 0 AND settled_at >= $2`,
    [winner, day],
  );
  if ((mine.rows[0]?.n ?? 0) >= cfg.reward.maxRewardedWinsPerDay) return 0;
  const pair = await c.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM beef_matches
      WHERE reward_paid_cents > 0 AND settled_at >= $3
        AND ((challenger_user_id = $1 AND accepter_user_id = $2)
          OR (challenger_user_id = $2 AND accepter_user_id = $1))`,
    [winner, loser, day],
  );
  if ((pair.rows[0]?.n ?? 0) >= cfg.reward.maxRewardedWinsPerPairPerDay) return 0;
  await c.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [winner],
  );
  await c.query(
    `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
    [amount, winner],
  );
  await c.query(
    `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
     VALUES ($1, $2, 'cash', 'beef_reward', 'beef_match', $3, $4)`,
    [winner, amount, m.match_id, `beef-reward:${m.match_id}`],
  );
  return amount;
}

/**
 * Admin override: close an active or voting match now with a chosen winner.
 * The same caps, Elo rules and refunds apply; nobody pays anybody.
 * @param ctx - The app context.
 * @param matchId - The match.
 * @param winnerUserId - A participant.
 * @param now - Injectable clock.
 */
export async function settleMatch(
  ctx: AppContext,
  matchId: string,
  winnerUserId: string,
  now: Date = new Date(),
): Promise<BeefMatchRow> {
  const cfg = beefConfig(ctx);
  const out = await runInTransaction(async (c) => {
    const m = await lockMatch(c, matchId);
    if (m.status !== 'active' && m.status !== 'voting') {
      throw new ConflictError({ reason: 'not_settleable', status: m.status });
    }
    if (winnerUserId !== m.challenger_user_id && winnerUserId !== m.accepter_user_id) {
      throw new ValidationFailedError({ reason: 'winner is not a participant' });
    }
    if (m.status === 'active') await savePresence(ctx, c, m);
    return closeMatch(c, cfg, m, winnerUserId, now);
  });
  await publishBeef(ctx, 'beef_update', updatePayload(out.row, now));
  await publishBeef(ctx, 'beef_result', out.result);
  return rowToMatch(out.row);
}
