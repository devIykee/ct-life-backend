/**
 * Who is in which venue instance, for the REST API.
 *
 * The venue room keeps one Redis hash per instance, `ctl:venue:members:<instanceId>`
 * (instanceId is the Colyseus room id, the same id the client sends to
 * `POST /v1/rtc/token {kind: 'venue'}`), with a field per user holding that
 * user's open session count. Join adds 1, leave takes 1, dispose deletes
 * the hash. The API mints a venue voice token only for a count above zero.
 *
 * Counts, not set membership: a user with two sessions in one instance
 * stays present until both have left, and a leave never has to read
 * before it writes. A field at zero or below means "not present".
 *
 * The hash expires `VENUE_MEMBERS_TTL_SEC` after the last write; a live room
 * refreshes it (`touchVenueMembers`) well inside that, so a realtime process
 * that dies without disposing its rooms cannot leave members present for
 * longer than a day. A count that a lost hash pushed below zero is put back
 * (join: 1, leave: 0), so a rejoin is never needed twice.
 */
import type { Presence } from 'colyseus';

/** Idle lifetime of an instance's member hash. */
export const VENUE_MEMBERS_TTL_SEC = 24 * 60 * 60;

/**
 * The member hash key for one venue instance.
 * @param instanceId - The venue room id.
 */
export function venueMembersKey(instanceId: string): string {
  return `ctl:venue:members:${instanceId}`;
}

/**
 * Record one more session of `userId` in the instance.
 * @param presence - The room's presence (shared Redis).
 * @param instanceId - The venue room id.
 * @param userId - Who joined.
 */
export async function markVenueJoin(
  presence: Presence,
  instanceId: string,
  userId: string,
): Promise<void> {
  const key = venueMembersKey(instanceId);
  const n = await presence.hincrby(key, userId, 1);
  if (n < 1) await presence.hset(key, userId, '1');
  await presence.expire(key, VENUE_MEMBERS_TTL_SEC);
}

/**
 * Record that one session of `userId` left the instance.
 * @param presence - The room's presence (shared Redis).
 * @param instanceId - The venue room id.
 * @param userId - Who left.
 * @returns The user's sessions still in the instance (0 when this was the last).
 */
export async function markVenueLeave(
  presence: Presence,
  instanceId: string,
  userId: string,
): Promise<number> {
  const key = venueMembersKey(instanceId);
  const n = await presence.hincrby(key, userId, -1);
  if (n < 0) await presence.hset(key, userId, '0');
  await presence.expire(key, VENUE_MEMBERS_TTL_SEC);
  return Math.max(0, n);
}

/** How often a live room pushes its member hash's expiry back. */
export const VENUE_MEMBERS_TOUCH_MS = 60 * 60 * 1000;

/**
 * Push the member hash's expiry back while the room is alive.
 * @param presence - The room's presence (shared Redis).
 * @param instanceId - The venue room id.
 */
export function touchVenueMembers(presence: Presence, instanceId: string): void {
  presence.expire(venueMembersKey(instanceId), VENUE_MEMBERS_TTL_SEC);
}

/**
 * Forget every member of an instance (the room is gone).
 * @param presence - The room's presence (shared Redis).
 * @param instanceId - The venue room id.
 */
export function clearVenueMembers(presence: Presence, instanceId: string): void {
  presence.del(venueMembersKey(instanceId));
}
