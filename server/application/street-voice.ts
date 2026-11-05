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
 * Revocation: LiveKit checks a token only on connect, and it hands connected
 * participants refreshed tokens itself, so a removed participant can come back
 * with a token it still holds. Three layers close that:
 *   1. Street tokens last 2 minutes (`STREET_TOKEN_TTL_SEC`), so a token copied
 *      out of the client is soon useless for a new connection.
 *   2. Every `participant_joined` webhook on a `proximity:` room is checked
 *      again (`checkStreetVoiceJoin`): not in that street instance, or out of
 *      minutes, and the backend removes the participant at once.
 *   3. The street room's minute sweep (`streetVoiceRemovals`) covers everyone
 *      the webhook says is connected to its voice room, not just its members,
 *      so a removal that failed on leave is retried.
 *
 * Minutes: LiveKit Cloud's free plan is a hard cap of 5,000 participant-minutes
 * a month ("new requests fail after it's exceeded",
 * https://docs.livekit.io/home/cloud/quotas-and-limits/), shared with venue
 * voice, Spaces and calls. Street voice joins listen-only on every street, so
 * it is capped per player and for the whole deployment per UTC day. Usage is
 * counted from the LiveKit webhook: `participant_joined` opens a session keyed
 * by the LiveKit participant SID (one hash, `ctl:voice:street:sessions`), and
 * only a `participant_left` with the same SID closes it and adds its seconds to
 * the per-day counters of the user and of the deployment. Claiming the webhook
 * event id and changing the counters run in one Lua script, so a retried or
 * failed event never counts twice or half. Open sessions count towards both
 * caps while they run. New tokens check both caps, joins are re-checked, and
 * the street room disconnects connected players past either cap. Without the
 * webhook nothing is counted and the caps never trigger.
 */
import { mediaPlayerId } from '../shared/livekit/identity.js';
import type { Redis } from 'ioredis';
import { NotInAreaError, VoiceMinutesExhaustedError } from '../shared/domain/errors.js';
import { streetMembersKey } from '../realtime/street-presence.js';
import { DISTRICTS } from '../realtime/movement.js';
import type { AppContext } from './context.js';

/**
 * Street voice token lifetime: enough to connect, short enough that a token
 * kept after leaving or a kick is soon useless (see Revocation above).
 */
export const STREET_TOKEN_TTL_SEC = 2 * 60;

/** The LiveKit room kind street voice uses. */
export const STREET_VOICE_KIND = 'proximity';

/** An open session older than this counts only this much (a lost `participant_left`). */
export const OPEN_SESSION_MAX_SEC = 2 * 60 * 60;

/** An open session older than this is forgotten (its `participant_left` was lost). */
const OPEN_STALE_SEC = 6 * 60 * 60;
/** Lifetime of a day's counters (two days, so a read just after midnight still finds yesterday's). */
const DAY_TTL_SEC = 2 * 24 * 60 * 60;
/** Webhook event ids already counted (LiveKit retries a webhook it thinks failed). */
const EVENT_TTL_SEC = 24 * 60 * 60;
/** A `participant_left` that found no session: a late `participant_joined` for that SID is ignored. */
const LEFT_TTL_SEC = 24 * 60 * 60;

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

const SESSIONS_KEY = 'ctl:voice:street:sessions';

function usedKey(day: string, userId: string): string {
  return `ctl:voice:street:sec:${day}:u:${userId}`;
}
function totalKey(day: string): string {
  return `ctl:voice:street:sec:${day}:total`;
}
function eventKey(id: string): string {
  return `ctl:voice:street:evt:${id}`;
}
function leftKey(sid: string): string {
  return `ctl:voice:street:left:${sid}`;
}

/** One connected street voice participant, per the webhook. */
export interface StreetVoiceSession {
  /** The LiveKit participant SID (or `<identity>|<room>` when LiveKit sent none). */
  readonly sid: string;
  readonly userId: string;
  readonly room: string;
  /** Epoch ms. */
  readonly startedMs: number;
}

/**
 * The open street voice sessions. Sessions older than 6 h (their leave was
 * lost) are dropped from the hash on the way.
 * @param redis - The main Redis.
 * @param nowMs - Now.
 */
export async function streetVoiceSessions(
  redis: Redis,
  nowMs: number,
): Promise<StreetVoiceSession[]> {
  const raw = await redis.hgetall(SESSIONS_KEY);
  const out: StreetVoiceSession[] = [];
  const stale: string[] = [];
  for (const [sid, value] of Object.entries(raw)) {
    const parts = value.split('|');
    const startedMs = Number(parts[0]);
    const userId = parts[1] ?? '';
    const room = parts.slice(2).join('|');
    if (!Number.isFinite(startedMs) || userId === '' || nowMs - startedMs > OPEN_STALE_SEC * 1000) {
      stale.push(sid);
      continue;
    }
    out.push({ sid, userId, room, startedMs });
  }
  if (stale.length > 0) await redis.hdel(SESSIONS_KEY, ...stale);
  return out;
}

function openSeconds(s: StreetVoiceSession, nowMs: number): number {
  if (s.startedMs > nowMs) return 0;
  return Math.min(OPEN_SESSION_MAX_SEC, Math.floor((nowMs - s.startedMs) / 1000));
}

interface Usage {
  /** Today's closed seconds plus the open sessions so far, per user. */
  readonly seconds: (userId: string) => number;
  /** The whole deployment's seconds today, open sessions included. */
  readonly totalSeconds: number;
  readonly sessions: readonly StreetVoiceSession[];
}

async function usageToday(redis: Redis, userIds: readonly string[], nowMs: number): Promise<Usage> {
  const day = utcDay(nowMs);
  const sessions = await streetVoiceSessions(redis, nowMs);
  const keys = [totalKey(day), ...userIds.map((u) => usedKey(day, u))];
  const closed = await redis.mget(...keys);
  const perUser = new Map<string, number>();
  userIds.forEach((u, i) => perUser.set(u, Number(closed[i + 1]) || 0));
  let total = Number(closed[0]) || 0;
  for (const s of sessions) {
    const open = openSeconds(s, nowMs);
    total += open;
    if (perUser.has(s.userId)) perUser.set(s.userId, perUser.get(s.userId)! + open);
  }
  return { seconds: (u) => perUser.get(u) ?? 0, totalSeconds: total, sessions };
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
  return (await usageToday(redis, [userId], nowMs)).seconds(userId);
}

type CapVerdict = { scope: 'player' | 'total'; capMinutes: number } | null;

function overCap(ctx: AppContext, usage: Usage, userId: string): CapVerdict {
  const perPlayer = ctx.config.livekit.streetVoiceDailyMinutesPerPlayer;
  const total = ctx.config.livekit.streetVoiceDailyMinutesTotal;
  if (total > 0 && usage.totalSeconds >= total * 60) return { scope: 'total', capMinutes: total };
  if (perPlayer > 0 && usage.seconds(userId) >= perPlayer * 60) {
    return { scope: 'player', capMinutes: perPlayer };
  }
  return null;
}

/**
 * Throw `429 VOICE_MINUTES_EXHAUSTED` when the caller or the deployment has
 * used today's street voice minutes (open sessions included). A cap of 0 is
 * "no cap".
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param nowMs - Now.
 */
export async function assertStreetVoiceMinutesLeft(
  ctx: AppContext,
  userId: string,
  nowMs: number,
): Promise<void> {
  const verdict = overCap(ctx, await usageToday(ctx.redis.main, [userId], nowMs), userId);
  if (verdict) {
    throw new VoiceMinutesExhaustedError({
      ...verdict,
      resetsAt: nextUtcMidnight(nowMs).toISOString(),
    });
  }
}

export interface StreetVoiceEvent {
  readonly event: string;
  readonly room?: { readonly name?: string };
  readonly participant?: { readonly identity?: string; readonly sid?: string };
  /** Epoch seconds, as LiveKit sends it. */
  readonly createdAt?: number;
}

// KEYS: event claim, sessions hash, left marker. ARGV: event ttl, sid, value, left ttl.
const JOIN_SCRIPT = `
if not redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX') then return 0 end
if redis.call('EXISTS', KEYS[3]) == 1 then return 2 end
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 1
`;

// KEYS: event claim, sessions hash, left marker, user day counter, total day counter.
// ARGV: event ttl, sid, identity, at ms, max seconds, day ttl, left ttl.
const LEAVE_SCRIPT = `
if not redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX') then return 0 end
local v = redis.call('HGET', KEYS[2], ARGV[2])
if not v then
  redis.call('SET', KEYS[3], '1', 'EX', ARGV[7])
  return 2
end
local started, user = string.match(v, '^([^|]+)|([^|]+)|')
if user ~= ARGV[3] then return 3 end
redis.call('HDEL', KEYS[2], ARGV[2])
local secs = math.floor((tonumber(ARGV[4]) - tonumber(started)) / 1000)
if secs > tonumber(ARGV[5]) then secs = tonumber(ARGV[5]) end
if secs <= 0 then return 1 end
redis.call('INCRBY', KEYS[4], secs)
redis.call('EXPIRE', KEYS[4], ARGV[6])
redis.call('INCRBY', KEYS[5], secs)
redis.call('EXPIRE', KEYS[5], ARGV[6])
return 1
`;

/**
 * Count a LiveKit webhook event against the street voice minutes. Only
 * `participant_joined` / `participant_left` on `proximity:` rooms count.
 * Sessions are keyed by participant SID: a leave closes only the session with
 * its SID, a leave that matches nothing keeps every entry (and makes a later
 * join for that SID a no-op). The event-id claim and the writes are one Lua
 * script, so a retried event counts once and a failed one can be retried.
 * @param ctx - The application context.
 * @param eventId - The event id (or the body hash when LiveKit sent none).
 * @param event - The verified event.
 * @param nowMs - Fallback time when the event carries none.
 * @returns True when the event changed the sessions or counters.
 */
export async function recordStreetVoiceEvent(
  ctx: AppContext,
  eventId: string,
  event: StreetVoiceEvent,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const room = event.room?.name ?? '';
  const rawIdentity = event.participant?.identity ?? '';
  const identity = mediaPlayerId(rawIdentity) ?? '';
  if (!room.startsWith(`${STREET_VOICE_KIND}:`) || identity === '' || identity.includes('|')) {
    return false;
  }
  if (event.event !== 'participant_joined' && event.event !== 'participant_left') return false;
  const sid = event.participant?.sid || `${rawIdentity}|${room}`;
  const at =
    typeof event.createdAt === 'number' && Number.isFinite(event.createdAt) && event.createdAt > 0
      ? event.createdAt * 1000
      : nowMs;
  const redis = ctx.redis.main;
  if (event.event === 'participant_joined') {
    const r = await redis.eval(
      JOIN_SCRIPT,
      3,
      eventKey(eventId),
      SESSIONS_KEY,
      leftKey(sid),
      String(EVENT_TTL_SEC),
      sid,
      `${at}|${identity}|${room}`,
      String(LEFT_TTL_SEC),
    );
    return r === 1;
  }
  const day = utcDay(at);
  const r = await redis.eval(
    LEAVE_SCRIPT,
    5,
    eventKey(eventId),
    SESSIONS_KEY,
    leftKey(sid),
    usedKey(day, identity),
    totalKey(day),
    String(EVENT_TTL_SEC),
    sid,
    identity,
    String(at),
    String(OPEN_SESSION_MAX_SEC),
    String(DAY_TTL_SEC),
    String(LEFT_TTL_SEC),
  );
  return r === 1;
}

/** Why a street voice participant may not stay connected, or null. */
export type StreetVoiceRefusal = 'not_in_area' | 'minutes_player' | 'minutes_total';

/**
 * Re-check a participant LiveKit just let into a street voice room (the
 * `participant_joined` webhook): still in that street instance, and within
 * today's minutes. A token held after leaving or a kick, or one LiveKit
 * refreshed, fails here and the caller removes the participant.
 * @param ctx - The application context.
 * @param room - The LiveKit room name (`proximity:<district>:<instanceId>`).
 * @param userId - The participant identity.
 * @param nowMs - Now.
 * @returns The refusal, or null when they may stay (also for rooms that are not street voice).
 */
export async function checkStreetVoiceJoin(
  ctx: AppContext,
  room: string,
  userId: string,
  nowMs: number,
): Promise<StreetVoiceRefusal | null> {
  const where = room.startsWith(`${STREET_VOICE_KIND}:`) ? parseStreetVoiceId(room) : null;
  if (!where) return null;
  const present = await ctx.redis.main.hget(
    streetMembersKey(where.district, where.instanceId),
    userId,
  );
  if (!(Number(present) > 0)) return 'not_in_area';
  const verdict = overCap(ctx, await usageToday(ctx.redis.main, [userId], nowMs), userId);
  if (verdict) return verdict.scope === 'total' ? 'minutes_total' : 'minutes_player';
  return null;
}

/**
 * Who to disconnect from one street instance's voice room: everyone the
 * webhook says is connected to it (members or not) who is no longer in the
 * instance, is past the per-player minutes, or, once the deployment's
 * minutes are gone, everyone connected. Only connected identities are returned.
 * @param ctx - The application context.
 * @param district - The street room's district.
 * @param instanceId - The street room id.
 * @param nowMs - Now.
 */
export async function streetVoiceRemovals(
  ctx: AppContext,
  district: string,
  instanceId: string,
  nowMs: number,
): Promise<string[]> {
  const room = `${STREET_VOICE_KIND}:${streetVoiceId(district, instanceId)}`;
  const sessions = (await streetVoiceSessions(ctx.redis.main, nowMs)).filter(
    (s) => s.room === room,
  );
  const connected = [...new Set(sessions.map((s) => s.userId))];
  if (connected.length === 0) return [];
  const usage = await usageToday(ctx.redis.main, connected, nowMs);
  const counts = await ctx.redis.main.hmget(streetMembersKey(district, instanceId), ...connected);
  return connected.filter((u, i) => !(Number(counts[i]) > 0) || overCap(ctx, usage, u) !== null);
}
