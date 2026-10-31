/**
 * Street voice access and minutes (capability `streetVoice`, docs/STREET-VOICE.md).
 *
 * Room: one LiveKit room per street Colyseus instance,
 * `proximity:<district>:<instanceId>`, so voice membership equals visibility
 * membership (the street room is one instance per district, up to 100
 * players). The token id is `<district>:<instanceId>`.
 *
 * Presence: the street room counts every joined session in
 * `ctl:street:members:<district>:<instanceId>` (server/realtime/
 * street-presence.ts) and `assertInStreetInstance` reads that count. Fails
 * closed: a missing hash, field or a count of zero is "not present" (403
 * NOT_IN_AREA); a Redis error propagates (no token).
 *
 * District edges: no cross-district voice. Two players a few metres apart on
 * either side of a district line are in different street rooms, so they
 * neither see nor hear each other; the client holds the room of the district
 * it stands in and swaps (make-before-break) when it crosses. A token is
 * never minted for a neighbouring instance the caller is not in.
 *
 * Minutes: LiveKit Cloud's free plan is a hard cap of 5,000 participant-minutes
 * a month ("new requests fail after it's exceeded",
 * https://docs.livekit.io/home/cloud/quotas-and-limits/), shared with venue
 * voice, Spaces and calls. Street voice joins listen-only on every street, so
 * it is capped per player and for the whole deployment per UTC day. Usage is
 * counted from the LiveKit webhook (`participant_joined` / `participant_left`
 * on `proximity:` rooms): the open session's start is kept per user, and the
 * closed seconds are added to a per-day counter for the user and for the
 * deployment. New tokens check both caps; the street room disconnects a
 * connected player who runs past the per-player cap (`usersOverStreetVoiceCap`).
 * Without the webhook nothing is counted and the caps never trigger.
 */
import type { Redis } from 'ioredis';
import { NotInAreaError, VoiceMinutesExhaustedError } from '../shared/domain/errors.js';
import { streetMembersKey } from '../realtime/street-presence.js';
import { DISTRICTS } from '../realtime/movement.js';
import type { AppContext } from './context.js';

/** Street voice token lifetime: enough to connect, short enough to go stale. */
export const STREET_TOKEN_TTL_SEC = 10 * 60;

/** The LiveKit room kind street voice uses. */
export const STREET_VOICE_KIND = 'proximity';

/** An open session older than this counts only this much (a lost `participant_left`). */
export const OPEN_SESSION_MAX_SEC = 2 * 60 * 60;

/** Idle lifetime of a user's open-session hash. */
const OPEN_TTL_SEC = 6 * 60 * 60;
/** Lifetime of a day's counters (two days, so a read just after midnight still finds yesterday's). */
const DAY_TTL_SEC = 2 * 24 * 60 * 60;
/** Webhook event ids already counted (LiveKit retries a webhook it thinks failed). */
const EVENT_TTL_SEC = 24 * 60 * 60;

export interface StreetVoiceId {
  readonly district: string;
  readonly instanceId: string;
}

/**
 * Parse a street voice id, `<district>:<instanceId>`, with or without the
 * `proximity:` prefix.
 * @param id - The id from the token request.
 * @returns The parts, or null when the district is unknown or the instance id is empty.
 */
export function parseStreetVoiceId(id: string): StreetVoiceId | null {
  const bare = id.startsWith(`${STREET_VOICE_KIND}:`) ? id.slice(STREET_VOICE_KIND.length + 1) : id;
  const sep = bare.indexOf(':');
  if (sep <= 0) return null;
  const district = bare.slice(0, sep);
  const instanceId = bare.slice(sep + 1);
  if (!(DISTRICTS as readonly string[]).includes(district)) return null;
  if (instanceId.length === 0 || instanceId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(instanceId)) {
    return null;
  }
  return { district, instanceId };
}

/**
 * The token id and LiveKit room name of one street instance.
 * @param district - The street room's district.
 * @param instanceId - The street room id.
 */
export function streetVoiceId(district: string, instanceId: string): string {
  return `${district}:${instanceId}`;
}

/**
 * Throw unless `userId` has a session in the street instance.
 * @param ctx - The application context.
 * @param where - The street instance.
 * @param userId - The caller.
 * @throws NotInAreaError when the caller is not in that instance.
 */
export async function assertInStreetInstance(
  ctx: AppContext,
  where: StreetVoiceId,
  userId: string,
): Promise<void> {
  const raw = await ctx.redis.main.hget(streetMembersKey(where.district, where.instanceId), userId);
  if (!(Number(raw) > 0)) {
    throw new NotInAreaError({ district: where.district, instanceId: where.instanceId });
  }
}

/** The UTC day a time falls in, `YYYY-MM-DD`. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** The next UTC midnight after `nowMs`. */
export function nextUtcMidnight(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

function openKey(userId: string): string {
  return `ctl:voice:street:open:${userId}`;
}
function usedKey(day: string, userId: string): string {
  return `ctl:voice:street:sec:${day}:u:${userId}`;
}
function totalKey(day: string): string {
  return `ctl:voice:street:sec:${day}:total`;
}

interface StreetVoiceUsage {
  /** Closed seconds today plus the open sessions so far. */
  readonly seconds: number;
  /** Open (connected, per the webhook) street voice sessions. */
  readonly open: number;
}

async function usageToday(redis: Redis, userId: string, nowMs: number): Promise<StreetVoiceUsage> {
  const [closed, open] = await Promise.all([
    redis.get(usedKey(utcDay(nowMs), userId)),
    redis.hgetall(openKey(userId)),
  ]);
  let seconds = Number(closed) || 0;
  let count = 0;
  for (const startedRaw of Object.values(open)) {
    const started = Number(startedRaw);
    if (!Number.isFinite(started) || started > nowMs) continue;
    count += 1;
    seconds += Math.min(OPEN_SESSION_MAX_SEC, Math.floor((nowMs - started) / 1000));
  }
  return { seconds, open: count };
}

/**
 * Seconds of street voice `userId` has used today: closed sessions plus the
 * open ones so far (each open one counts at most `OPEN_SESSION_MAX_SEC`).
 * @param redis - The main Redis.
 * @param userId - The player.
 * @param nowMs - Now.
 */
export async function streetVoiceSecondsToday(
  redis: Redis,
  userId: string,
  nowMs: number,
): Promise<number> {
  return (await usageToday(redis, userId, nowMs)).seconds;
}

/**
 * Throw `429 VOICE_MINUTES_EXHAUSTED` when the caller or the deployment has
 * used today's street voice minutes. A cap of 0 is "no cap".
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param nowMs - Now.
 */
export async function assertStreetVoiceMinutesLeft(
  ctx: AppContext,
  userId: string,
  nowMs: number,
): Promise<void> {
  const perPlayer = ctx.config.livekit.streetVoiceDailyMinutesPerPlayer;
  const total = ctx.config.livekit.streetVoiceDailyMinutesTotal;
  const resetsAt = nextUtcMidnight(nowMs).toISOString();
  if (total > 0) {
    const used = Number(await ctx.redis.main.get(totalKey(utcDay(nowMs)))) || 0;
    if (used >= total * 60) {
      throw new VoiceMinutesExhaustedError({ scope: 'total', capMinutes: total, resetsAt });
    }
  }
  if (perPlayer > 0) {
    const used = await streetVoiceSecondsToday(ctx.redis.main, userId, nowMs);
    if (used >= perPlayer * 60) {
      throw new VoiceMinutesExhaustedError({ scope: 'player', capMinutes: perPlayer, resetsAt });
    }
  }
}

export interface StreetVoiceEvent {
  readonly event: string;
  readonly room?: { readonly name?: string };
  readonly participant?: { readonly identity?: string };
  /** Epoch seconds, as LiveKit sends it. */
  readonly createdAt?: number;
}

/**
 * Count a LiveKit webhook event against the street voice minutes. Only
 * `participant_joined` / `participant_left` on `proximity:` rooms count; each
 * event key counts once (LiveKit retries).
 * @param ctx - The application context.
 * @param eventKey - The event id (or the body hash when LiveKit sent none).
 * @param event - The verified event.
 * @param nowMs - Fallback time when the event carries none.
 * @returns True when the event changed the counters.
 */
export async function recordStreetVoiceEvent(
  ctx: AppContext,
  eventKey: string,
  event: StreetVoiceEvent,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const room = event.room?.name ?? '';
  const identity = event.participant?.identity ?? '';
  if (!room.startsWith(`${STREET_VOICE_KIND}:`) || identity === '') return false;
  if (event.event !== 'participant_joined' && event.event !== 'participant_left') return false;
  const redis = ctx.redis.main;
  const first = await redis.set(`ctl:voice:street:evt:${eventKey}`, '1', 'EX', EVENT_TTL_SEC, 'NX');
  if (first !== 'OK') return false;
  const at =
    typeof event.createdAt === 'number' && Number.isFinite(event.createdAt) && event.createdAt > 0
      ? event.createdAt * 1000
      : nowMs;
  const key = openKey(identity);
  if (event.event === 'participant_joined') {
    await redis.hset(key, room, String(at));
    await redis.expire(key, OPEN_TTL_SEC);
    return true;
  }
  const startedRaw = await redis.hget(key, room);
  await redis.hdel(key, room);
  const started = Number(startedRaw);
  if (startedRaw === null || !Number.isFinite(started) || started > at) return false;
  const seconds = Math.min(OPEN_SESSION_MAX_SEC, Math.floor((at - started) / 1000));
  if (seconds <= 0) return false;
  const day = utcDay(at);
  await redis
    .multi()
    .incrby(usedKey(day, identity), seconds)
    .expire(usedKey(day, identity), DAY_TTL_SEC)
    .incrby(totalKey(day), seconds)
    .expire(totalKey(day), DAY_TTL_SEC)
    .exec();
  return true;
}

/**
 * The users among `userIds` who are connected to street voice (an open
 * session per the webhook) and have used their minutes today, open session
 * included. Empty while the per-player cap is 0.
 * @param ctx - The application context.
 * @param userIds - The candidates (e.g. a street room's members).
 * @param nowMs - Now.
 */
export async function usersOverStreetVoiceCap(
  ctx: AppContext,
  userIds: readonly string[],
  nowMs: number,
): Promise<string[]> {
  const cap = ctx.config.livekit.streetVoiceDailyMinutesPerPlayer;
  if (cap <= 0 || userIds.length === 0) return [];
  const usage = await Promise.all(userIds.map((u) => usageToday(ctx.redis.main, u, nowMs)));
  return userIds.filter((_, i) => usage[i]!.open > 0 && usage[i]!.seconds >= cap * 60);
}
