/**
 * Map Travel over HTTP (docs/TRAVEL.md): every route answers 503 CAPABILITY_OFF while
 * `travel` is off and GET /config sends `travel: null`; with it on: quote, book (201,
 * Idempotency-Key required, walk refused), the 429 TRAVEL_COOLDOWN Retry-After header,
 * cancel, current, and 403 JAILED on booking. Service rules: server/application/travel.test.ts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests, buildContext } from '../application/context.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { encodePos, POS_HASH } from '../realtime/movement.js';
import { getTravelConfig, travelTicketKey } from '../application/travel.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const savedCaps = process.env.CAPABILITIES_ON;
let app: Awaited<ReturnType<typeof buildServer>>['app'] | null = null;
let stop: (() => Promise<void>) | null = null;
const users: string[] = [];
const STOP = getTravelConfig().busStops.find((s) => s.id === 'stop_timeline')!;

interface U {
  id: string;
  token: string;
}

async function boot(caps: string): Promise<void> {
  if (stop) await stop();
  process.env.CAPABILITIES_ON = caps;
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  _resetContextForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}

async function devUser(cashCents: number): Promise<U> {
  const r = await app!.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `travel-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = 0`,
    [b.id, cashCents],
  );
  await buildContext().redis.main.hset(
    POS_HASH,
    b.id,
    encodePos({ x: STOP.x, z: STOP.z, at: Date.now() }),
  );
  users.push(b.id);
  return { id: b.id, token: b.accessToken };
}

async function call(
  u: U,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = method === 'POST' ? { 'idempotency-key': uuidv7() } : {},
): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  const r = await app!.inject({
    method,
    url,
    headers: { authorization: `Bearer ${u.token}`, ...headers },
    ...(payload ? { payload } : {}),
  });
  return { status: r.statusCode, body: r.json(), headers: r.headers };
}

afterAll(async () => {
  const redis = buildContext().redis.main;
  for (const u of users) {
    await redis.hdel(POS_HASH, u);
    await redis.del(travelTicketKey(u));
  }
  if (stop) await stop();
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
  await pool.end();
}, 30_000);

describe('Map Travel routes', () => {
  it('are dark while `travel` is off', async () => {
    await boot('');
    const u = await devUser(10_000);
    const tripId = uuidv7();
    for (const [method, url, body] of [
      ['GET', '/v1/travel/quote?to=terminal_cafe', undefined],
      ['POST', '/v1/travel/trips', { quoteId: uuidv7(), mode: 'bus' }],
      ['GET', '/v1/travel/trips/current', undefined],
      ['POST', `/v1/travel/trips/${tripId}/cancel`, undefined],
    ] as const) {
      const r = await call(u, method, url, body);
      expect(r.status, url).toBe(503);
      expect(r.body.error).toMatchObject({
        code: 'CAPABILITY_OFF',
        details: { capability: 'travel' },
      });
    }
    const cfg = await app!.inject({ method: 'GET', url: '/v1/config' });
    const body = cfg.json() as {
      travel: unknown;
      capabilities: { features: Record<string, boolean> };
    };
    expect(body.travel).toBeNull();
    expect(body.capabilities.features.travel).toBe(false);
    expect(body.capabilities.features.travelInstantGoOff).toBe(false);
  }, 30_000);

  it('quote, book, cooldown, current and cancel work while on', async () => {
    await boot('travel');
    const cfg = await app!.inject({ method: 'GET', url: '/v1/config' });
    const cb = cfg.json() as {
      travel: { busStops: unknown[] };
      capabilities: { features: Record<string, boolean> };
    };
    expect(cb.capabilities.features.travel).toBe(true);
    expect(cb.travel.busStops.length).toBe(getTravelConfig().busStops.length);

    const u = await devUser(10_000);
    const q = await call(u, 'GET', '/v1/travel/quote?to=terminal_cafe');
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.modes.map((m: { mode: string }) => m.mode)).toEqual(['walk', 'bus', 'taxi']);

    expect(
      (await call(u, 'POST', '/v1/travel/trips', { quoteId: q.body.quoteId, mode: 'walk' })).status,
    ).toBe(400);
    expect(
      (await call(u, 'POST', '/v1/travel/trips', { quoteId: q.body.quoteId, mode: 'bus' }, {}))
        .status,
    ).toBe(400); // no Idempotency-Key

    const booked = await call(u, 'POST', '/v1/travel/trips', {
      quoteId: q.body.quoteId,
      mode: 'bus',
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body).toMatchObject({
      mode: 'bus',
      fareCents: 200,
      cashCents: 9_800,
      status: 'booked',
    });
    expect(booked.body.pickup?.id).toBe('stop_timeline');

    const cur = await call(u, 'GET', '/v1/travel/trips/current');
    expect(cur.body.trip.tripId).toBe(booked.body.tripId);

    const q2 = await call(u, 'GET', '/v1/travel/quote?to=terminal_cafe');
    const inProgress = await call(u, 'POST', '/v1/travel/trips', {
      quoteId: q2.body.quoteId,
      mode: 'bus',
    });
    expect(inProgress.status).toBe(409);
    expect(inProgress.body.error.code).toBe('TRAVEL_IN_PROGRESS');

    const cancelled = await call(u, 'POST', `/v1/travel/trips/${booked.body.tripId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ refundedCents: 200, cashCents: 10_000 });

    const q3 = await call(u, 'GET', '/v1/travel/quote?to=terminal_cafe');
    const cool = await call(u, 'POST', '/v1/travel/trips', {
      quoteId: q3.body.quoteId,
      mode: 'bus',
    });
    expect(cool.status).toBe(429);
    expect(cool.body.error.code).toBe('TRAVEL_COOLDOWN');
    expect(Number(cool.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(cool.headers['retry-after'])).toBeLessThanOrEqual(10);
  }, 30_000);

  it('refuses a jailed player at booking', async () => {
    const u = await devUser(10_000);
    const q = await call(u, 'GET', '/v1/travel/quote?to=terminal_cafe');
    expect(q.status).toBe(200);
    await pool.query(
      `INSERT INTO player_jail (user_id, jail_id, jailed_at, jailed_until, bail_cents, heat_at_arrest)
       VALUES ($1, $2, now(), now() + interval '1 hour', 500, 1)`,
      [u.id, uuidv7()],
    );
    const r = await call(u, 'POST', '/v1/travel/trips', { quoteId: q.body.quoteId, mode: 'taxi' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('JAILED');
  }, 30_000);
});
