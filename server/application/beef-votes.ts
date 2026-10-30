/**
 * Spectator votes on a beef match (unlock A6, capability `beefVoting`).
 *
 * One vote per player per match, only during `voting` (re-checked against
 * `phase_ends_at`, so a slow phase worker never lets a late vote in). Tallies
 * stay hidden until the match closes (ratio-arena.ts `rowToMatch`), so nobody
 * bandwagons. Eligibility (contract/config/beef_topics.json `voters`, the B12
 * defaults): not a participant, not jailed (Barn), account at least
 * `minAccountAgeHours` old, level (the highest skill) at least `minLevel`.
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  AlreadyVotedError,
  ConflictError,
  SybilJailedError,
  ValidationFailedError,
  VoteNotAllowedError,
} from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import { beefConfig } from './beef-rules.js';
import { lockMatch } from './ratio-arena.js';
import { isSybilJailed } from './sybil-jail.js';

export interface BeefVoteReceipt {
  readonly matchId: string;
  readonly votedUserId: string;
  readonly at: string;
}

/**
 * Cast a vote.
 * @param ctx - The app context.
 * @param voterUserId - The caller.
 * @param matchId - The match.
 * @param votedUserId - A participant.
 * @param now - Injectable clock.
 * @returns The receipt.
 */
export async function castVote(
  ctx: AppContext,
  voterUserId: string,
  matchId: string,
  votedUserId: string,
  now: Date = new Date(),
): Promise<BeefVoteReceipt> {
  const cfg = beefConfig(ctx);
  return runInTransaction(async (c) => {
    // Locking the match row keeps the phase from changing under the vote.
    const m = await lockMatch(c, matchId);
    if (m.status !== 'voting' || !m.phase_ends_at || m.phase_ends_at <= now) {
      throw new ConflictError({ reason: 'not_voting', status: m.status });
    }
    if (votedUserId !== m.challenger_user_id && votedUserId !== m.accepter_user_id) {
      throw new ValidationFailedError({ field: 'votedUserId', reason: 'not_a_participant' });
    }
    if (voterUserId === m.challenger_user_id || voterUserId === m.accepter_user_id) {
      throw new VoteNotAllowedError({ reason: 'participant' });
    }
    if (await isSybilJailed(c, voterUserId, now)) throw new SybilJailedError({});
    const u = await c.query<{ created_at: Date; level: number | null }>(
      `SELECT u.created_at,
              GREATEST(s.clout, s.coding, s.trading, s.writing, s.design, s.security) AS level
         FROM users u LEFT JOIN skills s ON s.user_id = u.id
        WHERE u.id = $1`,
      [voterUserId],
    );
    const me = u.rows[0];
    const ageMs = me ? now.getTime() - me.created_at.getTime() : 0;
    if (!me || ageMs < cfg.voters.minAccountAgeHours * 3_600_000) {
      throw new VoteNotAllowedError({ reason: 'too_new' });
    }
    if ((me.level ?? 1) < cfg.voters.minLevel) {
      throw new VoteNotAllowedError({ reason: 'level', minLevel: cfg.voters.minLevel });
    }
    const ins = await c.query<{ at: Date }>(
      `INSERT INTO beef_votes (match_id, voter_user_id, voted_user_id, at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (match_id, voter_user_id) DO NOTHING
       RETURNING at`,
      [matchId, voterUserId, votedUserId, now.toISOString()],
    );
    if (!ins.rows[0]) throw new AlreadyVotedError({});
    return { matchId, votedUserId, at: ins.rows[0].at.toISOString() };
  });
}
