/**
 * GitHub #5 journeys, end to end through the routes.
 *
 * Businesses: GET /v1/businesses lists what I own (it was a 404), POST
 * buys a catalog kind by `kindId`, collect pays the periods that
 * accrued, sell refunds `sellBackBps` of the cost.
 *
 * Time is moved by back-dating the business row. Run: `pnpm test:unit`
 * (uses the dev Postgres and Redis).
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
    headers: { 'idempotency-key': `city-routes-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json() as { id: string; accessToken: string };
  return { sub: body.id, accessToken: body.accessToken };
}

async function call(
  u: AuthedUser,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  idem: string = uuidv7(),
): Promise<{ status: number; body: Record<string, unknown> & unknown[] }> {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.accessToken}`,
      ...(method === 'POST' ? { 'idempotency-key': idem } : {}),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: r.statusCode, body: r.json() };
}

async function sql<T extends Record<string, unknown>>(q: string, args: unknown[]): Promise<T[]> {
  const r = await db.withConnection((c) => c.query<T>(q, args));
  return r.rows;
}

const DAY_MS = 24 * 3_600_000;
const LAB = {
  kindId: 'memecoin_lab',
  costCents: 30_000_000,
  minCents: 500_000,
  maxCents: 3_000_000,
};

async function cash(u: AuthedUser): Promise<number> {
  const r = await sql<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [u.sub],
  );
  return Number(r[0]?.cash_cents ?? 0);
}

async function setCash(u: AuthedUser, cents: number): Promise<void> {
  await sql(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2`,
    [u.sub, cents],
  );
}

/** Pretend the business was bought `days` days ago and never collected. */
async function backdate(businessId: string, days: number): Promise<void> {
  const at = new Date(Date.now() - days * DAY_MS);
  await sql(`UPDATE businesses SET created_at = $1, accrued_until = $1 WHERE business_id = $2`, [
    at,
    businessId,
  ]);
}

async function ledger(u: AuthedUser, reason: string): Promise<number[]> {
  const r = await sql<{ delta_cents: string }>(
    `SELECT delta_cents FROM ledger_entries WHERE user_id = $1 AND reason = $2 ORDER BY id`,
    [u.sub, reason],
  );
  return r.map((x) => Number(x.delta_cents));
}

describe('businesses', () => {
  it('lists, buys, collects and sells a catalog business', async () => {
    const u = await devAuth();
    await setCash(u, 50_000_000);

    const empty = await call(u, 'GET', '/v1/businesses');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ owned: [] });

    const bought = await call(u, 'POST', '/v1/businesses', { kindId: LAB.kindId });
    expect(bought.status, JSON.stringify(bought.body)).toBe(201);
    const id = bought.body.businessId as string;
    expect(bought.body).toMatchObject({
      kindId: LAB.kindId,
      pendingCents: 0,
      sellBackCents: LAB.costCents / 2,
      lastDay: null,
    });
    expect(await cash(u)).toBe(50_000_000 - LAB.costCents);
    expect(await ledger(u, 'business_buy')).toEqual([-LAB.costCents]);

    await backdate(id, 3.5);
    const listed = await call(u, 'GET', '/v1/businesses');
    const owned = (listed.body.owned as Array<Record<string, unknown>>)[0]!;
    expect(owned.businessId).toBe(id);
    const pending = owned.pendingCents as number;
    expect(pending).toBeGreaterThanOrEqual(3 * Math.floor(LAB.minCents * 0.05));
    expect(pending).toBeLessThanOrEqual(3 * LAB.maxCents);

    const before = await cash(u);
    const key = uuidv7();
    const got = await call(u, 'POST', `/v1/businesses/${id}/collect`, undefined, key);
    expect(got.status).toBe(200);
    expect(got.body.collectedCents).toBe(pending);
    expect(got.body.days as unknown[]).toHaveLength(3);
    expect(got.body.cashCents).toBe(before + pending);
    expect(await cash(u)).toBe(before + pending);

    // Same key replays; a new key finds nothing pending.
    const replay = await call(u, 'POST', `/v1/businesses/${id}/collect`, undefined, key);
    expect(replay.body).toEqual(got.body);
    const again = await call(u, 'POST', `/v1/businesses/${id}/collect`);
    expect(again.body).toMatchObject({ collectedCents: 0, days: [] });
    expect(await ledger(u, 'business_pay')).toEqual([pending]);

    const detail = await call(u, 'GET', `/v1/businesses/${id}`);
    expect(detail.body.recentDays as unknown[]).toHaveLength(3);

    const sold = await call(u, 'POST', `/v1/businesses/${id}/sell`);
    expect(sold.status).toBe(200);
    expect(sold.body).toMatchObject({ refundCents: LAB.costCents / 2, collectedCents: 0 });
    expect(await cash(u)).toBe(before + pending + LAB.costCents / 2);
    expect((await call(u, 'GET', '/v1/businesses')).body).toEqual({ owned: [] });
    expect((await call(u, 'POST', `/v1/businesses/${id}/sell`)).status).toBe(404);
  });

  it('pays at most maxPendingPayouts periods', async () => {
    const u = await devAuth();
    await setCash(u, LAB.costCents);
    const id = (await call(u, 'POST', '/v1/businesses', { kindId: LAB.kindId })).body
      .businessId as string;
    await backdate(id, 20.2);
    const got = await call(u, 'POST', `/v1/businesses/${id}/collect`);
    expect(got.body.days as unknown[]).toHaveLength(7);
  });

  it('refuses short cash, a second of the same kind, unknown kinds and strangers', async () => {
    const u = await devAuth();
    await setCash(u, LAB.costCents - 1);
    const poor = await call(u, 'POST', '/v1/businesses', { kindId: LAB.kindId });
    expect(poor.status).toBe(402);
    expect((poor.body as unknown as { error: { code: string } }).error.code).toBe(
      'INSUFFICIENT_CASH',
    );

    await setCash(u, 2 * LAB.costCents);
    const id = (await call(u, 'POST', '/v1/businesses', { kindId: LAB.kindId })).body
      .businessId as string;
    const twice = await call(u, 'POST', '/v1/businesses', { kindId: LAB.kindId });
    expect(twice.status).toBe(403);
    expect(JSON.stringify(twice.body)).toContain('max_owned');

    expect((await call(u, 'POST', '/v1/businesses', { kindId: 'lemonade_stand' })).status).toBe(
      400,
    );

    const other = await devAuth();
    expect((await call(other, 'POST', `/v1/businesses/${id}/collect`)).status).toBe(403);
    expect((await call(other, 'GET', `/v1/businesses/${id}`)).status).toBe(404);
  });
});
