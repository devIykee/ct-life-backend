/**
 * Recent world events (`evt_*`), kept so a player who opens the Week app sees
 * what just happened in the city, not only what happens while they watch.
 *
 * `publishWorldEvent` (realtime-bus.ts) and the city room's market-mood event
 * both call `recordWorldEvent`, which writes the event to a Redis sorted set
 * (score = `at`, epoch ms). Each write trims the set to the window
 * (`WORLD_EVENTS_WINDOW_MS`) and to the newest `WORLD_EVENTS_MAX` entries, so
 * it never grows without bound. `GET /v1/events/active` reads it back newest
 * first (`listActiveWorldEvents`).
 *
 * Fire and forget: a Redis failure never fails the action that produced the
 * event (a rug, a launch); the event just does not show in the list.
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

/** Redis sorted set holding recent world events. */
export const WORLD_EVENTS_KEY = 'world:events';
/** How far back `GET /events/active` looks: 2 hours. */
export const WORLD_EVENTS_WINDOW_MS = 2 * 60 * 60 * 1000;
/** At most this many events are kept and returned. */
export const WORLD_EVENTS_MAX = 50;

const EVENT_ID = /^evt_[a-z0-9_]{1,60}$/;
const PARAM_KEY = /^[A-Za-z0-9_]{1,40}$/;
const MAX_PARAMS = 12;
const MAX_PARAM_LEN = 200;

export interface WorldEvent {
  readonly eventId: string;
  /** Epoch ms when the server published the event. */
  readonly at: number;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Keep only well-formed string params (bounded count and length), so a stored
 * event can never carry more than the client will render.
 * @param params - The params as published.
 * @returns A clean copy.
 */
export function cleanParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(params)) {
    if (n >= MAX_PARAMS) break;
    if (!PARAM_KEY.test(k) || typeof v !== 'string') continue;
    out[k] = v.slice(0, MAX_PARAM_LEN);
    n++;
  }
  return out;
}

/**
 * Store one world event and trim the set. Never throws.
 * @param redis - The main Redis client.
 * @param event - The event as broadcast.
 */
export async function recordWorldEvent(redis: Redis, event: WorldEvent): Promise<void> {
  if (!EVENT_ID.test(event.eventId) || !Number.isSafeInteger(event.at)) return;
  // A nonce keeps two identical events in the same millisecond as two members.
  const member = JSON.stringify({
    eventId: event.eventId,
    at: event.at,
    params: cleanParams(event.params),
    n: randomBytes(4).toString('hex'),
  });
  try {
    await redis
      .multi()
      .zadd(WORLD_EVENTS_KEY, event.at, member)
      .zremrangebyscore(WORLD_EVENTS_KEY, '-inf', `(${event.at - WORLD_EVENTS_WINDOW_MS}`)
      .zremrangebyrank(WORLD_EVENTS_KEY, 0, -(WORLD_EVENTS_MAX + 1))
      .pexpire(WORLD_EVENTS_KEY, WORLD_EVENTS_WINDOW_MS * 2)
      .exec();
  } catch {
    // The list is a convenience; the broadcast already went out.
  }
}

/**
 * The world events of the last 2 hours, newest first, at most 50.
 * @param redis - The main Redis client.
 * @param now - Epoch ms (injectable for tests).
 * @returns The events.
 */
export async function listActiveWorldEvents(
  redis: Redis,
  now: number = Date.now(),
): Promise<WorldEvent[]> {
  const raw = await redis.zrevrangebyscore(
    WORLD_EVENTS_KEY,
    '+inf',
    now - WORLD_EVENTS_WINDOW_MS,
    'LIMIT',
    0,
    WORLD_EVENTS_MAX,
  );
  const out: WorldEvent[] = [];
  for (const m of raw) {
    try {
      const e = JSON.parse(m) as { eventId?: unknown; at?: unknown; params?: unknown };
      if (typeof e.eventId !== 'string' || typeof e.at !== 'number') continue;
      const params =
        e.params && typeof e.params === 'object' ? (e.params as Record<string, unknown>) : {};
      out.push({ eventId: e.eventId, at: e.at, params: cleanParams(params) });
    } catch {
      // Skip anything that is not one of ours.
    }
  }
  return out;
}

/**
 * Store an event that several processes may raise at once (each city shard
 * computes the same market mood), but only once per `ttlMs`: the first caller
 * to claim `dedupeKey` records it, the rest skip. Never throws.
 * @param redis - The main Redis client.
 * @param event - The event as broadcast.
 * @param dedupeKey - Short name for this kind of event.
 * @param ttlMs - How long the claim lasts.
 */
export async function recordWorldEventOnce(
  redis: Redis,
  event: WorldEvent,
  dedupeKey: string,
  ttlMs: number,
): Promise<void> {
  try {
    const won = await redis.set(`${WORLD_EVENTS_KEY}:once:${dedupeKey}`, '1', 'PX', ttlMs, 'NX');
    if (won !== 'OK') return;
  } catch {
    return;
  }
  await recordWorldEvent(redis, event);
}
