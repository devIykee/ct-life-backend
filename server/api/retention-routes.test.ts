/**
 * Streak, quests and push prefs over HTTP: auth on every route, idempotent claims, no
 * client-supplied rewards or progress, the error codes, and the prefs validation.
 *
 * The clock-controlled cases (day 1 to 2, resets, freezes) are in
 * server/application/daily-streak.test.ts; these use the real clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';

const FAKE_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH4+zq3wXKb5xY9jQ8j6P4mY8Z3b1z9S6n2Y1z9R6n2
-----END PRIVATE KEY-----`;
const FAKE_SPKI = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR8mD8eJX4v9O0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l8=
-----END PUBLIC KEY-----`;

loadDotenv({ path: process.cwd() + '/.env' });

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;
const db = createDb();

beforeAll(async () => {
  process.env.APP_ENV = process.env.APP_ENV ?? 'local';
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgres://ctlife:ctlife@localhost:5434/ctlife';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6381';
  process.env.JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY ?? FAKE_PKCS8;
  process.env.JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY ?? FAKE_SPKI;
  process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? 'fake-helius-key';
  process.env.HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? 'fake-helius-secret';
  process.env.HELIUS_RPC_URL_DEVNET =
    process.env.HELIUS_RPC_URL_DEVNET ?? 'https://api.devnet.solana.com';
  process.env.HELIUS_RPC_URL_MAINNET =
    process.env.HELIUS_RPC_URL_MAINNET ?? 'https://api.mainnet-beta.solana.com';
  process.env.TREASURY_PUBKEY_DEVNET =
    process.env.TREASURY_PUBKEY_DEVNET ?? '11111111111111111111111111111111';
  process.env.SETTLE_AUTHORITY_KEYPAIR_DEVNET =
    process.env.SETTLE_AUTHORITY_KEYPAIR_DEVNET ?? '11111111111111111111111111111111';
  process.env.ADMIN_KEYPAIR_DEVNET =
    process.env.ADMIN_KEYPAIR_DEVNET ?? '11111111111111111111111111111111';
  process.env.LIVEKIT_URL = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
  process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
  process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret_please_change';
  process.env.LIVEKIT_WEBHOOK_SECRET = process.env.LIVEKIT_WEBHOOK_SECRET ?? 'fake-livekit-secret';
  process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? 'minioadmin';
  process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? 'minioadmin';
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  const handle = await buildServer();
  app = handle.app;
  // Prepare Fastify without binding a real port.
  await app.ready();
  stop = handle.stop;
}, 30_000);

afterAll(async () => {
  await stop();
}, 30_000);

interface AuthedUser {
  sub: string;
  accessToken: string;
}

async function devAuth(): Promise<AuthedUser> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `home-doors-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json() as { id: string; accessToken: string };
  return { sub: body.id, accessToken: body.accessToken };
}

async function call(
  u: AuthedUser,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  key?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.accessToken}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': key ?? uuidv7() }),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: r.statusCode, body: r.json() };
}

const errCode = (b: Record<string, unknown>): string => (b.error as { code: string }).code;

async function cashOf(userId: string): Promise<number> {
  return db.withConnection(async (c) => {
    const r = await c.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [userId],
    );
    return Number(r.rows[0]?.cash_cents ?? 0);
  });
}

describe('retention routes: auth', () => {
  it('every route needs a bearer token', async () => {
    const routes: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string]> = [
      ['GET', '/v1/daily/status'],
      ['POST', '/v1/daily/claim'],
      ['POST', '/v1/daily/freeze'],
      ['GET', '/v1/quests'],
      ['POST', '/v1/quests/q_daily_shift_1/claim'],
      ['GET', '/v1/push/prefs'],
      ['PUT', '/v1/push/prefs'],
      ['DELETE', '/v1/push/register'],
    ];
    for (const [method, url] of routes) {
      const r = await app.inject({ method, url, headers: { 'idempotency-key': uuidv7() } });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('daily streak over HTTP', () => {
  it('status, claim, replay and a second claim pay once; the client cannot name a reward', async () => {
    const u = await devAuth();
    const s0 = await call(u, 'GET', '/v1/daily/status');
    expect(s0.status).toBe(200);
    expect(s0.body).toMatchObject({ streakDay: 0, claimedToday: false, freezes: 0, maxFreezes: 2 });
    expect((s0.body.chest as { day: number }).day).toBe(1);

    const key = uuidv7();
    const c1 = await call(u, 'POST', '/v1/daily/claim', { cashCents: 999_999_999, day: 30 }, key);
    expect(c1.status).toBe(200);
    expect(c1.body).toMatchObject({ alreadyClaimed: false, streakDay: 1, claimedToday: true });
    const paid = (c1.body.claimed as { rewards: { cashCents: number } }).rewards.cashCents;
    expect(paid).toBe(1000);
    expect(await cashOf(u.sub)).toBe(paid);

    const replay = await call(
      u,
      'POST',
      '/v1/daily/claim',
      { cashCents: 999_999_999, day: 30 },
      key,
    );
    expect(replay.body).toEqual(c1.body);
    const again = await call(u, 'POST', '/v1/daily/claim', undefined, uuidv7());
    expect(again.status).toBe(200);
    expect(again.body.alreadyClaimed).toBe(true);
    expect(await cashOf(u.sub)).toBe(paid);

    const ledger = await call(u, 'GET', '/v1/ledger');
    expect((ledger.body.items as Array<{ kind: string }>).map((i) => i.kind)).toEqual([
      'daily_streak',
    ]);
  });

  it('freeze: 402 without Cash, 201 with it, 409 past two', async () => {
    const u = await devAuth();
    const poor = await call(u, 'POST', '/v1/daily/freeze', undefined);
    expect(poor.status).toBe(402);
    expect(errCode(poor.body)).toBe('INSUFFICIENT_CASH');
    await db.withConnection((c) =>
      c.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = 100000`,
        [u.sub],
      ),
    );
    const a = await call(u, 'POST', '/v1/daily/freeze', undefined);
    expect(a.status).toBe(201);
    expect(a.body.freezes).toBe(1);
    expect((await call(u, 'POST', '/v1/daily/freeze', undefined)).body.freezes).toBe(2);
    const third = await call(u, 'POST', '/v1/daily/freeze', undefined);
    expect(third.status).toBe(409);
    expect(errCode(third.body)).toBe('FREEZE_LIMIT_REACHED');
    expect(await cashOf(u.sub)).toBe(100000 - 2 * 5000);
  });
});

describe('quests over HTTP', () => {
  it('lists 3 daily and 5 weekly; an unfinished, unknown or foreign claim is refused; progress is server-only', async () => {
    const u = await devAuth();
    const l = await call(u, 'GET', '/v1/quests');
    expect(l.status).toBe(200);
    const daily = l.body.daily as { quests: Array<{ id: string; progress: number }> };
    const weekly = l.body.weekly as { quests: Array<{ id: string; step: number }> };
    expect(daily.quests).toHaveLength(3);
    expect(weekly.quests).toHaveLength(5);

    const q = daily.quests[0]!;
    // Claiming with a body that "reports" progress or a reward changes nothing.
    const early = await call(u, 'POST', `/v1/quests/${q.id}/claim`, {
      progress: 99,
      cashCents: 1_000_000,
    });
    expect(early.status).toBe(409);
    expect(errCode(early.body)).toBe('QUEST_NOT_COMPLETE');
    expect(await cashOf(u.sub)).toBe(0);

    const unknown = await call(u, 'POST', '/v1/quests/q_nope/claim');
    expect(unknown.status).toBe(404);

    // Someone else's quest id is a 404, not a "not complete".
    const other = await devAuth();
    const theirs = (
      (await call(other, 'GET', '/v1/quests')).body.daily as { quests: Array<{ id: string }> }
    ).quests.map((x) => x.id);
    const foreign = daily.quests.find((x) => !theirs.includes(x.id));
    if (foreign) {
      const r = await call(other, 'POST', `/v1/quests/${foreign.id}/claim`);
      expect(r.status).toBe(404);
    }
    expect(JSON.stringify(l.body)).not.toContain('"progress":99');
  });
});

describe('push prefs over HTTP', () => {
  it('defaults, round trip, validation', async () => {
    const u = await devAuth();
    const d = await call(u, 'GET', '/v1/push/prefs');
    expect(d.body).toMatchObject({
      quietEnabled: true,
      quietStartHour: 22,
      quietEndHour: 8,
      tzOffsetMin: 0,
      disabledTypes: [],
    });
    const put = await call(u, 'PUT', '/v1/push/prefs', {
      quietEnabled: true,
      quietStartHour: 23,
      quietEndHour: 7,
      tzOffsetMin: 60,
      disabledTypes: ['daily_clue'],
    });
    expect(put.status).toBe(200);
    expect((await call(u, 'GET', '/v1/push/prefs')).body).toMatchObject({
      tzOffsetMin: 60,
      disabledTypes: ['daily_clue'],
    });
    const bad = await call(u, 'PUT', '/v1/push/prefs', {
      quietEnabled: true,
      quietStartHour: 30,
      quietEndHour: 7,
      tzOffsetMin: 0,
      disabledTypes: [],
    });
    expect(bad.status).toBe(400);
    expect(errCode(bad.body)).toBe('VALIDATION_FAILED');
    const badType = await call(u, 'PUT', '/v1/push/prefs', {
      quietEnabled: true,
      quietStartHour: 22,
      quietEndHour: 7,
      tzOffsetMin: 0,
      disabledTypes: ['nope'],
    });
    expect(badType.status).toBe(400);
  });
});

describe('push token binding over HTTP', () => {
  it('a token moves to the latest account and only its owner can unregister it', async () => {
    const a = await devAuth();
    const b = await devAuth();
    const fcmToken = `tok-${uuidv7()}`;
    const body = { platform: 'android', fcmToken };
    expect((await call(a, 'POST', '/v1/push/register', body)).status).toBe(201);
    expect((await call(b, 'POST', '/v1/push/register', body)).status).toBe(201);
    const owner = async (): Promise<string[]> =>
      db.withConnection(async (c) => {
        const r = await c.query<{ user_id: string }>(
          `SELECT user_id FROM push_devices WHERE fcm_token = $1`,
          [fcmToken],
        );
        return r.rows.map((x) => x.user_id);
      });
    expect(await owner()).toEqual([b.sub]);
    // A guessing B's token deletes nothing.
    const stolen = await app.inject({
      method: 'DELETE',
      url: '/v1/push/register',
      headers: {
        authorization: `Bearer ${a.accessToken}`,
        'idempotency-key': uuidv7(),
        'content-type': 'application/json',
      },
      payload: { fcmToken },
    });
    expect(stolen.statusCode).toBe(204);
    expect(await owner()).toEqual([b.sub]);
    const own = await app.inject({
      method: 'DELETE',
      url: '/v1/push/register',
      headers: {
        authorization: `Bearer ${b.accessToken}`,
        'idempotency-key': uuidv7(),
        'content-type': 'application/json',
      },
      payload: { fcmToken },
    });
    expect(own.statusCode).toBe(204);
    expect(await owner()).toEqual([]);
    const bad = await app.inject({
      method: 'DELETE',
      url: '/v1/push/register',
      headers: {
        authorization: `Bearer ${b.accessToken}`,
        'idempotency-key': uuidv7(),
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
  });

  it('DELETE accepts apnsToken, needs exactly one token, and is caller-only', async () => {
    const a = await devAuth();
    const b = await devAuth();
    const apnsToken = `apns-${uuidv7()}`;
    expect(
      (await call(a, 'POST', '/v1/push/register', { platform: 'ios', apnsToken })).status,
    ).toBe(201);
    const del = (u: { accessToken: string }, payload: unknown) =>
      app.inject({
        method: 'DELETE',
        url: '/v1/push/register',
        headers: {
          authorization: `Bearer ${u.accessToken}`,
          'idempotency-key': uuidv7(),
          'content-type': 'application/json',
        },
        payload: payload as Record<string, unknown>,
      });
    const rows = async (): Promise<number> =>
      db.withConnection(
        async (c) =>
          (await c.query(`SELECT 1 FROM push_devices WHERE apns_token = $1`, [apnsToken]))
            .rowCount ?? 0,
      );
    expect((await del(b, { apnsToken })).statusCode).toBe(204);
    expect(await rows()).toBe(1);
    expect((await del(a, { apnsToken, fcmToken: 'x' })).statusCode).toBe(400);
    expect(await rows()).toBe(1);
    expect((await del(a, { apnsToken })).statusCode).toBe(204);
    expect(await rows()).toBe(0);
    expect((await del(a, { apnsToken })).statusCode).toBe(204);
  });
});
