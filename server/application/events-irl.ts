/**
 * Opt-in IRL check-in for real events (Breakpoint 2026).
 *
 *   POST /v1/events/{slug}/checkin              — prove you are at the venue
 *   PUT  /v1/events/{slug}/checkin/visibility   — appear on / leave the board
 *   GET  /v1/events/{slug}/irl                  — the visible attendees
 *
 * PRIVACY (UK GDPR; the event is in London). The client sends its position;
 * the server compares it with the venue geofence in memory and discards it.
 * Latitude, longitude, accuracy and distance are never written to the
 * database, never logged (request bodies are redacted) and never put in an
 * error. What is stored is `event_checkins(event_id, user_id, checked_in_at,
 * visible)` and nothing else. See docs/PRIVACY_IRL_CHECKIN.md.
 *
 * A check-in is accepted only when: the event is live; the phone does not
 * report a mock location; the reported accuracy is at most 150 m; the
 * account was created before the event started; and the position is inside
 * the venue radius. The first accepted check-in per player per event pays the
 * one-time IRL reward (Cash ledger reason `event_irl_bonus` plus off-chain
 * cosmetics). `users.wallet` is unique, so this is one claim per wallet.
 *
 * What cannot be verified: the position is reported by the client, so a
 * rooted phone with a spoofing tool that hides the mock flag can lie. The
 * flag, the accuracy cap and the account-age rule raise the cost; they do
 * not prove presence. The reward is cosmetic plus a modest Cash bonus.
 */
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { runInTransaction } from '../shared/db/uow.js';
import {
  CheckinRejectedError,
  EventNotLiveError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { perUserTokenBucket } from '../shared/infra/rate-limit.js';
import type { AppContext } from './context.js';
import { grantCosmetic, ensureCatalog } from './cosmetics.js';
import { ensureEventsSynced, loadCalendar, loadEvent, statusOf } from './events.js';
import { publishToCityExcept } from './realtime-bus.js';

/** Largest reported accuracy radius (metres) a check-in may carry. */
export const MAX_ACCURACY_M = 150;
export const DEFAULT_IRL_BONUS_CENTS = 10_000;
const EARTH_RADIUS_M = 6_371_000;

/**
 * The one-time IRL Cash bonus, from `EVENT_IRL_BONUS_CENTS` (default 10000).
 * @returns Cents, an integer >= 0.
 */
export function irlBonusCents(): number {
  const raw = process.env.EVENT_IRL_BONUS_CENTS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_IRL_BONUS_CENTS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_IRL_BONUS_CENTS;
}

/**
 * Great-circle distance in metres.
 * @param aLat - Latitude of A, degrees.
 * @param aLng - Longitude of A, degrees.
 * @param bLat - Latitude of B, degrees.
 * @param bLng - Longitude of B, degrees.
 */
export function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface CheckinInput {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number;
  readonly isMock: boolean;
}

export interface CheckinResult {
  readonly slug: string;
  readonly checkedIn: true;
  readonly checkedInAt: string;
  readonly visible: boolean;
  /** False when this player had already checked in (a replay; nothing paid). */
  readonly firstCheckin: boolean;
  /** The reward paid by this very call; null on a replay. */
  readonly reward: { cashCents: number; itemKeys: string[] } | null;
}

/**
 * Check in at the venue. The position in `input` is used and dropped here.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param slug - The event slug.
 * @param input - The reported position, accuracy and mock flag.
 * @param now - The clock.
 * @throws EventNotLiveError outside the window; CheckinRejectedError with a
 *   reason (mock_location, poor_accuracy, account_too_new, not_available,
 *   outside_geofence).
 */
export async function checkIn(
  ctx: AppContext,
  userId: string,
  slug: string,
  input: CheckinInput,
  now: Date = new Date(),
): Promise<CheckinResult> {
  await ensureEventsSynced(ctx.db);
  await ensureCatalog(ctx);
  const result = await runInTransaction(async (client) => {
    const ev = await loadEvent(client, slug);
    if (statusOf(ev, now) !== 'live') {
      throw new EventNotLiveError({
        slug,
        status: statusOf(ev, now),
        startsAt: ev.starts_at.toISOString(),
        endsAt: ev.ends_at.toISOString(),
      });
    }
    if (ev.geo_lat === null || ev.geo_lng === null || ev.geo_radius_m === null) {
      throw new CheckinRejectedError('not_available');
    }
    if (input.isMock) throw new CheckinRejectedError('mock_location');
    if (!(input.accuracyM >= 0) || input.accuracyM > MAX_ACCURACY_M) {
      throw new CheckinRejectedError('poor_accuracy');
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `irl:${ev.id}:${userId}`,
    ]);

    const prior = await client.query<{ checked_in_at: Date; visible: boolean }>(
      `SELECT checked_in_at, visible FROM event_checkins WHERE event_id = $1 AND user_id = $2`,
      [ev.id, userId],
    );
    if (prior.rows[0]) {
      return {
        slug,
        checkedIn: true as const,
        checkedInAt: prior.rows[0].checked_in_at.toISOString(),
        visible: prior.rows[0].visible,
        firstCheckin: false,
        reward: null,
      };
    }

    const u = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM users WHERE id = $1`,
      [userId],
    );
    const created = u.rows[0]?.created_at;
    if (!created || created.getTime() >= ev.starts_at.getTime()) {
      throw new CheckinRejectedError('account_too_new');
    }
    if (distanceM(input.lat, input.lng, ev.geo_lat, ev.geo_lng) > ev.geo_radius_m) {
      throw new CheckinRejectedError('outside_geofence');
    }

    await client.query(
      `INSERT INTO event_checkins (event_id, user_id, checked_in_at, visible)
       VALUES ($1, $2, $3, false)`,
      [ev.id, userId, now],
    );
    const cash = irlBonusCents();
    if (cash > 0) {
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await client.query(
        `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
        [cash, userId],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'event_irl_bonus', 'event', $3, $4)`,
        [userId, cash, ev.id, `event-irl:${userId}:${ev.id}`],
      );
    }
    const keys = loadCalendar().events.find((e) => e.id === ev.id)?.irlRewardItemKeys ?? [];
    for (const k of keys) await grantCosmetic(client, userId, k);
    return {
      slug,
      checkedIn: true as const,
      checkedInAt: now.toISOString(),
      visible: false,
      firstCheckin: true,
      reward: { cashCents: cash, itemKeys: keys },
    };
  });
  return result;
}

/**
 * Show or hide the caller on the attendee board. Turning it on tells the city
 * the alias (rate limited: once an hour per player, 10 burst and 2/s per
 * event overall).
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param slug - The event slug.
 * @param visible - The new choice.
 * @param now - The clock.
 * @throws NotFoundError when the caller has not checked in.
 */
export async function setVisibility(
  ctx: AppContext,
  userId: string,
  slug: string,
  visible: boolean,
  now: Date = new Date(),
): Promise<{ slug: string; visible: boolean }> {
  await ensureEventsSynced(ctx.db);
  const r = await ctx.db.withConnection(async (c) => {
    const ev = await loadEvent(c, slug);
    const upd = await c.query<{ visible_before: boolean }>(
      `WITH old AS (SELECT visible FROM event_checkins WHERE event_id = $1 AND user_id = $2)
       UPDATE event_checkins SET visible = $3
        WHERE event_id = $1 AND user_id = $2
        RETURNING (SELECT visible FROM old) AS visible_before`,
      [ev.id, userId, visible],
    );
    if (!upd.rows[0]) throw new NotFoundError({ resource: 'checkin', slug });
    const alias = (
      await c.query<{ alias: string }>(`SELECT alias FROM characters WHERE user_id = $1`, [userId])
    ).rows[0]?.alias;
    return {
      evId: ev.id,
      was: upd.rows[0].visible_before,
      alias,
      live: statusOf(ev, now) === 'live',
    };
  });
  if (visible && !r.was && r.alias && r.live) {
    await announceIrl(ctx, r.evId, slug, userId, r.alias, now);
  }
  return { slug, visible };
}

/**
 * Tell the city (alias only) that an attendee is listed. Presence is
 * sensitive: it goes only (1) while the event is live, (2) for an attendee
 * whose row is visible right now, and (3) to signed-in players other than
 * those who blocked the attendee or were blocked by them. Rate limited.
 */
async function announceIrl(
  ctx: AppContext,
  eventId: string,
  slug: string,
  userId: string,
  alias: string,
  now: Date,
): Promise<void> {
  try {
    const gate = await ctx.db.withConnection(async (c) => {
      const v = await c.query(
        `SELECT 1 FROM event_checkins WHERE event_id = $1 AND user_id = $2 AND visible`,
        [eventId, userId],
      );
      if (v.rowCount === 0) return null;
      const b = await c.query<{ other: string }>(
        `SELECT blocked_user_id AS other FROM blocks WHERE blocker_user_id = $1
         UNION
         SELECT blocker_user_id AS other FROM blocks WHERE blocked_user_id = $1`,
        [userId],
      );
      return b.rows.map((x) => x.other);
    });
    if (gate === null) return;
    const once = await ctx.redis.main.set(`irl:ann:${eventId}:${userId}`, '1', 'EX', 3600, 'NX');
    if (once !== 'OK') return;
    const d = await perUserTokenBucket(ctx.redis.main, `rl:irl-ann:${eventId}`, 10, 2, 1);
    if (!d.allowed) return;
    await publishToCityExcept(
      ctx,
      'irl_checkin',
      { slug, alias, at: now.getTime() },
      { exclude: [...gate, userId] },
    );
  } catch {
    // A missed announcement never fails the request.
  }
}

export interface IrlAttendee {
  readonly alias: string;
  readonly look: unknown;
  readonly tribeId: string | null;
  readonly avatarId: string | null;
  readonly checkedInAt: string;
}

const CURSOR_RE =
  /^(\d{1,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{32})$/;

/** HMAC key for board cursors, derived from the server's JWT signing key (never stored or logged). */
function cursorMac(ctx: AppContext, payload: string): string {
  const key = createHash('sha256')
    .update('irl-board-cursor:' + ctx.config.jwt.privateKeyPem)
    .digest();
  return createHmac('sha256', key).update(payload).digest('hex').slice(0, 32);
}

/** Opaque, signed cursor over (checked_in_at, checkin_id). Carries no user id. */
function makeCursor(ctx: AppContext, ms: number, checkinId: string): string {
  const payload = `${ms}.${checkinId}`;
  return Buffer.from(`${payload}.${cursorMac(ctx, payload)}`).toString('base64url');
}

function parseCursor(ctx: AppContext, cursor: string): { ms: number; cid: string } | null {
  const m = CURSOR_RE.exec(Buffer.from(cursor, 'base64url').toString());
  if (!m) return null;
  const want = Buffer.from(cursorMac(ctx, `${m[1]}.${m[2]}`));
  const got = Buffer.from(m[3]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return { ms: Number(m[1]), cid: m[2]! };
}

/**
 * The visible attendees, newest first, keyset paginated. Blocks are removed in
 * both directions. No position, no user id.
 * @param ctx - The app context.
 * @param userId - The caller (for block filtering).
 * @param slug - The event slug.
 * @param limit - 1 to 50.
 * @param cursor - The `next` of the previous page.
 */
export async function listAttendees(
  ctx: AppContext,
  userId: string,
  slug: string,
  limit: number,
  cursor: string | null,
): Promise<{ items: IrlAttendee[]; next: string | null }> {
  await ensureEventsSynced(ctx.db);
  let after: { ts: Date; cid: string } | null = null;
  if (cursor) {
    const parsed = parseCursor(ctx, cursor);
    if (!parsed) throw new ValidationFailedError({ reason: 'bad_cursor' });
    after = { ts: new Date(parsed.ms), cid: parsed.cid };
  }
  return ctx.db.withConnection(async (c) => {
    const ev = await loadEvent(c, slug);
    const params: unknown[] = [ev.id, userId, limit + 1];
    let keyset = '';
    if (after) {
      params.push(after.ts, after.cid);
      keyset = `AND (ch.checked_in_at, ch.checkin_id) < ($4, $5)`;
    }
    const r = await c.query<{
      checkin_id: string;
      checked_in_at: Date;
      alias: string;
      look: unknown;
      tribe_id: string | null;
      likeness_job_id: string | null;
    }>(
      `SELECT ch.checkin_id, ch.checked_in_at, c.alias, c.look, c.tribe_id, c.likeness_job_id
         FROM event_checkins ch
         JOIN characters c ON c.user_id = ch.user_id
        WHERE ch.event_id = $1 AND ch.visible ${keyset}
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_user_id = $2 AND b.blocked_user_id = ch.user_id)
                OR (b.blocker_user_id = ch.user_id AND b.blocked_user_id = $2))
        ORDER BY ch.checked_in_at DESC, ch.checkin_id DESC
        LIMIT $3`,
      params,
    );
    const page = r.rows.slice(0, limit);
    const last = page[page.length - 1];
    const next =
      r.rows.length > limit && last
        ? makeCursor(ctx, last.checked_in_at.getTime(), last.checkin_id)
        : null;
    return {
      items: page.map((x) => ({
        alias: x.alias,
        look: x.look,
        tribeId: x.tribe_id,
        avatarId: x.likeness_job_id,
        checkedInAt: x.checked_in_at.toISOString(),
      })),
      next,
    };
  });
}
