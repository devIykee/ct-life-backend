/**
 * Push delivery tests: the no-op without config, the gates (opt-out, quiet hours, device,
 * 4 per day, de-duplication), the streak-ending and daily-clue sweeps, the event pushes,
 * and the FCM HTTP v1 transport against a mocked fetch. FCM itself is never called.
 */
import { generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import {
  _resetPushTransportForTests,
  createFcmTransport,
  DAILY_PUSH_CAP,
  getPushPrefs,
  inQuietHours,
  notifyEventStarting,
  notifyHomeVisit,
  notifyLiquidated,
  sendPush,
  setPushPrefs,
  sweepDailyClue,
  sweepStreakEnding,
  type PushMessage,
  type PushPrefs,
  type PushTransport,
  type TransportMessage,
} from './push-delivery.js';
import { runPushSweep } from '../workers/push.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();

const MSG: PushMessage = { title: 'T', body: 'B', deepLink: 'ctlife://quests' };
let seq = 0;
/** A distinct UTC day per call, in 2091, so tests never see each other's push_log rows. */
const noon = (): Date => new Date(Date.UTC(2091, 0, 1 + seq++, 12, 0, 0));

function fakeTransport(result: Awaited<ReturnType<PushTransport['send']>> = { ok: true }) {
  const send = vi.fn(async (_m: TransportMessage) => result);
  return { transport: { send } as PushTransport, send };
}

async function newUser(
  token: string | null = `tok-${uuidv7()}`,
): Promise<{ id: string; token: string | null }> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `push-${id}`]);
  if (token) {
    await pool.query(
      `INSERT INTO push_devices (device_id, user_id, platform, fcm_token) VALUES ($1, $2, 'android', $3)`,
      [uuidv7(), id, token],
    );
  }
  return { id, token };
}

const PREFS: PushPrefs = {
  quietEnabled: true,
  quietStartHour: 22,
  quietEndHour: 8,
  tzOffsetMin: 0,
  disabledTypes: [],
};

beforeEach(() => _resetPushTransportForTests());
afterAll(async () => {
  await pool.end();
});

describe('push is off until configured', () => {
  it('is a logged no-op with no FCM config: nothing is sent, nothing is stored', async () => {
    expect(ctx.config.push.fcmProjectId).toBe('');
    const u = await newUser();
    const out = await sendPush(ctx, u.id, 'streak_ending', MSG, { dedupeKey: 'k', now: noon() });
    expect(out).toBe('noop_unconfigured');
    const n = await pool.query(`SELECT count(*) AS n FROM push_log WHERE user_id = $1`, [u.id]);
    expect(Number(n.rows[0].n)).toBe(0);
    expect(await sweepStreakEnding(ctx, noon())).toBe(0);
    expect(await sweepDailyClue(ctx, noon())).toBe(0);
    expect(await runPushSweep(ctx, noon())).toEqual({ streakEnding: 0, dailyClue: 0 });
    expect(await notifyEventStarting(ctx, { eventId: 'e', title: 'E' }, noon())).toBe(0);
  });

  it('createFcmTransport is null without a service account, project id or with bad JSON', () => {
    const empty = { fcmProjectId: '', fcmServiceAccountJson: '', fcmServiceAccountPath: '' };
    expect(createFcmTransport(empty)).toBeNull();
    expect(createFcmTransport({ ...empty, fcmProjectId: 'p' })).toBeNull();
    expect(createFcmTransport({ ...empty, fcmServiceAccountJson: '{not json' })).toBeNull();
    expect(createFcmTransport({ ...empty, fcmServiceAccountPath: '/nonexistent.json' })).toBeNull();
    expect(
      createFcmTransport({
        ...empty,
        fcmServiceAccountJson: '{"client_email":"a","private_key":"k"}',
      }),
    ).toBeNull(); // no project id anywhere
  });
});

describe('gates', () => {
  it("sends to the player's FCM device with type and deep_link in the data map", async () => {
    const u = await newUser();
    const { transport, send } = fakeTransport();
    const out = await sendPush(ctx, u.id, 'streak_ending', MSG, {
      dedupeKey: 'a',
      now: noon(),
      transport,
    });
    expect(out).toBe('sent');
    expect(send).toHaveBeenCalledWith({
      token: u.token,
      title: 'T',
      body: 'B',
      data: { type: 'streak_ending', deep_link: 'ctlife://quests' },
    });
    const row = await pool.query(`SELECT status FROM push_log WHERE user_id = $1`, [u.id]);
    expect(row.rows).toEqual([{ status: 'sent' }]);
  });

  it('skips a player with no enabled device, and an iOS-only device', async () => {
    const none = await newUser(null);
    const ios = await newUser(null);
    await pool.query(
      `INSERT INTO push_devices (device_id, user_id, platform, apns_token) VALUES ($1, $2, 'ios', 'apns-1')`,
      [uuidv7(), ios.id],
    );
    const off = await newUser();
    await pool.query(`UPDATE push_devices SET enabled = false WHERE user_id = $1`, [off.id]);
    const { transport, send } = fakeTransport();
    for (const u of [none, ios, off]) {
      expect(
        await sendPush(ctx, u.id, 'daily_clue', MSG, { dedupeKey: 'a', now: noon(), transport }),
      ).toBe('no_device');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('honours a per-type opt-out and nothing else', async () => {
    const u = await newUser();
    const now = noon();
    await setPushPrefs(ctx, u.id, { ...PREFS, disabledTypes: ['home_visit'] });
    const { transport, send } = fakeTransport();
    expect(await sendPush(ctx, u.id, 'home_visit', MSG, { dedupeKey: 'a', now, transport })).toBe(
      'opted_out',
    );
    expect(await sendPush(ctx, u.id, 'liquidated', MSG, { dedupeKey: 'b', now, transport })).toBe(
      'sent',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("holds back pushes in quiet hours, in the player's local time, and frees them after", async () => {
    const u = await newUser();
    const day = noon();
    const at = (h: number, m = 0): Date =>
      new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
    const { transport, send } = fakeTransport();
    // Default quiet hours are 22:00 to 08:00 on UTC.
    expect(
      await sendPush(ctx, u.id, 'daily_clue', MSG, { dedupeKey: 'q', now: at(23), transport }),
    ).toBe('quiet_hours');
    expect(
      await sendPush(ctx, u.id, 'daily_clue', MSG, { dedupeKey: 'q', now: at(7, 59), transport }),
    ).toBe('quiet_hours');
    expect(send).not.toHaveBeenCalled();
    // A held push leaves no row, so the same key goes out once the quiet window ends.
    expect(
      await sendPush(ctx, u.id, 'daily_clue', MSG, { dedupeKey: 'q', now: at(8), transport }),
    ).toBe('sent');
    // UTC+2: 21:00 UTC is 23:00 local, quiet; UTC-5: 21:00 UTC is 16:00 local, fine.
    await setPushPrefs(ctx, u.id, { ...PREFS, tzOffsetMin: 120 });
    expect(
      await sendPush(ctx, u.id, 'liquidated', MSG, { dedupeKey: 'z1', now: at(21), transport }),
    ).toBe('quiet_hours');
    await setPushPrefs(ctx, u.id, { ...PREFS, tzOffsetMin: -300 });
    expect(
      await sendPush(ctx, u.id, 'liquidated', MSG, { dedupeKey: 'z2', now: at(21), transport }),
    ).toBe('sent');
    // Quiet hours off.
    await setPushPrefs(ctx, u.id, { ...PREFS, quietEnabled: false });
    expect(
      await sendPush(ctx, u.id, 'home_visit', MSG, { dedupeKey: 'z3', now: at(3), transport }),
    ).toBe('sent');
  });

  it('inQuietHours handles same-day windows, wrap-around and equal hours', () => {
    const t = (h: number): Date => new Date(Date.UTC(2091, 5, 1, h));
    const base = { ...PREFS, quietStartHour: 13, quietEndHour: 15 };
    expect(inQuietHours(base, t(13))).toBe(true);
    expect(inQuietHours(base, t(15))).toBe(false);
    expect(inQuietHours({ ...PREFS, quietStartHour: 5, quietEndHour: 5 }, t(5))).toBe(false);
    expect(inQuietHours({ ...PREFS, tzOffsetMin: -840 }, t(23))).toBe(false); // 09:00 local
  });

  it(`stops at ${DAILY_PUSH_CAP} pushes per UTC day and starts again the next day`, async () => {
    const u = await newUser();
    const now = noon();
    const { transport, send } = fakeTransport();
    const outs: string[] = [];
    for (let i = 0; i < DAILY_PUSH_CAP + 2; i++) {
      outs.push(
        await sendPush(ctx, u.id, 'liquidated', MSG, { dedupeKey: `cap-${i}`, now, transport }),
      );
    }
    expect(outs).toEqual([...Array(DAILY_PUSH_CAP).fill('sent'), 'rate_limited', 'rate_limited']);
    expect(send).toHaveBeenCalledTimes(DAILY_PUSH_CAP);
    const next = new Date(now.getTime() + 24 * 3_600_000);
    expect(
      await sendPush(ctx, u.id, 'liquidated', MSG, { dedupeKey: 'cap-next', now: next, transport }),
    ).toBe('sent');
  });

  it('sends one push per dedupe key', async () => {
    const u = await newUser();
    const now = noon();
    const { transport, send } = fakeTransport();
    expect(
      await sendPush(ctx, u.id, 'liquidated', MSG, { dedupeKey: 'same', now, transport }),
    ).toBe('sent');
    expect(
      await sendPush(ctx, u.id, 'liquidated', MSG, { dedupeKey: 'same', now, transport }),
    ).toBe('duplicate');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('disables a token FCM reports as unregistered, and a transient failure can be retried', async () => {
    const u = await newUser();
    const now = noon();
    const dead = fakeTransport({
      ok: false,
      unregistered: true,
      retryable: false,
      detail: 'fcm 404',
    });
    expect(
      await sendPush(ctx, u.id, 'liquidated', MSG, {
        dedupeKey: 'd',
        now,
        transport: dead.transport,
      }),
    ).toBe('failed');
    const dev = await pool.query(`SELECT enabled FROM push_devices WHERE user_id = $1`, [u.id]);
    expect(dev.rows).toEqual([{ enabled: false }]);
    const log = await pool.query(`SELECT status FROM push_log WHERE user_id = $1`, [u.id]);
    expect(log.rows).toEqual([{ status: 'failed' }]);

    const v = await newUser();
    const flaky = fakeTransport({
      ok: false,
      unregistered: false,
      retryable: true,
      detail: 'fcm 503',
    });
    expect(
      await sendPush(ctx, v.id, 'liquidated', MSG, {
        dedupeKey: 'r',
        now,
        transport: flaky.transport,
      }),
    ).toBe('failed');
    const ok = fakeTransport();
    expect(
      await sendPush(ctx, v.id, 'liquidated', MSG, {
        dedupeKey: 'r',
        now,
        transport: ok.transport,
      }),
    ).toBe('sent');
  });
});

describe('preferences', () => {
  it('default, round trip, and validation', async () => {
    const u = await newUser(null);
    expect(await getPushPrefs(ctx, u.id)).toEqual(PREFS);
    const saved = await setPushPrefs(ctx, u.id, {
      quietEnabled: true,
      quietStartHour: 23,
      quietEndHour: 7,
      tzOffsetMin: 60,
      disabledTypes: ['daily_clue', 'daily_clue'],
    });
    expect(saved).toMatchObject({
      quietStartHour: 23,
      quietEndHour: 7,
      tzOffsetMin: 60,
      disabledTypes: ['daily_clue'],
    });
    await expect(setPushPrefs(ctx, u.id, { ...PREFS, quietStartHour: 24 })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(
      setPushPrefs(ctx, u.id, { ...PREFS, disabledTypes: ['nope' as never] }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('notifications', () => {
  it('streak ending: only inside the last 3 hours, only for an unclaimed live streak, once a day', async () => {
    const now = noon();
    const day = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    const at = (h: number, m = 0): Date =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
    const live = await newUser();
    const claimedToday = await newUser();
    const broken = await newUser();
    await pool.query(
      `INSERT INTO login_streaks (user_id, streak_day, best_streak, last_claim_date) VALUES
         ($1, 4, 4, $4), ($2, 9, 9, $5), ($3, 5, 5, $6)`,
      [live.id, claimedToday.id, broken.id, yesterday, day, '2000-01-01'],
    );
    await pool.query(
      `INSERT INTO daily_claims (user_id, day_date, streak_day, cash_cents) VALUES ($1, $2, 9, 1000)`,
      [claimedToday.id, day],
    );
    const { transport, send } = fakeTransport();
    const mine = (): TransportMessage[] =>
      send.mock.calls
        .map((c) => c[0])
        .filter(
          (m) =>
            m.token === live.token || m.token === claimedToday.token || m.token === broken.token,
        );
    // Four hours out: too early.
    expect(await sweepStreakEnding(ctx, at(20, 0), transport)).toBe(0);
    expect(mine()).toHaveLength(0);
    // 21:30 UTC is before the default quiet hours (22:00), so it goes.
    await sweepStreakEnding(ctx, at(21, 30), transport);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]).toMatchObject({
      token: live.token,
      title: 'Your gm streak is ending',
      data: { type: 'streak_ending', deep_link: 'ctlife://quests' },
    });
    expect(mine()[0]!.body).toContain('Day 4');
    // The next sweep does not repeat it.
    await sweepStreakEnding(ctx, at(21, 35), transport);
    expect(mine()).toHaveLength(1);
  });

  it('streak ending waits out quiet hours and goes out when they end before the reset', async () => {
    const now = noon();
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    const at = (h: number, m = 0): Date =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
    const u = await newUser();
    await pool.query(
      `INSERT INTO login_streaks (user_id, streak_day, best_streak, last_claim_date) VALUES ($1, 3, 3, $2)`,
      [u.id, yesterday],
    );
    // UTC+4: 21:30 UTC is 01:30 local, quiet. After the player moves to UTC-3 (18:40 local) it goes.
    await setPushPrefs(ctx, u.id, { ...PREFS, tzOffsetMin: 240 });
    const { transport, send } = fakeTransport();
    const sent = (): number => send.mock.calls.filter((c) => c[0].token === u.token).length;
    await sweepStreakEnding(ctx, at(21, 30), transport);
    expect(sent()).toBe(0);
    await setPushPrefs(ctx, u.id, { ...PREFS, tzOffsetMin: -180 });
    await sweepStreakEnding(ctx, at(21, 40), transport);
    expect(sent()).toBe(1);
  });

  it('daily clue: once per UTC day, not for someone who already answered', async () => {
    const now = noon();
    const day = now.toISOString().slice(0, 10);
    const fresh = await newUser();
    const answered = await newUser();
    const clueId = uuidv7();
    await pool.query(
      `INSERT INTO daily_clue (clue_id, date, clue_text, answer_hash, prize_cents, expires_at) VALUES ($1, $2, 'q', $4, 100, $3)`,
      [clueId, day, new Date(`${day}T23:59:59Z`), 'a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO daily_clue_attempts (attempt_id, user_id, clue_id, attempt_text, correct) VALUES ($1, $2, $3, 'x', false)`,
      [uuidv7(), answered.id, clueId],
    );
    const { transport, send } = fakeTransport();
    const to = (t: string | null): TransportMessage[] =>
      send.mock.calls.map((c) => c[0]).filter((m) => m.token === t);
    await sweepDailyClue(ctx, now, transport);
    await sweepDailyClue(ctx, now, transport);
    expect(to(fresh.token)).toHaveLength(1);
    expect(to(fresh.token)[0]).toMatchObject({
      title: 'The daily clue is up',
      data: { type: 'daily_clue', deep_link: 'ctlife://daily-clue' },
    });
    expect(to(answered.token)).toHaveLength(0);
    await pool.query(`DELETE FROM daily_clue_attempts WHERE clue_id = $1`, [clueId]);
    await pool.query(`DELETE FROM daily_clue WHERE clue_id = $1`, [clueId]);
  });

  it('liquidated, home visit and event starting carry their deep links', async () => {
    const now = noon();
    const a = await newUser();
    const { transport, send } = fakeTransport();
    expect(await notifyLiquidated(ctx, a.id, uuidv7(), 12_345n, { now, transport })).toBe('sent');
    expect(send.mock.calls[0]![0]).toMatchObject({
      title: 'Position liquidated',
      data: { type: 'liquidated', deep_link: 'ctlife://perps' },
    });
    expect(send.mock.calls[0]![0].body).toContain('$123.45');
    expect(await notifyHomeVisit(ctx, a.id, 'home:1', { now, transport })).toBe('sent');
    expect(await notifyHomeVisit(ctx, a.id, 'home:1', { now, transport })).toBe('duplicate'); // once per home per day
    expect(send.mock.calls[1]![0].data).toEqual({ type: 'home_visit', deep_link: 'ctlife://home' });
    const n = await notifyEventStarting(
      ctx,
      { eventId: `ev-${uuidv7()}`, title: 'Breakpoint' },
      now,
      transport,
    );
    expect(n).toBeGreaterThanOrEqual(1);
    const ev = send.mock.calls
      .map((c) => c[0])
      .find((m) => m.token === a.token && m.data.type === 'event_starting');
    expect(ev?.body).toBe('Breakpoint is starting now.');
  });
});

describe('FCM HTTP v1 transport', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const cfg = {
    fcmProjectId: 'ct-life-test',
    fcmServiceAccountJson: JSON.stringify({
      client_email: 'svc@ct-life-test.iam.gserviceaccount.com',
      private_key: privateKey,
    }),
    fcmServiceAccountPath: '',
  };
  const msg: TransportMessage = {
    token: 'device-token',
    title: 'T',
    body: 'B',
    data: { type: 'x', deep_link: 'ctlife://quests' },
  };

  it('signs a service-account JWT, caches the access token, and posts the message', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ name: 'projects/ct-life-test/messages/1' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const t = createFcmTransport(cfg, fetchFn)!;
    expect(await t.send(msg)).toEqual({ ok: true });
    expect(await t.send(msg)).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://fcm.googleapis.com/v1/projects/ct-life-test/messages:send',
      'https://fcm.googleapis.com/v1/projects/ct-life-test/messages:send',
    ]);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c] = form.get('assertion')!.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({
      iss: 'svc@ct-life-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer at-1');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      message: {
        token: 'device-token',
        notification: { title: 'T', body: 'B' },
        data: { type: 'x', deep_link: 'ctlife://quests' },
        android: { priority: 'HIGH' },
      },
    });
  });

  it('maps FCM errors: 404 is an unregistered token, 5xx and network errors are retryable, 400 is not', async () => {
    const status = { code: 404 };
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth2')
        ? new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
        : new Response('{}', { status: status.code }),
    ) as unknown as typeof fetch;
    const t = createFcmTransport(cfg, fetchFn)!;
    expect(await t.send(msg)).toMatchObject({ ok: false, unregistered: true, retryable: false });
    status.code = 503;
    expect(await t.send(msg)).toMatchObject({ ok: false, unregistered: false, retryable: true });
    status.code = 400;
    expect(await t.send(msg)).toMatchObject({ ok: false, unregistered: false, retryable: false });
    const down = createFcmTransport(
      cfg,
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    )!;
    expect(await down.send(msg)).toMatchObject({ ok: false, retryable: true });
  });
});
