/**
 * Realtime bus: how the REST API reaches a connected player.
 *
 * The api and realtime services are separate processes, so a handler that
 * wants to ring a callee or push a toast cannot touch the Colyseus room
 * directly. It publishes here instead; the city room subscribes and
 * forwards to that user's client. This is the single mechanism behind the
 * targeted messages in the contract (`toast`, `dm`, `call_invite`,
 * `space_update`, `payment_confirmed`, `liquidated`, `delivery_out`,
 * `delivery_arrived`), which previously had
 * no transport at all: a video call returned a callId and the callee was
 * never rung.
 *
 * Fire and forget. A player who is offline simply misses it; nothing is
 * queued, which matches the contract's "the client refetches on join".
 */
import type { Redis } from 'ioredis';
import type { AppContext } from './context.js';

/** Redis pub/sub channel carrying every targeted message. */
export const USER_CHANNEL = 'rt:user';

/** Message types the city room knows how to forward. */
export type UserMessageType =
  | 'toast'
  | 'dm'
  | 'call_invite'
  | 'space_update'
  | 'payment_confirmed'
  | 'liquidated'
  | 'delivery_out'
  | 'delivery_arrived'
  | 'event';

export interface UserMessage {
  readonly userId: string;
  readonly type: UserMessageType;
  readonly payload: Record<string, unknown>;
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
 * Broadcast a world event to everyone in the city.
 * @param ctx - The application context.
 * @param eventId - One of the contract's evt_* ids.
 * @param params - Optional string params for the client's copy.
 */
export async function publishWorldEvent(
  ctx: AppContext,
  eventId: string,
  params: Record<string, string> = {},
): Promise<void> {
  await publishToUser(ctx, '*', 'event', { eventId, params, at: Date.now() });
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
