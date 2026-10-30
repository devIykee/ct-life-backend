/**
 * "dana joined": tell the city when a player comes online.
 *
 * Sent from the city room when a player's first session joins. Alias only (no
 * location), never to people who blocked the player or were blocked by them,
 * never to anonymous sessions, at most once per player every ten minutes
 * (reconnects and app switches stay quiet) and a few a second city-wide (a
 * crowd logging in at once never floods the toasts). Players without a
 * character yet are not announced. Never fails the join.
 */
import { perUserTokenBucket } from '../shared/infra/rate-limit.js';
import type { AppContext } from './context.js';
import { publishToCityExcept } from './realtime-bus.js';

/** One announcement per player per this many seconds. */
export const JOIN_ANNOUNCE_EVERY_S = 600;

/**
 * Announce a player's arrival to the rest of the city.
 * @param ctx - The application context.
 * @param userId - The player who joined.
 * @param now - Clock, for tests.
 */
export async function announceJoin(
  ctx: AppContext,
  userId: string,
  now = new Date(),
): Promise<void> {
  try {
    const found = await ctx.db.withConnection(async (c) => {
      const a = await c.query<{ alias: string }>(
        `SELECT alias FROM characters WHERE user_id = $1`,
        [userId],
      );
      if (a.rowCount === 0) return null;
      const b = await c.query<{ other: string }>(
        `SELECT blocked_user_id AS other FROM blocks WHERE blocker_user_id = $1
         UNION
         SELECT blocker_user_id AS other FROM blocks WHERE blocked_user_id = $1`,
        [userId],
      );
      return { alias: a.rows[0]!.alias, blocks: b.rows.map((x) => x.other) };
    });
    if (found === null) return;
    const once = await ctx.redis.main.set(
      `join:ann:${userId}`,
      '1',
      'EX',
      JOIN_ANNOUNCE_EVERY_S,
      'NX',
    );
    if (once !== 'OK') return;
    const d = await perUserTokenBucket(ctx.redis.main, 'rl:join-ann', 10, 3, 1);
    if (!d.allowed) return;
    await publishToCityExcept(
      ctx,
      'player_joined',
      { userId, alias: found.alias, at: now.getTime() },
      { exclude: [...found.blocks, userId] },
    );
  } catch {
    // A missed announcement never fails the join.
  }
}
