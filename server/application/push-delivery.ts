/**
 * Push delivery (Firebase Cloud Messaging, HTTP v1) on top of `push_devices`.
 *
 *   GET /v1/push/prefs, PUT /v1/push/prefs   quiet hours and per-type opt-outs
 *
 * Not configured means off. With no `FCM_PROJECT_ID` and no service account
 * (`FCM_SERVICE_ACCOUNT_JSON` or `FCM_SERVICE_ACCOUNT_PATH`), every send is a logged no-op
 * and nothing else in the API changes. The credentials are never committed: the Firebase
 * project is created by the operator (docs/PUSH.md).
 *
 * A send passes these gates in order, and a gate that stops it says why:
 *   1. configured                                   else `noop_unconfigured`
 *   2. the player has not turned this type off      else `opted_out`
 *   3. not inside the player's quiet hours          else `quiet_hours`
 *   4. at least one enabled FCM device              else `no_device`
 *   5. fewer than DAILY_PUSH_CAP pushes today (UTC) else `rate_limited`
 *   6. this (user, dedupe key) was not sent before  else `duplicate`
 * Only FCM tokens (android and web devices) are reachable; an iOS device holding only an
 * APNs token is skipped. A token FCM reports as UNREGISTERED is disabled in `push_devices`.
 *
 * Every payload carries `type` and `deep_link` in the FCM `data` map, so a tap opens the
 * right screen (e.g. `ctlife://quests`).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { runInTransaction } from '../shared/db/uow.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { createLogger } from '../shared/logger/logger.js';
import type { Config } from '../shared/config/config.js';
import type { AppContext } from './context.js';

export const PUSH_TYPES = [
  'streak_ending',
  'daily_clue',
  'liquidated',
  'home_visit',
  'event_starting',
] as const;
export type PushType = (typeof PUSH_TYPES)[number];

/** Most pushes one player receives per UTC day, across all types. */
export const DAILY_PUSH_CAP = 4;

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** The screen to open on tap, e.g. `ctlife://quests`. */
  readonly deepLink: string;
}

export interface TransportMessage {
  readonly token: string;
  readonly title: string;
  readonly body: string;
  /** FCM data map: string values only. */
  readonly data: Record<string, string>;
}

export type TransportResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly unregistered: boolean;
      readonly retryable: boolean;
      readonly detail: string;
    };

export interface PushTransport {
  send(msg: TransportMessage): Promise<TransportResult>;
}

export type PushOutcome =
  | 'sent'
  | 'noop_unconfigured'
  | 'opted_out'
  | 'quiet_hours'
  | 'no_device'
  | 'rate_limited'
  | 'duplicate'
  | 'failed';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly project_id?: string;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Build the FCM HTTP v1 transport, or null when push is not configured.
 * @param cfg - The push config.
 * @param fetchFn - The fetch to use (injectable for tests).
 * @returns The transport, or null with no credentials or project id.
 */
export function createFcmTransport(
  cfg: Config['push'],
  fetchFn: typeof fetch = fetch,
): PushTransport | null {
  let raw = cfg.fcmServiceAccountJson;
  if (raw === '' && cfg.fcmServiceAccountPath !== '') {
    try {
      raw = readFileSync(cfg.fcmServiceAccountPath, 'utf8');
    } catch {
      createLogger().warn('push: FCM_SERVICE_ACCOUNT_PATH is not readable; push is off');
      return null;
    }
  }
  if (raw === '') return null;
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw) as ServiceAccount;
  } catch {
    createLogger().warn('push: the FCM service account is not valid JSON; push is off');
    return null;
  }
  const projectId = cfg.fcmProjectId !== '' ? cfg.fcmProjectId : (sa.project_id ?? '');
  if (projectId === '' || !sa.client_email || !sa.private_key) return null;

  let cached: { token: string; expiresAt: number } | null = null;
  async function accessToken(): Promise<string> {
    const nowMs = Date.now();
    if (cached && cached.expiresAt - 60_000 > nowMs) return cached.token;
    const iat = Math.floor(nowMs / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: FCM_SCOPE,
        aud: TOKEN_URL,
        iat,
        exp: iat + 3600,
      }),
    );
    const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key);
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${head}.${claims}.${b64url(sig)}`,
      }),
    });
    if (!res.ok) throw new Error(`oauth token request failed: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: j.access_token, expiresAt: nowMs + j.expires_in * 1000 };
    return j.access_token;
  }

  return {
    async send(msg: TransportMessage): Promise<TransportResult> {
      try {
        const res = await fetchFn(
          `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${await accessToken()}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token: msg.token,
                notification: { title: msg.title, body: msg.body },
                data: msg.data,
                android: { priority: 'HIGH' },
              },
            }),
          },
        );
        if (res.ok) return { ok: true };
        const detail = `fcm ${res.status}`;
        if (res.status === 404) return { ok: false, unregistered: true, retryable: false, detail };
        if (res.status === 401) cached = null;
        return {
          ok: false,
          unregistered: false,
          retryable: res.status === 401 || res.status === 429 || res.status >= 500,
          detail,
        };
      } catch (e) {
        return { ok: false, unregistered: false, retryable: true, detail: (e as Error).message };
      }
    },
  };
}

let defaultTransport: PushTransport | null | undefined;

/**
 * The process-wide transport, built once from config.
 * @param ctx - The application context.
 * @returns The transport, or null when push is not configured.
 */
export function getPushTransport(ctx: AppContext): PushTransport | null {
  if (defaultTransport === undefined) defaultTransport = createFcmTransport(ctx.config.push);
  return defaultTransport;
}

/** Test only: forget the cached transport. */
export function _resetPushTransportForTests(): void {
  defaultTransport = undefined;
}

export interface PushPrefs {
  readonly quietEnabled: boolean;
  /** Local hour 0..23 when quiet hours start. */
  readonly quietStartHour: number;
  /** Local hour 0..23 when quiet hours end. */
  readonly quietEndHour: number;
  /** Minutes east of UTC, e.g. 60 for UTC+1. */
  readonly tzOffsetMin: number;
  readonly disabledTypes: PushType[];
}

const DEFAULT_PREFS: PushPrefs = {
  quietEnabled: true,
  quietStartHour: 22,
  quietEndHour: 8,
  tzOffsetMin: 0,
  disabledTypes: [],
};

interface PrefsRow {
  quiet_enabled: boolean;
  quiet_start_hour: number;
  quiet_end_hour: number;
  tz_offset_min: number;
  disabled_types: string[];
}

function rowToPrefs(r: PrefsRow): PushPrefs {
  return {
    quietEnabled: r.quiet_enabled,
    quietStartHour: r.quiet_start_hour,
    quietEndHour: r.quiet_end_hour,
    tzOffsetMin: r.tz_offset_min,
    disabledTypes: r.disabled_types.filter((t): t is PushType =>
      (PUSH_TYPES as readonly string[]).includes(t),
    ),
  };
}

/**
 * A player's push preferences, with the defaults when they never set any.
 * @param ctx - The application context.
 * @param userId - The player.
 * @returns The preferences.
 */
export async function getPushPrefs(ctx: AppContext, userId: string): Promise<PushPrefs> {
  const r = await ctx.db.withConnection((c) =>
    c.query<PrefsRow>(
      `SELECT quiet_enabled, quiet_start_hour, quiet_end_hour, tz_offset_min, disabled_types
         FROM push_prefs WHERE user_id = $1`,
      [userId],
    ),
  );
  return r.rows[0] ? rowToPrefs(r.rows[0]) : DEFAULT_PREFS;
}

export const PushPrefsBody = z.object({
  quietEnabled: z.boolean(),
  quietStartHour: z.number().int().min(0).max(23),
  quietEndHour: z.number().int().min(0).max(23),
  tzOffsetMin: z.number().int().min(-840).max(840),
  disabledTypes: z.array(z.enum(PUSH_TYPES)).max(PUSH_TYPES.length),
});

/**
 * Replace a player's push preferences.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param prefs - The new preferences.
 * @returns The stored preferences.
 */
export async function setPushPrefs(
  ctx: AppContext,
  userId: string,
  prefs: PushPrefs,
): Promise<PushPrefs> {
  const parsed = PushPrefsBody.safeParse(prefs);
  if (!parsed.success) throw new ValidationFailedError({ issues: parsed.error.issues });
  const p = parsed.data;
  await ctx.db.withConnection((c) =>
    c.query(
      `INSERT INTO push_prefs (user_id, quiet_enabled, quiet_start_hour, quiet_end_hour, tz_offset_min, disabled_types, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id) DO UPDATE SET
         quiet_enabled = EXCLUDED.quiet_enabled, quiet_start_hour = EXCLUDED.quiet_start_hour,
         quiet_end_hour = EXCLUDED.quiet_end_hour, tz_offset_min = EXCLUDED.tz_offset_min,
         disabled_types = EXCLUDED.disabled_types, updated_at = now()`,
      [
        userId,
        p.quietEnabled,
        p.quietStartHour,
        p.quietEndHour,
        p.tzOffsetMin,
        [...new Set(p.disabledTypes)],
      ],
    ),
  );
  return getPushPrefs(ctx, userId);
}

/**
 * Whether `now` is inside the player's quiet hours.
 * @param prefs - The player's preferences.
 * @param now - The current time.
 * @returns True when a push should be held back.
 */
export function inQuietHours(prefs: PushPrefs, now: Date): boolean {
  if (!prefs.quietEnabled || prefs.quietStartHour === prefs.quietEndHour) return false;
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const hour = Math.floor(((((utcMin + prefs.tzOffsetMin) % 1440) + 1440) % 1440) / 60);
  const { quietStartHour: s, quietEndHour: e } = prefs;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}

export interface SendOptions {
  /** One push per (user, key): a repeat is `duplicate`. */
  readonly dedupeKey: string;
  readonly now?: Date;
  readonly transport?: PushTransport | null;
}

/**
 * Send one push to a player, through every gate. Never throws: a failure is an outcome.
 * @param ctx - The application context.
 * @param userId - The recipient.
 * @param type - The notification type.
 * @param msg - Title, body and deep link.
 * @param opts - Dedupe key, clock and transport (the last two for tests).
 * @returns Why it was or was not sent.
 */
export async function sendPush(
  ctx: AppContext,
  userId: string,
  type: PushType,
  msg: PushMessage,
  opts: SendOptions,
): Promise<PushOutcome> {
  const log = createLogger().child({ mod: 'push' });
  try {
    const transport = opts.transport === undefined ? getPushTransport(ctx) : opts.transport;
    if (transport === null) {
      log.debug({ type }, 'push not configured; skipped');
      return 'noop_unconfigured';
    }
    const now = opts.now ?? new Date();
    const prefs = await getPushPrefs(ctx, userId);
    if (prefs.disabledTypes.includes(type)) return 'opted_out';
    if (inQuietHours(prefs, now)) return 'quiet_hours';
    const devices = await ctx.db.withConnection((c) =>
      c.query<{ device_id: string; fcm_token: string }>(
        `SELECT device_id, fcm_token FROM push_devices
          WHERE user_id = $1 AND enabled AND fcm_token IS NOT NULL AND platform IN ('android', 'web')`,
        [userId],
      ),
    );
    if (devices.rows.length === 0) return 'no_device';

    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const reserved = await runInTransaction(async (client) => {
      const used = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM push_log
          WHERE user_id = $1 AND created_at >= $2 AND status <> 'failed'`,
        [userId, dayStart],
      );
      if (Number(used.rows[0]?.n ?? '0') >= DAILY_PUSH_CAP) return 'rate_limited' as const;
      const ins = await client.query(
        `INSERT INTO push_log (user_id, type, dedupe_key, status, created_at)
         VALUES ($1, $2, $3, 'pending', $4) ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
        [userId, type, opts.dedupeKey, now],
      );
      return ins.rows.length === 0 ? ('duplicate' as const) : ('ok' as const);
    });
    if (reserved !== 'ok') return reserved;

    let delivered = false;
    let retryable = false;
    for (const d of devices.rows) {
      const res = await transport.send({
        token: d.fcm_token,
        title: msg.title,
        body: msg.body,
        data: { type, deep_link: msg.deepLink },
      });
      if (res.ok) {
        delivered = true;
      } else {
        if (res.unregistered) {
          await ctx.db.withConnection((c) =>
            c.query(
              `UPDATE push_devices SET enabled = false, updated_at = now() WHERE device_id = $1`,
              [d.device_id],
            ),
          );
        }
        retryable = retryable || res.retryable;
        log.warn({ type, detail: res.detail }, 'push send failed');
      }
    }
    if (delivered) {
      await ctx.db.withConnection((c) =>
        c.query(`UPDATE push_log SET status = 'sent' WHERE user_id = $1 AND dedupe_key = $2`, [
          userId,
          opts.dedupeKey,
        ]),
      );
      return 'sent';
    }
    // A transient failure frees the key so the next sweep tries again; a dead token does not.
    await ctx.db.withConnection((c) =>
      retryable
        ? c.query(`DELETE FROM push_log WHERE user_id = $1 AND dedupe_key = $2`, [
            userId,
            opts.dedupeKey,
          ])
        : c.query(`UPDATE push_log SET status = 'failed' WHERE user_id = $1 AND dedupe_key = $2`, [
            userId,
            opts.dedupeKey,
          ]),
    );
    return 'failed';
  } catch (e) {
    log.error({ type, err: (e as Error).message }, 'push send errored');
    return 'failed';
  }
}

/**
 * Tell a player their perp was liquidated.
 * @param ctx - The application context.
 * @param userId - The player.
 * @param perpId - The liquidated perp.
 * @param lossCents - What they lost.
 * @param opts - Clock and transport (for tests).
 */
export async function notifyLiquidated(
  ctx: AppContext,
  userId: string,
  perpId: string,
  lossCents: bigint,
  opts: Pick<SendOptions, 'now' | 'transport'> = {},
): Promise<PushOutcome> {
  const dollars = (Number(lossCents) / 100).toFixed(2);
  return sendPush(
    ctx,
    userId,
    'liquidated',
    {
      title: 'Position liquidated',
      body: `Your perp got rekt. You lost $${dollars}.`,
      deepLink: 'ctlife://perps',
    },
    { dedupeKey: `liquidated:${perpId}`, ...opts },
  );
}

/**
 * Tell a home owner someone dropped by. At most one per home per UTC day.
 * @param ctx - The application context.
 * @param ownerUserId - The home's owner.
 * @param homeId - The home.
 * @param opts - Clock and transport (for tests).
 */
export async function notifyHomeVisit(
  ctx: AppContext,
  ownerUserId: string,
  homeId: string,
  opts: Pick<SendOptions, 'now' | 'transport'> = {},
): Promise<PushOutcome> {
  const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
  return sendPush(
    ctx,
    ownerUserId,
    'home_visit',
    {
      title: 'Someone visited your home',
      body: 'A neighbour dropped by your place.',
      deepLink: 'ctlife://home',
    },
    { dedupeKey: `home_visit:${homeId}:${day}`, ...opts },
  );
}

const PAGE = 500;
const MAX_PAGES = 20;

/**
 * Run `send` for each player with an enabled FCM device that `where` selects, a page at a
 * time. Quiet or capped players simply produce no row, so a later sweep reaches them again.
 */
async function forEachRecipient(
  ctx: AppContext,
  selectSql: string,
  params: unknown[],
  send: (userId: string, extra: Record<string, unknown>) => Promise<unknown>,
): Promise<number> {
  let after = '00000000-0000-0000-0000-000000000000';
  let sent = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await ctx.db.withConnection((c) =>
      c.query<{ user_id: string } & Record<string, unknown>>(selectSql, [...params, after, PAGE]),
    );
    if (rows.rows.length === 0) break;
    for (const r of rows.rows) {
      const out = await send(r.user_id, r);
      if (out === 'sent') sent += 1;
    }
    after = rows.rows[rows.rows.length - 1]!.user_id;
    if (rows.rows.length < PAGE) break;
  }
  return sent;
}

/** Hours before the UTC reset when the "streak ending" push starts. */
export const STREAK_ENDING_LEAD_HOURS = 3;

/**
 * Push "your streak is ending" to players whose streak dies at the next UTC reset: they
 * claimed yesterday, have not claimed today, and it is under 3 hours to midnight. A player
 * in quiet hours is retried by the next sweep until midnight.
 * @param ctx - The application context.
 * @param now - The current time (injectable for tests).
 * @param transport - The transport (for tests).
 * @returns How many pushes were sent.
 */
export async function sweepStreakEnding(
  ctx: AppContext,
  now: Date = new Date(),
  transport?: PushTransport | null,
): Promise<number> {
  const tx = transport === undefined ? getPushTransport(ctx) : transport;
  if (tx === null) return 0;
  const today = now.toISOString().slice(0, 10);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  if (midnight - now.getTime() > STREAK_ENDING_LEAD_HOURS * 3_600_000) return 0;
  return forEachRecipient(
    ctx,
    `SELECT s.user_id, s.streak_day FROM login_streaks s
      WHERE s.streak_day > 0 AND s.last_claim_date = ($1::date - 1)
        AND NOT EXISTS (SELECT 1 FROM daily_claims d WHERE d.user_id = s.user_id AND d.day_date = $1::date)
        AND EXISTS (SELECT 1 FROM push_devices p WHERE p.user_id = s.user_id AND p.enabled AND p.fcm_token IS NOT NULL)
        AND s.user_id > $2::uuid
      ORDER BY s.user_id LIMIT $3`,
    [today],
    (userId, row) =>
      sendPush(
        ctx,
        userId,
        'streak_ending',
        {
          title: 'Your gm streak is ending',
          body: `Claim today's chest before midnight UTC to keep your Day ${String(row.streak_day)} streak.`,
          deepLink: 'ctlife://quests',
        },
        { dedupeKey: `streak_ending:${today}`, now, transport: tx },
      ),
  );
}

/**
 * Push "the daily clue is up" to players with a device who have not answered today's clue.
 * @param ctx - The application context.
 * @param now - The current time (injectable for tests).
 * @param transport - The transport (for tests).
 * @returns How many pushes were sent.
 */
export async function sweepDailyClue(
  ctx: AppContext,
  now: Date = new Date(),
  transport?: PushTransport | null,
): Promise<number> {
  const tx = transport === undefined ? getPushTransport(ctx) : transport;
  if (tx === null) return 0;
  const today = now.toISOString().slice(0, 10);
  return forEachRecipient(
    ctx,
    `SELECT u.user_id FROM (SELECT DISTINCT user_id FROM push_devices
                            WHERE enabled AND fcm_token IS NOT NULL) u
      WHERE NOT EXISTS (SELECT 1 FROM push_log l WHERE l.user_id = u.user_id AND l.dedupe_key = $1)
        AND NOT EXISTS (SELECT 1 FROM daily_clue_attempts a JOIN daily_clue c ON c.clue_id = a.clue_id
                         WHERE a.user_id = u.user_id AND c.date = $2::date)
        AND u.user_id > $3::uuid
      ORDER BY u.user_id LIMIT $4`,
    [`daily_clue:${today}`, today],
    (userId) =>
      sendPush(
        ctx,
        userId,
        'daily_clue',
        {
          title: 'The daily clue is up',
          body: "Today's clue is live. One guess, real Cash.",
          deepLink: 'ctlife://daily-clue',
        },
        { dedupeKey: `daily_clue:${today}`, now, transport: tx },
      ),
  );
}

export interface EventStart {
  readonly eventId: string;
  readonly title: string;
}

/**
 * Push "an event is starting" to every player with a device. A stub for the event calendar
 * (R2): nothing calls it yet. Quiet hours and the daily cap apply as for any push.
 * @param ctx - The application context.
 * @param event - The event.
 * @param now - The current time (injectable for tests).
 * @param transport - The transport (for tests).
 * @returns How many pushes were sent.
 */
export async function notifyEventStarting(
  ctx: AppContext,
  event: EventStart,
  now: Date = new Date(),
  transport?: PushTransport | null,
): Promise<number> {
  const tx = transport === undefined ? getPushTransport(ctx) : transport;
  if (tx === null) return 0;
  return forEachRecipient(
    ctx,
    `SELECT u.user_id FROM (SELECT DISTINCT user_id FROM push_devices
                            WHERE enabled AND fcm_token IS NOT NULL) u
      WHERE NOT EXISTS (SELECT 1 FROM push_log l WHERE l.user_id = u.user_id AND l.dedupe_key = $1)
        AND u.user_id > $2::uuid
      ORDER BY u.user_id LIMIT $3`,
    [`event_starting:${event.eventId}`],
    (userId) =>
      sendPush(
        ctx,
        userId,
        'event_starting',
        {
          title: 'Event starting',
          body: `${event.title} is starting now.`,
          deepLink: 'ctlife://events',
        },
        { dedupeKey: `event_starting:${event.eventId}`, now, transport: tx },
      ),
  );
}
