/**
 * Who is in which street instance, for the REST API (street voice).
 *
 * The street room keeps one Redis hash per instance,
 * `ctl:street:members:<district>:<instanceId>` (instanceId is the Colyseus
 * room id sent in `welcome`), with a field per user holding that user's open
 * session count. The district is part of the key, so a token request that
 * pairs an instance with the wrong district finds no hash and is refused.
 * Join adds 1, leave takes 1, dispose deletes the hash. The API mints a
 * `proximity` voice token (LiveKit room `proximity:<district>:<instanceId>`)
 * only for a count above zero.
 *
 * Same rules as venue-presence.ts: counts, not set membership (a user with
 * two sessions stays present until both have left); the hash expires a day
 * after the last write and a live room refreshes it hourly; a count that a
 * lost hash pushed below zero is put back (join: 1, leave: 0).
 */
import type { Presence } from 'colyseus';

/** Idle lifetime of an instance's member hash. */
export const STREET_MEMBERS_TTL_SEC = 24 * 60 * 60;

/** How often a live room pushes its member hash's expiry back. */
export const STREET_MEMBERS_TOUCH_MS = 60 * 60 * 1000;

/**
 * The member hash key for one street instance.
 * @param district - The street room's district id.
 * @param instanceId - The street room id.
 */
export function streetMembersKey(district: string, instanceId: string): string {
  return `ctl:street:members:${district}:${instanceId}`;
}

/**
 * Record one more session of `userId` in the instance.
 * @param presence - The room's presence (shared Redis).
 * @param district - The street room's district id.
 * @param instanceId - The street room id.
 * @param userId - Who joined.
 * @param onCounted - Records an acknowledged increment before an expiry write can fail.
 */
export async function markStreetJoin(
  presence: Presence,
  district: string,
  instanceId: string,
  userId: string,
  onCounted?: () => void,
): Promise<void> {
  const key = streetMembersKey(district, instanceId);
  const n = await presence.hincrby(key, userId, 1);
  if (n < 1) await presence.hset(key, userId, '1');
  onCounted?.();
  await presence.expire(key, STREET_MEMBERS_TTL_SEC);
}

/**
 * Record that one session of `userId` left the instance.
 * @param presence - The room's presence (shared Redis).
 * @param district - The street room's district id.
 * @param instanceId - The street room id.
 * @param userId - Who left.
 * @returns The user's sessions still in the instance (0 when this was the last).
 */
export async function markStreetLeave(
  presence: Presence,
  district: string,
  instanceId: string,
  userId: string,
): Promise<number> {
  const key = streetMembersKey(district, instanceId);
  const n = await presence.hincrby(key, userId, -1);
  if (n < 0) await presence.hset(key, userId, '0');
  await presence.expire(key, STREET_MEMBERS_TTL_SEC);
  return Math.max(0, n);
}

/**
 * Push the member hash's expiry back while the room is alive.
 * @param presence - The room's presence (shared Redis).
 * @param district - The street room's district id.
 * @param instanceId - The street room id.
 */
export function touchStreetMembers(presence: Presence, district: string, instanceId: string): void {
  presence.expire(streetMembersKey(district, instanceId), STREET_MEMBERS_TTL_SEC);
}

/**
 * Forget every member of an instance (the room is gone).
 * @param presence - The room's presence (shared Redis).
 * @param district - The street room's district id.
 * @param instanceId - The street room id.
 */
export function clearStreetMembers(presence: Presence, district: string, instanceId: string): void {
  presence.del(streetMembersKey(district, instanceId));
}
