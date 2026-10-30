/**
 * CT Beef realtime (unlock A6).
 *
 *   beef_challenge  to the invited player: {matchId, fromUserId, topicId,
 *                   stakeCents: 0, rewardCents, expiresAt}
 *   beef_update     to the city and the Debate Arena (`ratio_arena`) venue
 *                   rooms on every phase change: {matchId, status,
 *                   challengerUserId, accepterUserId, invitedUserId, topicId,
 *                   phaseEndsAt, at}
 *   beef_result     same audience on close: {matchId, winnerUserId,
 *                   votesChallenger, votesAccepter, crowdChallenger,
 *                   crowdAccepter, eloDeltaChallenger, eloDeltaAccepter,
 *                   payoutCents, rewardCents, at}
 *
 * Times are epoch ms (the realtime convention). City delivery goes through the
 * realtime bus; venue rooms subscribe to BEEF_CHANNEL through Colyseus presence.
 * Fire and forget.
 */
import type { AppContext } from './context.js';
import { publishToUser } from './realtime-bus.js';

/** Presence channel the `ratio_arena` venue rooms listen on. */
export const BEEF_CHANNEL = 'ctl:beef';

export type BeefBroadcastType = 'beef_update' | 'beef_result';

/**
 * Tell the city and the arena rooms.
 * @param ctx - The app context.
 * @param type - beef_update or beef_result.
 * @param payload - The message body.
 */
export async function publishBeef(
  ctx: AppContext,
  type: BeefBroadcastType,
  payload: Record<string, unknown>,
): Promise<void> {
  await publishToUser(ctx, '*', type, payload);
  try {
    await ctx.redis.main.publish(BEEF_CHANNEL, JSON.stringify({ type, payload }));
  } catch {
    // The city copy is enough.
  }
}

/**
 * Ring the invited player.
 * @param ctx - The app context.
 * @param userId - The invited player.
 * @param payload - The message body.
 */
export async function publishBeefChallenge(
  ctx: AppContext,
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await publishToUser(ctx, userId, 'beef_challenge', payload);
}
