/**
 * Ratio Arena — CT Beef in the Ratio Arena (M7 #5).
 *
 * Endpoints:
 *
 *   POST /v1/beef                        — open a match; posts
 *                                           the challenger's stake.
 *   POST /v1/beef/{id}/accept            — accepter joins; posts
 *                                           the same stake.
 *   POST /v1/beef/{id}/decline           — challenger cancels
 *                                           before accept; refunds
 *                                           the stake.
 *   POST /v1/beef/{id}/settle             — admin sets the winner;
 *                                           pays out (gross - 5%
 *                                           fee), bumps Elo, writes
 *                                           a beef_matches row.
 *   GET  /v1/beef?status=                — list the user's matches
 *                                           (challenger + accepter).
 *   GET  /v1/beef/{id}                   — read a single match.
 *   GET  /v1/beef/elo                    — read the caller's Elo.
 *
 * Money:
 *   - Both sides post their stake via a 'beef_stake' ledger row
 *     inside the same SERIALIZABLE UoW that updates the match row.
 *   - On settlement, the winner is credited via 'beef_payout' and
 *     a 5% protocol fee is debited via 'beef_fee' (the loser
 *     keeps 0 net). The 'beef_stake' rows remain; the ledger is
 *     append-only so they don't disappear.
 *   - On decline (status='declined' before accept), the
 *     challenger's stake is refunded via 'beef_stake_refund'.
 *
 * Elo:
 *   - Each player has a beef_elo row; starting Elo is 1500
 *     (the standard chess default).
 *   - On settlement: expected = 1 / (1 + 10^((opp - me) / 400));
 *     delta = K * (actual - expected) where K=32; the row's
 *     elo is updated in the same UoW as the match row.
 *   - On a draw (winner_user_id = NULL, but status='closed' is
 *     not used here; draws are not part of M7 #5's MVP, but the
 *     schema supports them).
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

const STARTING_ELO = 1500;
const K_FACTOR = 32;
const FEE_BPS = 500; // 5%

export type BeefStatus = 'open' | 'active' | 'closed' | 'declined' | 'cancelled';

export interface BeefMatchRow {
  readonly matchId: string;
  readonly challengerUserId: string;
  readonly accepterUserId: string | null;
  readonly stakeCents: number;
  readonly status: BeefStatus;
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

interface BeefMatchDbRow {
  match_id: string;
  challenger_user_id: string;
  accepter_user_id: string | null;
  stake_cents: string;
  status: BeefStatus;
  winner_user_id: string | null;
  elo_challenger_pre: number | null;
  elo_accepter_pre: number | null;
  elo_challenger_post: number | null;
  elo_accepter_post: number | null;
  opened_at: Date;
  accepted_at: Date | null;
  settled_at: Date | null;
}

interface BeefEloDbRow {
  user_id: string;
  elo: number;
  matches_played: number;
  wins: number;
  losses: number;
  draws: number;
}

/**
 * Open a match. The challenger posts the stake; the match is
 * 'open' until the accepter joins.
 */
export async function openMatch(
  _ctx: AppContext,
  challengerUserId: string,
  stakeCents: number,
): Promise<BeefMatchRow> {
  if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
    throw new ValidationFailedError({ reason: 'stakeCents must be > 0' });
  }
  const matchId = uuidv7();
  const row = await runInTransaction(async (client) => {
    // Ensure balance row exists, lock it, debit the stake.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [challengerUserId],
    );
    const b = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [challengerUserId],
    );
    const cash = BigInt(b.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(stakeCents)) {
      throw new ForbiddenError({ reason: 'insufficient_cash_for_stake' });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now()
       WHERE user_id = $2`,
      [stakeCents, challengerUserId],
    );
    await client.query(
      `INSERT INTO ledger_entries
         (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'beef_stake', 'beef_match', $3, $4)`,
      [challengerUserId, -stakeCents, matchId, `beef-stake:${matchId}:${uuidv7()}`],
    );
    const r = await client.query<BeefMatchDbRow>(
      `INSERT INTO beef_matches (match_id, challenger_user_id, stake_cents, status)
       VALUES ($1, $2, $3, 'open')
       RETURNING match_id, challenger_user_id, accepter_user_id, stake_cents,
                 status, winner_user_id, elo_challenger_pre, elo_accepter_pre,
                 elo_challenger_post, elo_accepter_post, opened_at, accepted_at,
                 settled_at`,
      [matchId, challengerUserId, stakeCents],
    );
    return r.rows[0]!;
  });
  return rowToMatch(row);
}

/** Accepter joins; posts the same stake. */
export async function acceptMatch(
  _ctx: AppContext,
  accepterUserId: string,
  matchId: string,
): Promise<BeefMatchRow> {
  return runInTransaction(async (client) => {
    const r = await client.query<BeefMatchDbRow>(
      `SELECT match_id, challenger_user_id, accepter_user_id, stake_cents, status,
              winner_user_id, elo_challenger_pre, elo_accepter_pre,
              elo_challenger_post, elo_accepter_post, opened_at, accepted_at, settled_at
       FROM beef_matches WHERE match_id = $1 FOR UPDATE`,
      [matchId],
    );
    const m = r.rows[0];
    if (!m) throw new NotFoundError({ kind: 'beef_match', id: matchId });
    if (m.status !== 'open') {
      throw new ValidationFailedError({ reason: 'match not open' });
    }
    if (m.challenger_user_id === accepterUserId) {
      throw new ValidationFailedError({ reason: 'cannot accept your own match' });
    }
    // Ensure balance, lock, debit the accepter's stake.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [accepterUserId],
    );
    const b = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [accepterUserId],
    );
    const cash = BigInt(b.rows[0]?.cash_cents ?? '0');
    const stake = Number(m.stake_cents);
    if (cash < BigInt(stake)) {
      throw new ForbiddenError({ reason: 'insufficient_cash_for_stake' });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now()
       WHERE user_id = $2`,
      [stake, accepterUserId],
    );
    await client.query(
      `INSERT INTO ledger_entries
         (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'beef_stake', 'beef_match', $3, $4)`,
      [accepterUserId, -stake, matchId, `beef-stake:${matchId}:${uuidv7()}`],
    );
    // Capture pre-match Elo.
    const challengerElo = await getOrCreateElo(client, m.challenger_user_id);
    const accepterElo = await getOrCreateElo(client, accepterUserId);
    const upd = await client.query<BeefMatchDbRow>(
      `UPDATE beef_matches
       SET accepter_user_id = $1, status = 'active', accepted_at = now(),
           elo_challenger_pre = $2, elo_accepter_pre = $3
       WHERE match_id = $4
       RETURNING match_id, challenger_user_id, accepter_user_id, stake_cents,
                 status, winner_user_id, elo_challenger_pre, elo_accepter_pre,
                 elo_challenger_post, elo_accepter_post, opened_at, accepted_at,
                 settled_at`,
      [accepterUserId, challengerElo, accepterElo, matchId],
    );
    return rowToMatch(upd.rows[0]!);
  });
}

/** Challenger cancels before accept; refunds the stake. */
export async function declineMatch(
  _ctx: AppContext,
  challengerUserId: string,
  matchId: string,
): Promise<BeefMatchRow> {
  return runInTransaction(async (client) => {
    const r = await client.query<BeefMatchDbRow>(
      `SELECT match_id, challenger_user_id, accepter_user_id, stake_cents, status,
              winner_user_id, elo_challenger_pre, elo_accepter_pre,
              elo_challenger_post, elo_accepter_post, opened_at, accepted_at, settled_at
       FROM beef_matches WHERE match_id = $1 FOR UPDATE`,
      [matchId],
    );
    const m = r.rows[0];
    if (!m) throw new NotFoundError({ kind: 'beef_match', id: matchId });
    if (m.challenger_user_id !== challengerUserId) {
      throw new ForbiddenError({ reason: 'not the challenger' });
    }
    if (m.status !== 'open') {
      throw new ValidationFailedError({ reason: 'match not open' });
    }
    const stake = Number(m.stake_cents);
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now()
       WHERE user_id = $2`,
      [stake, challengerUserId],
    );
    await client.query(
      `INSERT INTO ledger_entries
         (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'beef_stake_refund', 'beef_match', $3, $4)`,
      [challengerUserId, stake, matchId, `beef-stake-refund:${matchId}:${uuidv7()}`],
    );
    const upd = await client.query<BeefMatchDbRow>(
      `UPDATE beef_matches SET status = 'declined', settled_at = now()
       WHERE match_id = $1
       RETURNING match_id, challenger_user_id, accepter_user_id, stake_cents,
                 status, winner_user_id, elo_challenger_pre, elo_accepter_pre,
                 elo_challenger_post, elo_accepter_post, opened_at, accepted_at,
                 settled_at`,
      [matchId],
    );
    return rowToMatch(upd.rows[0]!);
  });
}

/**
 * Settle a match. The admin/result endpoint sets the winner and
 * pays out: the winner gets both stakes minus a 5% protocol fee;
 * the loser keeps 0 net. Elo updates per the standard formula
 * with K=32.
 */
export async function settleMatch(
  _ctx: AppContext,
  matchId: string,
  winnerUserId: string,
): Promise<BeefMatchRow> {
  return runInTransaction(async (client) => {
    const r = await client.query<BeefMatchDbRow>(
      `SELECT match_id, challenger_user_id, accepter_user_id, stake_cents, status,
              winner_user_id, elo_challenger_pre, elo_accepter_pre,
              elo_challenger_post, elo_accepter_post, opened_at, accepted_at, settled_at
       FROM beef_matches WHERE match_id = $1 FOR UPDATE`,
      [matchId],
    );
    const m = r.rows[0];
    if (!m) throw new NotFoundError({ kind: 'beef_match', id: matchId });
    if (m.status !== 'active') {
      throw new ValidationFailedError({ reason: 'match not active' });
    }
    if (m.accepter_user_id === null) {
      throw new ValidationFailedError({ reason: 'no accepter' });
    }
    if (winnerUserId !== m.challenger_user_id && winnerUserId !== m.accepter_user_id) {
      throw new ValidationFailedError({ reason: 'winner is not a participant' });
    }
    const stake = Number(m.stake_cents);
    const challengerElo = m.elo_challenger_pre ?? STARTING_ELO;
    const accepterElo = m.elo_accepter_pre ?? STARTING_ELO;
    const challengerWon = winnerUserId === m.challenger_user_id;
    // Elo update.
    const expectedChallenger = 1 / (1 + Math.pow(10, (accepterElo - challengerElo) / 400));
    const actualChallenger = challengerWon ? 1 : 0;
    const deltaChallenger = Math.round(K_FACTOR * (actualChallenger - expectedChallenger));
    const deltaAccepter = -deltaChallenger;
    const challengerPost = clampElo(challengerElo + deltaChallenger);
    const accepterPost = clampElo(accepterElo + deltaAccepter);
    // Payout: gross = 2 * stake, fee = 5% of gross, winner gets
    // gross - fee. Loser keeps 0 net.
    const gross = 2 * stake;
    const fee = Math.floor((gross * FEE_BPS) / 10_000);
    const payout = gross - fee;
    // Credit the winner.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [winnerUserId],
    );
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now()
       WHERE user_id = $2`,
      [payout, winnerUserId],
    );
    await client.query(
      `INSERT INTO ledger_entries
         (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'beef_payout', 'beef_match', $3, $4)`,
      [winnerUserId, payout, matchId, `beef-payout:${matchId}:${uuidv7()}`],
    );
    // Debit the protocol fee from the winner (5% of gross).
    if (fee > 0) {
      await client.query(
        `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now()
         WHERE user_id = $2`,
        [fee, winnerUserId],
      );
      await client.query(
        `INSERT INTO ledger_entries
           (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'beef_fee', 'beef_match', $3, $4)`,
        [winnerUserId, -fee, matchId, `beef-fee:${matchId}:${uuidv7()}`],
      );
    }
    // Update Elo rows.
    await client.query(
      `INSERT INTO beef_elo (user_id, elo, matches_played, wins, losses, draws, updated_at)
       VALUES ($1, $2, 1, $3, $4, 0, now())
       ON CONFLICT (user_id) DO UPDATE
         SET elo = EXCLUDED.elo,
             matches_played = beef_elo.matches_played + 1,
             wins = beef_elo.wins + $3,
             losses = beef_elo.losses + $4,
             updated_at = now()`,
      [
        winnerUserId,
        challengerWon ? challengerPost : accepterPost,
        challengerWon ? 1 : 0,
        challengerWon ? 0 : 1,
      ],
    );
    const loserId = challengerWon ? m.accepter_user_id : m.challenger_user_id;
    await client.query(
      `INSERT INTO beef_elo (user_id, elo, matches_played, wins, losses, draws, updated_at)
       VALUES ($1, $2, 1, $3, $4, 0, now())
       ON CONFLICT (user_id) DO UPDATE
         SET elo = EXCLUDED.elo,
             matches_played = beef_elo.matches_played + 1,
             wins = beef_elo.wins + $3,
             losses = beef_elo.losses + $4,
             updated_at = now()`,
      [
        loserId,
        challengerWon ? accepterPost : challengerPost,
        challengerWon ? 0 : 1,
        challengerWon ? 1 : 0,
      ],
    );
    // Update match row.
    const upd = await client.query<BeefMatchDbRow>(
      `UPDATE beef_matches
       SET status = 'closed', winner_user_id = $1, settled_at = now(),
           elo_challenger_post = $2, elo_accepter_post = $3
       WHERE match_id = $4
       RETURNING match_id, challenger_user_id, accepter_user_id, stake_cents,
                 status, winner_user_id, elo_challenger_pre, elo_accepter_pre,
                 elo_challenger_post, elo_accepter_post, opened_at, accepted_at,
                 settled_at`,
      [winnerUserId, challengerPost, accepterPost, matchId],
    );
    return rowToMatch(upd.rows[0]!);
  });
}

/** Read the caller's Elo (creates the row at 1500 if missing). */
export async function getElo(_ctx: AppContext, userId: string): Promise<BeefEloRow> {
  return runInTransaction(async (client) => {
    const elo = await getOrCreateElo(client, userId);
    const r = await client.query<BeefEloDbRow>(
      `SELECT user_id, elo, matches_played, wins, losses, draws FROM beef_elo WHERE user_id = $1`,
      [userId],
    );
    const row = r.rows[0]!;
    void elo;
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

async function getOrCreateElo(
  client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  },
  userId: string,
): Promise<number> {
  await client.query(
    `INSERT INTO beef_elo (user_id, elo, matches_played, wins, losses, draws)
     VALUES ($1, $2, 0, 0, 0, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, STARTING_ELO],
  );
  const r = await client.query(`SELECT elo FROM beef_elo WHERE user_id = $1`, [userId]);
  const elo = (r.rows[0] as { elo: number } | undefined)?.elo;
  return elo ?? STARTING_ELO;
}

function clampElo(elo: number): number {
  if (elo < 0) return 0;
  if (elo > 3000) return 3000;
  return elo;
}

function rowToMatch(r: BeefMatchDbRow): BeefMatchRow {
  return {
    matchId: r.match_id,
    challengerUserId: r.challenger_user_id,
    accepterUserId: r.accepter_user_id,
    stakeCents: Number(r.stake_cents),
    status: r.status,
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

export interface BeefMatchListRow {
  readonly matchId: string;
  readonly challengerUserId: string;
  readonly accepterUserId: string | null;
  readonly winnerUserId: string | null;
  readonly stakeCents: number;
  readonly status: string;
  readonly openedAt: string;
  readonly acceptedAt: string | null;
  readonly settledAt: string | null;
}

/**
 * List beef matches for the arena board or my own history.
 *
 * The spec's invitedUserId and topicId are not columns on beef_matches
 * yet, so they are left out rather than invented.
 * @param ctx - The application context.
 * @param userId - The calling user, used by scope=mine.
 * @param scope - all for the public board, mine for matches I am part of.
 * @param status - Optional status filter.
 * @param limit - Page size.
 * @returns Matches, newest first.
 */
export async function listMatches(
  ctx: AppContext,
  userId: string,
  scope: 'all' | 'mine',
  status: string | null,
  limit: number,
): Promise<BeefMatchListRow[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      match_id: string;
      challenger_user_id: string;
      accepter_user_id: string | null;
      winner_user_id: string | null;
      stake_cents: string;
      status: string;
      opened_at: Date;
      accepted_at: Date | null;
      settled_at: Date | null;
    }>(
      `SELECT match_id, challenger_user_id, accepter_user_id, winner_user_id,
              stake_cents, status, opened_at, accepted_at, settled_at
         FROM beef_matches
        WHERE ($3::text IS NULL OR status = $3)
          AND ($2::boolean IS FALSE
               OR challenger_user_id = $1
               OR accepter_user_id = $1)
        ORDER BY opened_at DESC
        LIMIT $4`,
      [userId, scope === 'mine', status, limit],
    );
  });
  return r.rows.map((row) => ({
    matchId: row.match_id,
    challengerUserId: row.challenger_user_id,
    accepterUserId: row.accepter_user_id,
    winnerUserId: row.winner_user_id,
    stakeCents: Number(row.stake_cents),
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    acceptedAt: row.accepted_at ? row.accepted_at.toISOString() : null,
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
  }));
}
