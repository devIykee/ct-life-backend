/**
 * Invite rate limits (review L11, revised after the automated review).
 *
 * Create -> cancel/revoke -> create could re-send `beef_challenge` /
 * `cabal_invite` pushes to the same player in a loop. Limits on *creating* an
 * invite are per sender only, so nobody can use up a quota that blocks someone
 * else's invite:
 *
 *   - one invite from the same sender to the same target per `pairCooldownMs`
 *     (cancelled and revoked ones count): `429 {reason: invite_cooldown}`;
 *   - at most `perSenderPerHour` targeted invites from one sender per hour:
 *     `429 {reason: sender_invite_cap}`.
 *
 * The per-target protection applies to *notifications*: once a target has had
 * `notifyPerTargetPerHour` targeted invites in the last hour, further invites
 * are still created (the target sees them in their list) but not pushed. So a
 * griefer with alts can at worst mute pushes for an hour, never block a
 * friend's invite.
 *
 * Counts come from the invite rows themselves, under
 * `pg_advisory_xact_lock(hashtext('invite-target:' || target))` so concurrent
 * invites to one target are counted one at a time (the sender's own row is
 * already locked by the caller, which serialises the per-sender counts).
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
  readonly perSenderPerHour: number;
  readonly notifyPerTargetPerHour: number;
}

/**
 * Check the sender's limits and decide whether the target is pushed. Call
 * inside the creating transaction, after locking the sender's row and before
 * the insert.
 * @param c - The transaction client.
 * @param source - Which invite kind.
 * @param fromUserId - The sender.
 * @param toUserId - The target.
 * @param now - Now.
 * @param limits - The limits.
 * @returns `{notify}`: false when the target already had its hourly pushes.
 */
export async function checkInviteRate(
  c: Pick<PoolClient, 'query'>,
  source: keyof typeof SOURCES,
  fromUserId: string,
  toUserId: string,
  now: Date,
  limits: InviteRateLimits,
): Promise<{ notify: boolean }> {
  const s = SOURCES[source];
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('invite-target:' || $1::text))`, [toUserId]);
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
  const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
  const sent = await c.query<{ n: number; oldest: Date | null }>(
    `SELECT COUNT(*)::int AS n, MIN(${s.at}) AS oldest FROM ${s.table}
      WHERE ${s.from} = $1 AND ${s.to} IS NOT NULL AND ${s.at} > $2`,
    [fromUserId, hourAgo],
  );
  const mine = sent.rows[0];
  if (mine && mine.n >= limits.perSenderPerHour && mine.oldest) {
    const retryAfterMs = mine.oldest.getTime() + HOUR_MS - now.getTime();
    throw new RateLimitedError(Math.max(1000, retryAfterMs), { reason: 'sender_invite_cap' });
  }
  const received = await c.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${s.table} WHERE ${s.to} = $1 AND ${s.at} > $2`,
    [toUserId, hourAgo],
  );
  return { notify: (received.rows[0]?.n ?? 0) < limits.notifyPerTargetPerHour };
}
