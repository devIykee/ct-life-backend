/**
 * Invite rate limits per target (review L11): create -> revoke/cancel ->
 * create could re-send `beef_challenge` / `cabal_invite` pushes to the same
 * player in a loop. Two limits, both counted from the invite rows themselves
 * (revoked and cancelled ones included), so there is nothing extra to store:
 *
 *   - one invite from the same sender to the same target per `pairCooldownMs`;
 *   - at most `perTargetPerHour` invites to one target from everyone.
 *
 * Over a limit: `429 RATE_LIMITED {reason: invite_cooldown | target_invite_cap,
 * retryAfterMs}`.
 */
import type { PoolClient } from 'pg';
import { RateLimitedError } from '../shared/domain/errors.js';

const HOUR_MS = 3_600_000;

/** The invite tables and their columns (code constants, never user input). */
const SOURCES = {
  beef: {
    table: 'beef_matches',
    from: 'challenger_user_id',
    to: 'invited_user_id',
    at: 'opened_at',
  },
  cabal: { table: 'cabal_invites', from: 'host_user_id', to: 'guest_user_id', at: 'created_at' },
} as const;

export interface InviteRateLimits {
  readonly pairCooldownMs: number;
  readonly perTargetPerHour: number;
}

/**
 * Refuse an invite that would break a limit. Call inside the creating
 * transaction (after locking the sender), before the insert.
 * @param c - The transaction client.
 * @param source - Which invite kind.
 * @param fromUserId - The sender.
 * @param toUserId - The target.
 * @param now - Now.
 * @param limits - The limits.
 */
export async function assertInviteRate(
  c: Pick<PoolClient, 'query'>,
  source: keyof typeof SOURCES,
  fromUserId: string,
  toUserId: string,
  now: Date,
  limits: InviteRateLimits,
): Promise<void> {
  const s = SOURCES[source];
  const pair = await c.query<{ last: Date | null }>(
    `SELECT MAX(${s.at}) AS last FROM ${s.table}
      WHERE ${s.from} = $1 AND ${s.to} = $2 AND ${s.at} > $3`,
    [fromUserId, toUserId, new Date(now.getTime() - limits.pairCooldownMs).toISOString()],
  );
  const last = pair.rows[0]?.last;
  if (last) {
    const retryAfterMs = last.getTime() + limits.pairCooldownMs - now.getTime();
    throw new RateLimitedError(Math.max(1000, retryAfterMs), { reason: 'invite_cooldown' });
  }
  const target = await c.query<{ n: number; oldest: Date | null }>(
    `SELECT COUNT(*)::int AS n, MIN(${s.at}) AS oldest FROM ${s.table}
      WHERE ${s.to} = $1 AND ${s.at} > $2`,
    [toUserId, new Date(now.getTime() - HOUR_MS).toISOString()],
  );
  const row = target.rows[0];
  if (row && row.n >= limits.perTargetPerHour && row.oldest) {
    const retryAfterMs = row.oldest.getTime() + HOUR_MS - now.getTime();
    throw new RateLimitedError(Math.max(1000, retryAfterMs), { reason: 'target_invite_cap' });
  }
}
