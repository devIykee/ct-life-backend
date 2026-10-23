/**
 * Home doors through the routes: GET /me carries `home`, the lease takes a
 * unit, access / guests / move-out / visit enforce who may open the door,
 * and a user cannot touch someone else's home (no IDOR).
 *
 * Uses its own penthouse unit (`test:home_routes:0`), so it never competes
 * with the flat doors in contract/ids/home_units.json.
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

const UNIT = 'test:home_routes:0';

async function cleanup(): Promise<void> {
  await db.withConnection(async (c) => {
    await c.query(`DELETE FROM homes WHERE unit_id = $1`, [UNIT]);
    await c.query(`DELETE FROM home_units WHERE unit_id = $1`, [UNIT]);
  });
}

describe('home doors over HTTP', () => {
  it('lease, access, guests, visit and move-out', async () => {
    await cleanup();
    await db.withConnection((c) =>
      c.query(
        `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents, capacity)
         VALUES ($1, 'residences', 'penthouse', 'test_room', 150000, 3)`,
        [UNIT],
      ),
    );
    const owner = await devAuth();
    const guest = await devAuth();
    const stranger = await devAuth();
    await db.withConnection((c) =>
      c.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 1000000)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = 1000000`,
        [owner.sub],
      ),
    );

    // Street: no home yet.
    const street = await call(owner, 'GET', '/v1/me');
    expect(street.status).toBe(200);
    expect(street.body.home).toBeNull();

    const lease = await call(owner, 'POST', '/v1/homes', { kind: 'penthouse' });
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    expect(lease.body).toMatchObject({ unitId: UNIT, tier: 'penthouse', status: 'active' });
    const homeId = lease.body.homeId as string;

    const me = await call(owner, 'GET', '/v1/me');
    expect(me.body.home).toEqual({
      homeId,
      unitId: UNIT,
      tier: 'penthouse',
      roomType: 'test_room',
      status: 'active',
      missedWeeks: 0,
    });

    // The door is locked for a stranger, open for the owner.
    expect((await call(stranger, 'GET', `/v1/units/${UNIT}/access`)).body).toEqual({
      canEnter: false,
      reason: 'locked',
    });
    expect((await call(owner, 'GET', `/v1/units/${UNIT}/access`)).body).toEqual({
      canEnter: true,
      reason: 'owner',
    });
    expect((await call(owner, 'GET', '/v1/units/nope:nope:0/access')).status).toBe(404);

    // A stranger cannot add themselves or anyone to the owner's home, nor move it out.
    const sneak = await call(stranger, 'POST', `/v1/homes/${homeId}/guests/${stranger.sub}`);
    expect(sneak.status).toBe(403);
    expect((sneak.body.error as { code: string }).code).toBe('NOT_HOME_OWNER');
    expect((await call(guest, 'DELETE', `/v1/homes/${homeId}/guests/${guest.sub}`)).status).toBe(
      403,
    );
    expect((await call(stranger, 'POST', `/v1/homes/${homeId}/move-out`)).status).toBe(403);
    expect((await call(stranger, 'GET', `/v1/units/${UNIT}/access`)).body.canEnter).toBe(false);

    // Visit: 403 for a stranger, the room for a guest.
    const refused = await call(stranger, 'POST', `/v1/homes/${owner.sub}/visit`);
    expect(refused.status).toBe(403);
    expect((refused.body.error as { code: string }).code).toBe('FORBIDDEN');
    const added = await call(owner, 'POST', `/v1/homes/${homeId}/guests/${guest.sub}`);
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ homeId, guests: [guest.sub] });
    const visit = await call(guest, 'POST', `/v1/homes/${owner.sub}/visit`);
    expect(visit.status).toBe(200);
    expect(visit.body).toMatchObject({ homeId, unitId: UNIT, roomType: 'test_room' });
    expect((await call(guest, 'GET', `/v1/units/${UNIT}/access`)).body).toEqual({
      canEnter: true,
      reason: 'guest',
    });
    const bad = await call(owner, 'POST', `/v1/homes/${homeId}/guests/not-a-uuid`);
    expect(bad.status).toBe(400);

    // The owner removes the guest, then moves out; the door locks and frees.
    const removed = await call(owner, 'DELETE', `/v1/homes/${homeId}/guests/${guest.sub}`);
    expect(removed.body).toEqual({ homeId, guests: [] });
    expect((await call(guest, 'POST', `/v1/homes/${owner.sub}/visit`)).status).toBe(403);
    const out = await call(owner, 'POST', `/v1/homes/${homeId}/move-out`);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ status: 'moved_out', unitId: null });
    expect((await call(owner, 'GET', `/v1/units/${UNIT}/access`)).body).toEqual({
      canEnter: false,
      reason: 'vacant',
    });
    expect((await call(owner, 'GET', '/v1/me')).body.home).toBeNull();
    await cleanup();
  });
});
