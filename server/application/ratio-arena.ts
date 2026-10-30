/**
 * CT Beef in the Debate Arena (`ratio_arena`): the match lifecycle (unlock A6).
 *
 *   POST /v1/beef                 open (topic from beef_topics.json, optional
 *                                 invited player). Stake-free: stakeCents > 0
 *                                 is refused, the response says stakeCents 0
 *                                 and the house-paid rewardCents.
 *   POST /v1/beef/{id}/accept     the invited player (or anyone, if open)
 *   POST /v1/beef/{id}/decline    the invited player turns it down
 *   POST /v1/beef/{id}/cancel     the challenger withdraws while open
 *   GET  /v1/beef, /v1/beef/{id}  board / my history / one match
 *   GET  /v1/beef/elo             a player's Elo
 *   POST /v1/beef/{id}/settle     admin override (beef-close.ts)
 *
 * Phases: open -(openSeconds)-> expired; accept -> active -(activeSeconds)->
 * voting -(votingSeconds)-> closed. The phase worker (server/workers/beef.ts,
 * beef-close.ts) moves them; every action re-checks `phase_ends_at`, so a slow
 * worker can never let a late accept or vote in.
 *
 * Money: nobody stakes Cash and Cash never moves between players
 * (docs/ECONOMY.md). The winner may get a capped reward from the house
 * (beef-close.ts). Matches opened before this change keep their stake rows;
 * each stake goes back to its owner when the match ends.
 *
 * Over the 300-line soft limit on purpose: it is the one owner of the
 * beef_matches row shape (columns, API mapping, locking) that beef-close.ts
 * and beef-votes.ts reuse; splitting it would scatter that contract.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  BlockedError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SybilJailedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import { beefConfig } from './beef-rules.js';
import { markLive } from './beef-activity.js';
import { publishBeef, publishBeefChallenge } from './beef-events.js';
import { isSybilJailed } from './sybil-jail.js';

export type BeefStatus =
  'open' | 'active' | 'voting' | 'closed' | 'declined' | 'cancelled' | 'expired';

export interface BeefMatchRow {
  readonly matchId: string;
  readonly challengerUserId: string;
  readonly invitedUserId: string | null;
  readonly accepterUserId: string | null;
  readonly topicId: string | null;
  readonly stakeCents: number;
  readonly feeBps: number;
  readonly rewardCents: number;
  readonly rewardPaidCents: number | null;
  readonly status: BeefStatus;
  readonly phaseEndsAt: string | null;
  /** Player votes; null until closed, so nobody bandwagons. */
  readonly votes: { challenger: number; accepter: number; total: number } | null;
  /** The NPC arena crowd; null until closed. */
  readonly crowdVotes: { challenger: number; accepter: number } | null;
  readonly myVote: string | null;
  readonly winnerUserId: string | null;
  readonly eloChallengerPre: number | null;
  readonly eloAccepterPre: number | null;
  readonly eloChallengerPost: number | null;
  readonly eloAccepterPost: number | null;
  readonly openedAt: string;
  readonly acceptedAt: string | null;
  readonly settledAt: string | null;
}

export interface BeefEloRow {
  readonly userId: string;
  readonly elo: number;
  readonly matchesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
}

export interface BeefMatchDbRow {
  match_id: string;
  challenger_user_id: string;
  invited_user_id: string | null;
  accepter_user_id: string | null;
  topic_id: string | null;
  stake_cents: string;
  status: BeefStatus;
  winner_user_id: string | null;
  elo_challenger_pre: number | null;
  elo_accepter_pre: number | null;
  elo_challenger_post: number | null;
  elo_accepter_post: number | null;
  phase_ends_at: Date | null;
  reward_cents: string;
  reward_paid_cents: string | null;
  votes_challenger: number | null;
  votes_accepter: number | null;
  crowd_challenger: number | null;
  crowd_accepter: number | null;
  opened_at: Date;
  accepted_at: Date | null;
  settled_at: Date | null;
}

export const MATCH_COLS = `match_id, challenger_user_id, invited_user_id, accepter_user_id, topic_id,
  stake_cents, status, winner_user_id, elo_challenger_pre, elo_accepter_pre, elo_challenger_post,
  elo_accepter_post, phase_ends_at, reward_cents, reward_paid_cents, votes_challenger,
  votes_accepter, crowd_challenger, crowd_accepter, opened_at, accepted_at, settled_at`;

export type Tx = Pick<PoolClient, 'query'>;

export interface OpenBeefInput {
  readonly topicId: string;
  readonly invitedUserId?: string | null;
  readonly stakeCents?: number;
}

/** @returns The API shape. `myVote` is the viewer's vote, if any. */
export function rowToMatch(r: BeefMatchDbRow, myVote: string | null = null): BeefMatchRow {
  const closed = r.status === 'closed';
  const vc = r.votes_challenger ?? 0;
  const va = r.votes_accepter ?? 0;
  return {
    matchId: r.match_id,
    challengerUserId: r.challenger_user_id,
    invitedUserId: r.invited_user_id,
    accepterUserId: r.accepter_user_id,
    topicId: r.topic_id,
    stakeCents: Number(r.stake_cents),
    feeBps: 0,
    rewardCents: Number(r.reward_cents),
    rewardPaidCents: r.reward_paid_cents === null ? null : Number(r.reward_paid_cents),
    status: r.status,
    phaseEndsAt: r.phase_ends_at ? r.phase_ends_at.toISOString() : null,
    votes: closed ? { challenger: vc, accepter: va, total: vc + va } : null,
    crowdVotes: closed
      ? { challenger: r.crowd_challenger ?? 0, accepter: r.crowd_accepter ?? 0 }
      : null,
    myVote,
    winnerUserId: r.winner_user_id,
    eloChallengerPre: r.elo_challenger_pre,
    eloAccepterPre: r.elo_accepter_pre,
    eloChallengerPost: r.elo_challenger_post,
    eloAccepterPost: r.elo_accepter_post,
    openedAt: r.opened_at.toISOString(),
    acceptedAt: r.accepted_at ? r.accepted_at.toISOString() : null,
    settledAt: r.settled_at ? r.settled_at.toISOString() : null,
  };
}

/** The `beef_update` body for a row. */
export function updatePayload(r: BeefMatchDbRow, now: Date): Record<string, unknown> {
  return {
    matchId: r.match_id,
    status: r.status,
    challengerUserId: r.challenger_user_id,
    accepterUserId: r.accepter_user_id,
    invitedUserId: r.invited_user_id,
    topicId: r.topic_id,
    phaseEndsAt: r.phase_ends_at ? r.phase_ends_at.getTime() : null,
    at: now.getTime(),
  };
}

/** Lock and read a match, or 404. */
export async function lockMatch(c: Tx, matchId: string): Promise<BeefMatchDbRow> {
  const r = await c.query<BeefMatchDbRow>(
    `SELECT ${MATCH_COLS} FROM beef_matches WHERE match_id = $1 FOR UPDATE`,
    [matchId],
  );
  if (!r.rows[0]) throw new NotFoundError({ kind: 'beef_match', id: matchId });
  return r.rows[0];
}

/** Whether two players are in a block pair (either direction). */
async function blockedPair(c: Tx, a: string, b: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM blocks
      WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
         OR (blocker_user_id = $2 AND blocked_user_id = $1) LIMIT 1`,
    [a, b],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Give an old (pre-A6) stake back to its owner: only what that player actually
 * paid in for this match (`beef_stake` debits) minus what was already returned
 * (`beef_stake_refund`). A stake that was never debited is never credited.
 */
export async function refundStake(c: Tx, m: BeefMatchDbRow, userId: string): Promise<void> {
  if (Number(m.stake_cents) <= 0) return;
  const r = await c.query<{ owed: string | null }>(
    `SELECT -SUM(delta_cents)::bigint AS owed FROM ledger_entries
      WHERE user_id = $1 AND ref_type = 'beef_match' AND ref_id = $2
        AND reason IN ('beef_stake', 'beef_stake_refund')`,
    [userId, m.match_id],
  );
  const owed = Number(r.rows[0]?.owed ?? 0);
  if (owed <= 0) return;
  const ref = `beef-stake-refund:${m.match_id}:${userId}`;
  const done = await c.query(`SELECT 1 FROM ledger_entries WHERE idempotency_ref = $1`, [ref]);
  if ((done.rowCount ?? 0) > 0) return;
  await c.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  await c.query(
    `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
    [owed, userId],
  );
  await c.query(
    `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
     VALUES ($1, $2, 'cash', 'beef_stake_refund', 'beef_match', $3, $4)`,
    [userId, owed, m.match_id, ref],
  );
}

/**
 * Both participants must meet `participants` (account age, level) to open or
 * accept: a brand-new alt cannot feed its main a win.
 * `403 FORBIDDEN {reason: too_new | level}`.
 */
async function assertParticipantEligible(
  c: Tx,
  cfg: ReturnType<typeof beefConfig>,
  userId: string,
  now: Date,
): Promise<void> {
  const u = await c.query<{ created_at: Date; level: number | null }>(
    `SELECT u.created_at,
            GREATEST(s.clout, s.coding, s.trading, s.writing, s.design, s.security) AS level
       FROM users u LEFT JOIN skills s ON s.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const me = u.rows[0];
  if (
    !me ||
    now.getTime() - me.created_at.getTime() < cfg.participants.minAccountAgeHours * 3_600_000
  ) {
    throw new ForbiddenError({
      reason: 'too_new',
      minAccountAgeHours: cfg.participants.minAccountAgeHours,
    });
  }
  if ((me.level ?? 1) < cfg.participants.minLevel) {
    throw new ForbiddenError({ reason: 'level', minLevel: cfg.participants.minLevel });
  }
}

/**
 * Open a stake-free match.
 * @param ctx - The app context.
 * @param challengerUserId - The caller.
 * @param input - Topic, optional invited player, optional stakeCents (must be 0).
 * @param now - Injectable clock.
 * @returns The new match.
 */
export async function openMatch(
  ctx: AppContext,
  challengerUserId: string,
  input: OpenBeefInput,
  now: Date = new Date(),
): Promise<BeefMatchRow> {
  const cfg = beefConfig(ctx);
  if ((input.stakeCents ?? 0) > 0) throw new ValidationFailedError({ reason: 'stakes_disabled' });
  if (!cfg.topics.some((t) => t.id === input.topicId)) {
    throw new ValidationFailedError({ field: 'topicId', reason: 'unknown_topic' });
  }
  const invited = input.invitedUserId ?? null;
  const row = await runInTransaction(async (c) => {
    await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [challengerUserId]);
    if (await isSybilJailed(c, challengerUserId, now)) throw new SybilJailedError({});
    await assertParticipantEligible(c, cfg, challengerUserId, now);
    if (invited !== null) {
      if (invited === challengerUserId) {
        throw new ValidationFailedError({ field: 'invitedUserId', reason: 'self' });
      }
      const u = await c.query(`SELECT 1 FROM users WHERE id = $1`, [invited]);
      if ((u.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'user', id: invited });
      if (await blockedPair(c, challengerUserId, invited)) throw new BlockedError();
    }
    const open = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM beef_matches
        WHERE challenger_user_id = $1 AND status = 'open' AND phase_ends_at > $2`,
      [challengerUserId, now.toISOString()],
    );
    if ((open.rows[0]?.n ?? 0) >= cfg.limits.maxOpenPerChallenger) {
      throw new ConflictError({ reason: 'too_many_open', limit: cfg.limits.maxOpenPerChallenger });
    }
    const ends = new Date(now.getTime() + cfg.phases.openSeconds * 1000);
    const r = await c.query<BeefMatchDbRow>(
      `INSERT INTO beef_matches (match_id, challenger_user_id, invited_user_id, topic_id,
                                 stake_cents, status, phase_ends_at, reward_cents, opened_at)
       VALUES ($1, $2, $3, $4, 0, 'open', $5, $6, $7)
       RETURNING ${MATCH_COLS}`,
      [
        uuidv7(),
        challengerUserId,
        invited,
        input.topicId,
        ends.toISOString(),
        cfg.reward.winnerCents,
        now.toISOString(),
      ],
    );
    return r.rows[0]!;
  });
  if (invited !== null) {
    await publishBeefChallenge(ctx, invited, {
      matchId: row.match_id,
      fromUserId: challengerUserId,
      topicId: row.topic_id,
      stakeCents: 0,
      rewardCents: Number(row.reward_cents),
      expiresAt: row.phase_ends_at!.getTime(),
      at: now.getTime(),
    });
  }
  await publishBeef(ctx, 'beef_update', updatePayload(row, now));
  return rowToMatch(row);
}

/**
 * Accept: the debate goes live. Only the invited player may accept an aimed
 * challenge; never the challenger, a block pair, a jailed player, or someone
 * already in a live match.
 */
export async function acceptMatch(
  ctx: AppContext,
  accepterUserId: string,
  matchId: string,
  now: Date = new Date(),
): Promise<BeefMatchRow> {
  const cfg = beefConfig(ctx);
  const row = await runInTransaction(async (c) => {
    const m = await lockMatch(c, matchId);
    if (m.status !== 'open' || !m.phase_ends_at || m.phase_ends_at <= now) {
      throw new ConflictError({ reason: 'not_open', status: m.status });
    }
    // A pre-A6 staked challenge can never go live: nobody stakes any more.
    if (Number(m.stake_cents) > 0) throw new ConflictError({ reason: 'legacy_stake' });
    if (m.challenger_user_id === accepterUserId) {
      throw new ValidationFailedError({ reason: 'cannot accept your own match' });
    }
    if (m.invited_user_id !== null && m.invited_user_id !== accepterUserId) {
      throw new ForbiddenError({ reason: 'not_invited' });
    }
    if (await blockedPair(c, m.challenger_user_id, accepterUserId)) throw new BlockedError();
    if (await isSybilJailed(c, accepterUserId, now)) throw new SybilJailedError({});
    await assertParticipantEligible(c, cfg, accepterUserId, now);
    await assertParticipantEligible(c, cfg, m.challenger_user_id, now);
    const busy = await c.query(
      `SELECT 1 FROM beef_matches
        WHERE status = 'active' AND (challenger_user_id = ANY($1::uuid[]) OR accepter_user_id = ANY($1::uuid[]))
        LIMIT 1`,
      [[m.challenger_user_id, accepterUserId]],
    );
    if ((busy.rowCount ?? 0) > 0) throw new ConflictError({ reason: 'in_match' });
    const challengerElo = await getOrCreateElo(c, m.challenger_user_id, cfg.elo.start);
    const accepterElo = await getOrCreateElo(c, accepterUserId, cfg.elo.start);
    const ends = new Date(now.getTime() + cfg.phases.activeSeconds * 1000);
    const upd = await c.query<BeefMatchDbRow>(
      `UPDATE beef_matches
          SET accepter_user_id = $1, status = 'active', accepted_at = $2, phase_ends_at = $3,
              elo_challenger_pre = $4, elo_accepter_pre = $5
        WHERE match_id = $6
        RETURNING ${MATCH_COLS}`,
      [accepterUserId, now.toISOString(), ends.toISOString(), challengerElo, accepterElo, matchId],
    );
    return upd.rows[0]!;
  });
  await markLive(
    ctx.redis.main,
    row.match_id,
    [row.challenger_user_id, accepterUserId],
    cfg.phases.activeSeconds + 60,
  );
  await publishBeef(ctx, 'beef_update', updatePayload(row, now));
  return rowToMatch(row);
}

/** End an open match as `declined` (the invited player) or `cancelled` (the challenger). */
async function endOpen(
  ctx: AppContext,
  userId: string,
  matchId: string,
  to: 'declined' | 'cancelled',
  now: Date,
): Promise<BeefMatchRow> {
  const row = await runInTransaction(async (c) => {
    const m = await lockMatch(c, matchId);
    if (to === 'declined' && m.invited_user_id !== userId) {
      throw new ForbiddenError({ reason: 'not_invited' });
    }
    if (to === 'cancelled' && m.challenger_user_id !== userId) {
      throw new ForbiddenError({ reason: 'not_challenger' });
    }
    if (m.status !== 'open' || !m.phase_ends_at || m.phase_ends_at <= now) {
      throw new ConflictError({ reason: 'not_open', status: m.status });
    }
    await refundStake(c, m, m.challenger_user_id);
    const upd = await c.query<BeefMatchDbRow>(
      `UPDATE beef_matches SET status = $2, settled_at = $3, phase_ends_at = NULL
        WHERE match_id = $1 RETURNING ${MATCH_COLS}`,
      [matchId, to, now.toISOString()],
    );
    return upd.rows[0]!;
  });
  await publishBeef(ctx, 'beef_update', updatePayload(row, now));
  return rowToMatch(row);
}

/** The invited player turns the challenge down. */
export function declineMatch(
  ctx: AppContext,
  userId: string,
  matchId: string,
  now: Date = new Date(),
): Promise<BeefMatchRow> {
  return endOpen(ctx, userId, matchId, 'declined', now);
}

/** The challenger withdraws an open challenge. */
export function cancelMatch(
  ctx: AppContext,
  userId: string,
  matchId: string,
  now: Date = new Date(),
): Promise<BeefMatchRow> {
  return endOpen(ctx, userId, matchId, 'cancelled', now);
}

/** One match, with the viewer's own vote. */
export async function getMatch(
  ctx: AppContext,
  viewerId: string,
  matchId: string,
): Promise<BeefMatchRow> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<BeefMatchDbRow & { my_vote: string | null }>(
      `SELECT ${MATCH_COLS},
              (SELECT voted_user_id FROM beef_votes v WHERE v.match_id = m.match_id
                 AND v.voter_user_id = $2) AS my_vote
         FROM beef_matches m WHERE match_id = $1`,
      [matchId, viewerId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundError({ kind: 'beef_match', id: matchId });
    return rowToMatch(row, row.my_vote);
  });
}

export type BeefScope = 'all' | 'mine' | 'open' | 'arena';

/**
 * The board or my history, newest first, keyset-paged.
 *
 *   all    every match
 *   mine   matches I opened, accepted or am invited to
 *   open   open, unexpired challenges I could accept (open to all, or aimed at me)
 *   arena  live and voting matches
 * @returns `{matches, nextCursor}`; the cursor is opaque.
 */
export async function listMatches(
  ctx: AppContext,
  userId: string,
  scope: BeefScope,
  status: BeefStatus | null,
  limit: number,
  cursor: string | null = null,
  now: Date = new Date(),
): Promise<{ matches: BeefMatchRow[]; nextCursor: string | null }> {
  const after = decodeCursor(cursor);
  const r = await ctx.db.withConnection((c) =>
    c.query<BeefMatchDbRow & { my_vote: string | null }>(
      `SELECT ${MATCH_COLS},
              (SELECT voted_user_id FROM beef_votes v WHERE v.match_id = m.match_id
                 AND v.voter_user_id = $1) AS my_vote
         FROM beef_matches m
        WHERE ($2::text IS NULL OR status = $2)
          AND ($3 <> 'mine' OR challenger_user_id = $1 OR accepter_user_id = $1 OR invited_user_id = $1)
          AND ($3 <> 'open' OR (status = 'open' AND phase_ends_at > $4
                                AND challenger_user_id <> $1
                                AND (invited_user_id IS NULL OR invited_user_id = $1)))
          AND ($3 <> 'arena' OR status IN ('active', 'voting'))
          AND ($5::timestamptz IS NULL OR (opened_at, match_id) < ($5::timestamptz, $6::uuid))
        ORDER BY opened_at DESC, match_id DESC
        LIMIT $7`,
      [userId, status, scope, now.toISOString(), after?.at ?? null, after?.id ?? null, limit + 1],
    ),
  );
  const rows = r.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    matches: rows.map((row) => rowToMatch(row, row.my_vote)),
    nextCursor:
      r.rows.length > limit && last
        ? Buffer.from(`${last.opened_at.toISOString()}|${last.match_id}`).toString('base64url')
        : null,
  };
}

function decodeCursor(cursor: string | null): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new ValidationFailedError({ field: 'cursor' });
  }
  return { at, id };
}

/** A player's Elo (creates the row at the start rating on first read). */
export async function getElo(ctx: AppContext, userId: string): Promise<BeefEloRow> {
  const start = beefConfig(ctx).elo.start;
  return runInTransaction(async (c) => {
    await getOrCreateElo(c, userId, start);
    const r = await c.query<{
      user_id: string;
      elo: number;
      matches_played: number;
      wins: number;
      losses: number;
      draws: number;
    }>(
      `SELECT user_id, elo, matches_played, wins, losses, draws FROM beef_elo WHERE user_id = $1`,
      [userId],
    );
    const row = r.rows[0]!;
    return {
      userId: row.user_id,
      elo: row.elo,
      matchesPlayed: row.matches_played,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
    };
  });
}

/** @returns The player's Elo, creating the row at `start`. */
export async function getOrCreateElo(c: Tx, userId: string, start: number): Promise<number> {
  await c.query(
    `INSERT INTO beef_elo (user_id, elo, matches_played, wins, losses, draws)
     VALUES ($1, $2, 0, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
    [userId, start],
  );
  const r = await c.query<{ elo: number }>(`SELECT elo FROM beef_elo WHERE user_id = $1`, [userId]);
  return r.rows[0]?.elo ?? start;
}
