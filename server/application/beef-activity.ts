/**
 * In-arena activity counters for live beef matches (unlock A6).
 *
 * When a match goes `active`, both participants are marked live
 * (`beef:live:<userId>` -> matchId, expiring a minute after the phase). The
 * `ratio_arena` venue room reports their talking spans, emotes and chat lines
 * (`recordArenaActivity`); the counters sit in a Redis hash per match
 * (`beef:act:<matchId>`) until the match moves to voting, when beef-close.ts
 * copies them to `beef_presence` and the crowd split reads them.
 *
 * Fire and forget: a Redis error loses activity, never a request or a message.
 */
import type { Redis } from 'ioredis';
import type { Activity } from './beef-rules.js';

export type ActivityKind = 'talk' | 'emote' | 'say';

const liveKey = (userId: string): string => `beef:live:${userId}`;
const actKey = (matchId: string): string => `beef:act:${matchId}`;

/**
 * Mark both participants live for a match.
 * @param redis - The main Redis client.
 * @param matchId - The match.
 * @param userIds - The participants.
 * @param ttlSeconds - How long the mark lasts.
 */
export async function markLive(
  redis: Redis,
  matchId: string,
  userIds: readonly string[],
  ttlSeconds: number,
): Promise<void> {
  try {
    const m = redis.multi();
    for (const u of userIds) m.set(liveKey(u), matchId, 'EX', ttlSeconds);
    m.expire(actKey(matchId), ttlSeconds + 3600);
    await m.exec();
  } catch {
    // Activity is best effort.
  }
}

/**
 * Add to a live participant's counters; does nothing when the player is not
 * in a live match.
 * @param redis - The main Redis client.
 * @param userId - The player.
 * @param kind - What they did.
 * @param amount - Seconds for talk, 1 for an emote or a line.
 */
export async function recordArenaActivity(
  redis: Redis,
  userId: string,
  kind: ActivityKind,
  amount: number,
): Promise<void> {
  if (!(amount > 0)) return;
  try {
    const matchId = await redis.get(liveKey(userId));
    if (!matchId) return;
    await redis.hincrby(actKey(matchId), `${userId}:${kind}`, Math.round(amount));
  } catch {
    // Best effort.
  }
}

/**
 * Read and clear a match's counters and its live marks.
 * @param redis - The main Redis client.
 * @param matchId - The match.
 * @param userIds - The participants.
 * @returns userId -> activity (zeros when nothing was recorded).
 */
export async function takeActivity(
  redis: Redis,
  matchId: string,
  userIds: readonly string[],
): Promise<Map<string, Activity>> {
  const out = new Map<string, Activity>();
  for (const u of userIds) out.set(u, { talkSeconds: 0, emotes: 0, says: 0 });
  try {
    const h = await redis.hgetall(actKey(matchId));
    for (const u of userIds) {
      out.set(u, {
        talkSeconds: Number(h[`${u}:talk`] ?? 0),
        emotes: Number(h[`${u}:emote`] ?? 0),
        says: Number(h[`${u}:say`] ?? 0),
      });
    }
    await redis.del(actKey(matchId), ...userIds.map(liveKey));
  } catch {
    // Zeros: the crowd then abstains.
  }
  return out;
}
