/**
 * Realtime bus: how the REST API reaches a connected player.
 *
 * The api and realtime services are separate processes, so a handler that
 * wants to ring a callee or push a toast cannot touch the Colyseus room
 * directly. It publishes here instead; the city room subscribes and
 * forwards to that user's client. This is the single mechanism behind the
 * targeted messages in the contract (`toast`, `dm`, `call_invite`,
 * `space_update`, `payment_confirmed`, `liquidated`, `delivery_out`,
 * `delivery_arrived`, `quest_progress`, `event_live`, `event_ended`), which previously had
 * no transport at all: a video call returned a callId and the callee was
 * never rung.
 *
 * Fire and forget. A player who is offline simply misses it; nothing is
 * queued, which matches the contract's "the client refetches on join".
 */
import type { Redis } from 'ioredis';
import type { AppContext } from './context.js';
import { OUTFIT_CHANNEL } from '../realtime/movement.js';
import { computeOutfit, outfitStateSql } from '../shared/domain/outfit.js';
import { recordWorldEvent } from './world-events.js';

/** Redis pub/sub channel carrying every targeted message. */
export const USER_CHANNEL = 'rt:user';

/** Message types the city room knows how to forward. */
export type UserMessageType =
  | 'toast'
  | 'dm'
  | 'group_msg'
  | 'group_invite'
  | 'call_invite'
  | 'space_update'
  | 'payment_confirmed'
  | 'liquidated'
  | 'delivery_out'
  | 'delivery_arrived'
  | 'quest_progress'
  | 'career_promoted'
  | 'job_unlocked'
  // Builder and VC Row (unlock WP-B).
  | 'hire_offer'
  | 'project_event'
  | 'event_live'
  | 'event_ended'
  | 'irl_checkin'
  | 'police_pursuit'
  | 'police_pursuit_end'
  | 'jailed'
  | 'released'
  | 'event'
  | 'x_link_update'
  | 'cabal_invite';

export interface UserMessage {
  readonly userId: string;
  readonly type: UserMessageType;
  readonly payload: Record<string, unknown>;
  /**
   * Broadcast ('*') only: users who must NOT receive it (block pairs), and,
   * with `authedOnly`, sessions that did not sign in never receive it.
   */
  readonly exclude?: readonly string[];
  readonly authedOnly?: boolean;
}

/**
 * Whether a broadcast reaches a session, given the signed-in user id of that
 * session (undefined for an anonymous one).
 * @param msg - The published message.
 * @param sessionUserId - The session's user, if known.
 */
export function shouldDeliverBroadcast(
  msg: UserMessage,
  sessionUserId: string | undefined,
): boolean {
  if (msg.authedOnly && !sessionUserId) return false;
  if (sessionUserId && msg.exclude?.includes(sessionUserId)) return false;
  return true;
}

/**
 * Broadcast to the city except to some users (block pairs). Used for presence
 * that must not reach people who blocked, or were blocked by, its subject.
 * @param ctx - The application context.
 * @param type - The contract message name.
 * @param payload - The message body.
 * @param opts - Who to leave out; anonymous sessions never get it.
 */
export async function publishToCityExcept(
  ctx: AppContext,
  type: UserMessageType,
  payload: Record<string, unknown>,
  opts: { exclude: readonly string[] },
): Promise<void> {
  const msg: UserMessage = { userId: '*', type, payload, exclude: opts.exclude, authedOnly: true };
  try {
    await ctx.redis.main.publish(USER_CHANNEL, JSON.stringify(msg));
  } catch {
    // Never fail the request.
  }
}

/**
 * Tell every realtime room that a player's outfit changed. Rooms hold the PlayerState, so this
 * goes over the presence channel they subscribe to. Never fails the request.
 * @param ctx - The application context.
 * @param userId - The player.
 * @param outfit - The new outfit name, or null for none.
 */
export async function publishOutfit(
  ctx: AppContext,
  userId: string,
  outfit: string | null,
): Promise<void> {
  try {
    await ctx.redis.main.publish(OUTFIT_CHANNEL, JSON.stringify({ userId, outfit }));
  } catch {
    // Viewers catch up on their next join.
  }
}

/**
 * Recompute a player's outfit from the database and publish it. Call after an open shift
 * starts or ends, or the look changes.
 * @param ctx - The application context.
 * @param userId - The player.
 */
export async function refreshOutfit(ctx: AppContext, userId: string): Promise<void> {
  try {
    const r = await ctx.db.withConnection((c) =>
      c.query<{ on_shift: boolean; uniform_equipped: boolean }>(
        `SELECT ${outfitStateSql('u.id', '(SELECT look FROM characters WHERE user_id = u.id)')}
           FROM users u WHERE u.id = $1`,
        [userId],
      ),
    );
    const row = r.rows[0];
    await publishOutfit(
      ctx,
      userId,
      computeOutfit(row?.on_shift === true, row?.uniform_equipped === true),
    );
  } catch {
    // Never fail the action that triggered it.
  }
}

/**
 * Send a message to one player, if they are connected.
 * @param ctx - The application context.
 * @param userId - The recipient.
 * @param type - The contract message name.
 * @param payload - The message body.
 */
export async function publishToUser(
  ctx: AppContext,
  userId: string,
  type: UserMessageType,
  payload: Record<string, unknown>,
): Promise<void> {
  const msg: UserMessage = { userId, type, payload };
  try {
    await ctx.redis.main.publish(USER_CHANNEL, JSON.stringify(msg));
  } catch {
    // A player who cannot be reached must never fail the request that
    // triggered the notification.
  }
}

/**
 * Broadcast a world event to everyone in the city, and keep it in the recent
 * list (server/application/world-events.ts).
 * @param ctx - The application context.
 * @param eventId - One of the contract's evt_* ids.
 * @param params - Optional string params for the client's copy.
 */
export async function publishWorldEvent(
  ctx: AppContext,
  eventId: string,
  params: Record<string, string> = {},
): Promise<void> {
  const at = Date.now();
  await publishToUser(ctx, '*', 'event', { eventId, params, at });
  // Kept for GET /v1/events/active (last 2 h, newest 50).
  await recordWorldEvent(ctx.redis.main, { eventId, params, at });
}

/**
 * Subscribe to the targeted-message channel.
 *
 * Uses its own connection because a Redis client in subscriber mode
 * cannot run normal commands.
 * @param redis - A client to duplicate for subscribing.
 * @param handler - Called for every well-formed message.
 * @returns The subscriber, so the caller can close it on shutdown.
 */
export function subscribeUserMessages(redis: Redis, handler: (msg: UserMessage) => void): Redis {
  const sub = redis.duplicate();
  void sub.subscribe(USER_CHANNEL);
  sub.on('message', (_channel: string, raw: string) => {
    try {
      const parsed = JSON.parse(raw) as UserMessage;
      if (typeof parsed.userId === 'string' && typeof parsed.type === 'string') {
        handler(parsed);
      }
    } catch {
      // Ignore anything that is not one of our messages.
    }
  });
  return sub;
}
