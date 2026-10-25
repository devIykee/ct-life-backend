/**
 * Heat, pursuit and jail over HTTP: auth, strict bodies, the HUD state, and the
 * jail restrictions on trading, launching, perps and the casino (403 JAILED),
 * with bail lifting them.
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
    headers: { 'idempotency-key': `heat-routes-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json() as { id: string; accessToken: string };
  return { sub: body.id, accessToken: body.accessToken };
}

function errCode(body: Record<string, unknown>): string {
  return (body.error as { code: string }).code;
}

async function jail(userId: string, bailCents: number): Promise<void> {
  await db.withConnection((c) =>
    c.query(
      `INSERT INTO player_jail (user_id, jail_id, jailed_at, jailed_until, bail_cents, heat_at_arrest)
       VALUES ($1, $2, now(), now() + interval '10 minutes', $3, 80)
       ON CONFLICT (user_id) DO UPDATE SET jailed_until = now() + interval '10 minutes',
         released_at = NULL, release_reason = NULL, bail_cents = $3`,
      [userId, uuidv7(), bailCents],
    ),
  );
}

async function callAs(
  u: AuthedUser,
  method: 'GET' | 'POST',
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

it('GET /heat/me needs auth and starts cool; the catch and bail routes validate', async () => {
  const anon = await app.inject({ method: 'GET', url: '/v1/heat/me' });
  expect(anon.statusCode).toBe(401);
  const u = await devAuth();
  const me = await callAs(u, 'GET', '/v1/heat/me');
  expect(me.status).toBe(200);
  expect(me.body).toMatchObject({
    heat: 0,
    level: 'cool',
    decayAt: null,
    wantedUntil: null,
    pursuit: null,
    jail: null,
    levels: { warm: 10, hot: 35, wanted: 70 },
  });
  // Strict body: an escape cannot be reported, extra fields are refused.
  const bad = await callAs(u, 'POST', '/v1/heat/caught', {
    pursuitId: uuidv7(),
    x: 1,
    z: 1,
    escaped: true,
  });
  expect(bad.status).toBe(400);
  const none = await callAs(u, 'POST', '/v1/heat/caught', { pursuitId: uuidv7(), x: 1, z: 1 });
  expect(none.status).toBe(409);
  expect(errCode(none.body)).toBe('NO_PURSUIT');
  const bail = await callAs(u, 'POST', '/v1/heat/bail');
  expect(bail.status).toBe(409);
  expect(errCode(bail.body)).toBe('NOT_JAILED');
});

it('jail blocks launching, buying, new perps and casino bets (403 JAILED) until bail is paid', async () => {
  const u = await devAuth();
  await db.withConnection((c) =>
    c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 50000)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = 50000`,
      [u.sub],
    ),
  );
  await jail(u.sub, 3_500);
  const me = await callAs(u, 'GET', '/v1/heat/me');
  expect(me.body.jail).toMatchObject({ venueId: 'ct_jail', bailCents: 3_500 });

  const launch = await callAs(u, 'POST', '/v1/factory/coins', {
    name: 'Jail Frog',
    ticker: `ZJ${Math.floor(Math.random() * 9000 + 1000)}`,
    templateId: 'rf_frog',
    liquidityCents: 5000,
    devAllocationBps: 0,
  });
  const buy = await callAs(u, 'POST', '/v1/market/trades', {
    coinId: uuidv7(),
    side: 'buy',
    cashCents: 100,
  });
  const perp = await callAs(u, 'POST', '/v1/perps', {
    coinId: uuidv7(),
    side: 'long',
    leverage: 2,
    marginCents: 100,
  });
  const slots = await callAs(u, 'POST', '/v1/casino/slots/spin', { stakeCents: 100 });
  for (const r of [launch, buy, perp, slots]) {
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(errCode(r.body)).toBe('JAILED');
  }
  expect((launch.body.error as { details: { bailCents: number } }).details.bailCents).toBe(3_500);

  // Selling is still allowed (the coin does not exist, so it is a 404, not a 403).
  const sell = await callAs(u, 'POST', '/v1/market/trades', {
    coinId: uuidv7(),
    side: 'sell',
    units: '1',
  });
  expect(sell.status).not.toBe(403);

  const paid = await callAs(u, 'POST', '/v1/heat/bail');
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  expect(paid.body).toMatchObject({ released: true, bailCents: 3_500, cashCents: 46_500 });
  const after = await callAs(u, 'POST', '/v1/factory/coins', {
    name: 'Free Frog',
    ticker: `ZK${Math.floor(Math.random() * 9000 + 1000)}`,
    templateId: 'rf_frog',
    liquidityCents: 5000,
    devAllocationBps: 0,
  });
  expect(after.status, JSON.stringify(after.body)).toBe(201);
});
