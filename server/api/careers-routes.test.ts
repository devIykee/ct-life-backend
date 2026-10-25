import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T12:00:00Z') });
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
  vi.useRealTimers();
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
    headers: { 'idempotency-key': `careers-${uuidv7()}` },
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
const BASE = new Date('2026-11-05T12:00:00Z');

function orders(
  n: number,
): Array<{ i: number; startedMs: number; servedMs: number; correct: boolean }> {
  const out = [];
  let served = 4000;
  for (let i = 0; i < n; i++) {
    const serve = 3000 + ((i * 937) % 3000);
    served += 5000 + ((i * 611) % 4000);
    out.push({ i, startedMs: served - serve, servedMs: served, correct: true });
  }
  return out;
}

async function broke(u: AuthedUser): Promise<void> {
  await db.withConnection((c) =>
    c.query(
      `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 72000)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = 0, debt_cents = 72000`,
      [u.sub],
    ),
  );
}

const cashOf = async (u: AuthedUser): Promise<number> =>
  Number(
    (
      await db.withConnection((c) =>
        c.query<{ c: string }>(`SELECT cash_cents AS c FROM balances WHERE user_id = $1`, [u.sub]),
      )
    ).rows[0]?.c ?? 0,
  );

describe('auth', () => {
  it('every careers and jobs route needs a token', async () => {
    for (const [method, url] of [
      ['GET', '/v1/careers?view=ladders'],
      ['POST', '/v1/careers/builder/join'],
      ['GET', '/v1/jobs/rekt-burger'],
      ['POST', '/v1/jobs/rekt-burger/shift/start'],
      ['POST', '/v1/jobs/rekt-burger/shift/finish'],
      ['POST', '/v1/jobs/rekt-burger/leave'],
    ] as const) {
      const r = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('career ladders over HTTP', () => {
  it('keeps the job list as the default GET /v1/careers and serves ladders on ?view=ladders', async () => {
    const u = await devAuth();
    const jobs = await app.inject({
      method: 'GET',
      url: '/v1/careers',
      headers: { authorization: `Bearer ${u.accessToken}` },
    });
    expect(Array.isArray(jobs.json())).toBe(true);
    expect(jobs.json()[0]).toHaveProperty('payCents');

    const r = await call(u, 'GET', '/v1/careers?view=ladders');
    expect(r.status).toBe(200);
    const b = r.body as unknown as {
      myLadderId: string | null;
      joinCooldownHours: number;
      ladders: Array<{ id: string; ranks: unknown[]; nextRank: { title: string } | null }>;
    };
    expect(b.myLadderId).toBeNull();
    expect(b.joinCooldownHours).toBe(72);
    expect(b.ladders.map((l) => l.id).sort()).toEqual([
      'builder',
      'caller',
      'farmer',
      'founder',
      'trader',
    ]);
    expect(b.ladders[0]!.ranks).toHaveLength(7);
    expect(b.ladders[0]!.nextRank).toMatchObject({ title: expect.any(String) });
    expect((await call(u, 'GET', '/v1/careers?view=nope')).status).toBe(400);
  });

  it('joins, refuses a quick switch with CAREER_SWITCH_COOLDOWN, and 404s an unknown ladder', async () => {
    const u = await devAuth();
    const j = await call(u, 'POST', '/v1/careers/caller/join', {});
    expect(j.status).toBe(200);
    expect(j.body).toMatchObject({ ladderId: 'caller', alreadyMember: false, rank: 1 });
    const again = await call(u, 'POST', '/v1/careers/caller/join', {});
    expect(again.body).toMatchObject({ alreadyMember: true });
    const sw = await call(u, 'POST', '/v1/careers/trader/join', {});
    expect(sw.status).toBe(409);
    expect(errCode(sw.body)).toBe('CAREER_SWITCH_COOLDOWN');
    expect((sw.body.error as { details: { retryAt: string } }).details.retryAt).toBeTruthy();
    expect((await call(u, 'POST', '/v1/careers/astronaut/join', {})).status).toBe(404);
    const mine = (await call(u, 'GET', '/v1/careers?view=ladders')).body as {
      myLadderId: string;
      canSwitchAt: string;
    };
    expect(mine.myLadderId).toBe('caller');
    expect(mine.canSwitchAt).toBeTruthy();
  });

  it('shows career areas on the venue access lookup', async () => {
    const u = await devAuth();
    await call(u, 'POST', '/v1/careers/trader/join', {});
    await db.withConnection((c) =>
      c.query(
        `INSERT INTO ladder_progress (user_id, ladder_id, xp, rank) VALUES ($1, 'trader', 1500, 4)
         ON CONFLICT (user_id, ladder_id) DO UPDATE SET xp = 1500, rank = 4`,
        [u.sub],
      ),
    );
    const r = await call(u, 'GET', '/v1/venues/perp_pit/access');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ allowed: true, careerAreas: ['high_roller_floor'] });
  });
});

describe('Rekt Burger over HTTP', () => {
  it('is locked for a solvent player (403 JOB_LOCKED) and unlocks when broke', async () => {
    const u = await devAuth();
    const locked = await call(u, 'GET', '/v1/jobs/rekt-burger');
    expect(locked.body).toMatchObject({ unlocked: false, jobId: 'rekt-burger' });
    const start = await call(u, 'POST', '/v1/jobs/rekt-burger/shift/start', {});
    expect(start.status).toBe(403);
    expect(errCode(start.body)).toBe('JOB_LOCKED');
    await broke(u);
    const open = await call(u, 'GET', '/v1/jobs/rekt-burger');
    expect(open.body).toMatchObject({ unlocked: true, reason: 'broke', netWorthCents: -72000 });
  });

  it('runs a shift end to end: server-side pay, replay safe, no client amount, no IDOR', async () => {
    const a = await devAuth();
    const b = await devAuth();
    await broke(a);
    await broke(b);
    vi.setSystemTime(BASE);
    const s = await call(a, 'POST', '/v1/jobs/rekt-burger/shift/start', {});
    expect(s.status).toBe(200);
    const shiftId = s.body.shiftId as string;
    await call(b, 'POST', '/v1/jobs/rekt-burger/shift/start', {});

    // Too early.
    vi.setSystemTime(new Date(BASE.getTime() + 10_000));
    const early = await call(a, 'POST', '/v1/jobs/rekt-burger/shift/finish', {
      result: { orders: orders(8) },
    });
    expect(early.status).toBe(400);
    expect(errCode(early.body)).toBe('SHIFT_NOT_FINISHED');

    vi.setSystemTime(new Date(BASE.getTime() + 60_000));
    // A client-sent amount is not accepted at all.
    const cheat = await call(a, 'POST', '/v1/jobs/rekt-burger/shift/finish', {
      result: { orders: orders(8), payCents: 999_999 },
    });
    expect(cheat.status).toBe(400);
    const cheat2 = await call(a, 'POST', '/v1/jobs/rekt-burger/shift/finish', {
      payCents: 999_999,
      result: { orders: orders(8) },
    });
    expect(cheat2.status).toBe(400);
    expect(await cashOf(a)).toBe(0);

    // Another player's shift id is a 404, and pays nothing.
    const idor = await call(b, 'POST', '/v1/jobs/rekt-burger/shift/finish', {
      shiftId,
      result: { orders: orders(8) },
    });
    // b has their own open shift, but not this id: a's shift is invisible.
    expect(idor.status).toBe(404);

    const key = uuidv7();
    const done = await call(
      a,
      'POST',
      '/v1/jobs/rekt-burger/shift/finish',
      { shiftId, result: { orders: orders(8) } },
      key,
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ shiftId, orders: 8, correct: 8, payCents: 300 + 8 * 60 });
    const replay = await call(
      a,
      'POST',
      '/v1/jobs/rekt-burger/shift/finish',
      { shiftId, result: { orders: orders(8) } },
      key,
    );
    expect(replay.body).toEqual(done.body);
    expect(await cashOf(a)).toBe(300 + 8 * 60);
    const second = await call(a, 'POST', '/v1/jobs/rekt-burger/shift/finish', {
      shiftId,
      result: { orders: orders(8) },
    });
    expect(second.status).toBe(409);
    expect(await cashOf(a)).toBe(300 + 8 * 60);
    expect(await cashOf(b)).toBe(0);
  });

  it('answers 422 SHIFT_RESULT_IMPLAUSIBLE for an impossible report', async () => {
    const u = await devAuth();
    await broke(u);
    vi.setSystemTime(new Date(BASE.getTime()));
    await call(u, 'POST', '/v1/jobs/rekt-burger/shift/start', {});
    vi.setSystemTime(new Date(BASE.getTime() + 60_000));
    const fast = Array.from({ length: 40 }, (_, i) => ({
      i,
      startedMs: i * 100,
      servedMs: i * 100 + 50,
      correct: true,
    }));
    const r = await call(u, 'POST', '/v1/jobs/rekt-burger/shift/finish', {
      result: { orders: fast },
    });
    expect(r.status).toBe(422);
    expect(errCode(r.body)).toBe('SHIFT_RESULT_IMPLAUSIBLE');
    expect(await cashOf(u)).toBe(0);
  });

  it('rate limits shift starts per player', async () => {
    const u = await devAuth();
    await broke(u);
    vi.setSystemTime(new Date(BASE.getTime()));
    let limited = 0;
    for (let i = 0; i < 9; i++) {
      const r = await call(u, 'POST', '/v1/jobs/rekt-burger/shift/start', {});
      if (r.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('leave is idempotent and harmless without a job', async () => {
    const u = await devAuth();
    const r = await call(u, 'POST', '/v1/jobs/rekt-burger/leave', {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ wasEmployed: false, glowUp: false });
  });
});
