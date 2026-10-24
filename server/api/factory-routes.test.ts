/**
 * Rugpull Factory over HTTP: auth, strict body (no client-chosen arc, price
 * or creator), idempotent launch replay, creator-only earnings, and trading a
 * player coin through the market trade endpoint.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
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
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.accessToken}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': uuidv7() }),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: r.statusCode, body: r.json() };
}

it('launches over HTTP: strict body, idempotent replay, one charge, creator-only earnings', async () => {
  const creator = await devAuth();
  const other = await devAuth();
  await db.withConnection((c) =>
    c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000), ($2, 100000)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = 100000`,
      [creator.sub, other.sub],
    ),
  );
  const t = `ZR${Math.floor(Math.random() * 9000 + 1000)}`;
  const body = {
    name: 'Route Frog',
    ticker: t,
    templateId: 'rf_frog',
    liquidityCents: 5000,
    devAllocationBps: 2000,
  };

  const anon = await app.inject({ method: 'POST', url: '/v1/factory/coins', payload: body });
  expect(anon.statusCode).toBe(401);

  // The client cannot pick the arc, price, creator or anything else.
  for (const extra of [
    { hiddenArc: { outcome: 'moon' } },
    { creatorId: other.sub },
    { priceMicros: 1 },
  ]) {
    const r = await call(creator, 'POST', '/v1/factory/coins', { ...body, ...extra });
    expect(r.status).toBe(400);
  }
  expect(
    (await call(creator, 'POST', '/v1/factory/coins', { ...body, name: 'F.u.c.k' })).status,
  ).toBe(400);

  const key = uuidv7();
  const post = (): Promise<Awaited<ReturnType<typeof app.inject>>> =>
    app.inject({
      method: 'POST',
      url: '/v1/factory/coins',
      headers: { authorization: `Bearer ${creator.accessToken}`, 'idempotency-key': key },
      payload: body,
    });
  const a = await post();
  const b = await post();
  expect(a.statusCode, a.body).toBe(201);
  expect(b.statusCode).toBe(201);
  const coin = a.json() as { coinId: string };
  expect((b.json() as { coinId: string }).coinId).toBe(coin.coinId);
  const bal = await db.withConnection((c) =>
    c.query<{ cash_cents: string }>(`SELECT cash_cents FROM balances WHERE user_id = $1`, [
      creator.sub,
    ]),
  );
  expect(Number(bal.rows[0]!.cash_cents)).toBe(100000 - 500 - 5000);

  // A second launch straight away hits the cooldown.
  const again = await call(creator, 'POST', '/v1/factory/coins', {
    ...body,
    ticker: `${t}X`.slice(0, 6),
  });
  expect(again.status).toBe(429);
  expect((again.body as { error: { code: string } }).error.code).toBe('LAUNCH_COOLDOWN');

  // Another player buys through the market endpoint; sees no creator earnings.
  const trade = await call(other, 'POST', '/v1/market/trades', {
    coinId: coin.coinId,
    side: 'buy',
    cashCents: 1000,
  });
  expect(trade.status, JSON.stringify(trade.body)).toBe(200);
  const seen = await call(other, 'GET', `/v1/factory/coins/${coin.coinId}`);
  expect(seen.status).toBe(200);
  expect(seen.body['creatorFeesCents']).toBeNull();
  expect(JSON.stringify(seen.body)).not.toContain('hiddenArc');
  const mine = await call(creator, 'GET', `/v1/factory/coins/${coin.coinId}`);
  expect(mine.body['creatorFeesCents']).toBe('0');

  const list = await call(creator, 'GET', '/v1/factory/coins?view=mine');
  expect((list.body['coins'] as Array<{ coinId: string }>).map((c) => c.coinId)).toContain(
    coin.coinId,
  );
  const others = await call(other, 'GET', '/v1/factory/coins?view=mine');
  expect(others.body['coins']).toEqual([]);
  expect((await call(other, 'GET', '/v1/factory/coins?view=bogus')).status).toBe(400);

  const cfg = await call(other, 'GET', '/v1/factory/config');
  expect(cfg.body['launchFeeCents']).toBe(500);
  expect(Object.keys(cfg.body['arcOddsPct'] as object).sort()).toEqual([
    'moon',
    'rug',
    'sideways',
    'slow_bleed',
  ]);
  const me = await call(creator, 'GET', '/v1/factory/me');
  expect(me.body['launchesToday']).toBe(1);
});
