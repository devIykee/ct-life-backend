/**
 * Duo Shop over HTTP: auth, validation, idempotent replay, the ownership
 * checks (no IDOR) on orders and homes, and the placements a guest can read.
 *
 * The delivery queue is stubbed; the delivery itself is covered in
 * server/application/shop.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../application/shop-queue.js', () => ({
  scheduleShopDelivery: vi.fn(async () => undefined),
  unscheduleShopDelivery: vi.fn(async () => undefined),
  closeShopQueue: vi.fn(async () => undefined),
}));

import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { buildContext } from '../application/context.js';
import { deliverOrder } from '../workers/shop-delivery.js';

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

const UNIT = 'test:shop_routes:0';
const errCode = (b: Record<string, unknown>): string => (b.error as { code: string }).code;

async function cleanup(): Promise<void> {
  await db.withConnection(async (c) => {
    await c.query(`DELETE FROM homes WHERE unit_id = $1`, [UNIT]);
    await c.query(
      `DELETE FROM player_items WHERE order_id IN (SELECT order_id FROM shop_orders WHERE unit_id = $1)`,
      [UNIT],
    );
    await c.query(`DELETE FROM shop_orders WHERE unit_id = $1`, [UNIT]);
    await c.query(`DELETE FROM home_units WHERE unit_id = $1`, [UNIT]);
  });
}

describe('Duo Shop over HTTP', () => {
  it('catalogue, orders, cancel, delivery, items and placements', async () => {
    await cleanup();
    await db.withConnection((c) =>
      c.query(
        `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents, capacity)
         VALUES ($1, 'residences', 'penthouse', 'test_room', 150000, 3)`,
        [UNIT],
      ),
    );
    const owner = await devAuth();
    const other = await devAuth();
    const guest = await devAuth();
    for (const u of [owner, other, guest]) {
      await db.withConnection((c) =>
        c.query(
          `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 1000000)
           ON CONFLICT (user_id) DO UPDATE SET cash_cents = 1000000`,
          [u.sub],
        ),
      );
    }

    // Auth is required everywhere.
    expect((await app.inject({ method: 'GET', url: '/v1/shop/catalog' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me/items' })).statusCode).toBe(401);

    // Catalogue.
    const cat = await call(owner, 'GET', '/v1/shop/catalog');
    expect(cat.status).toBe(200);
    expect((cat.body.items as unknown[]).length).toBeGreaterThanOrEqual(20);
    expect(cat.body.lockerFeeCents).toBe(300);
    const food = await call(owner, 'GET', '/v1/shop/catalog?category=food');
    expect(
      (food.body.items as Array<{ category: string }>).every((i) => i.category === 'food'),
    ).toBe(true);
    expect((await call(owner, 'GET', '/v1/shop/catalog?category=cars')).status).toBe(400);

    // A street player: door is refused, locker works.
    const door = { items: [{ itemId: 'sofa_basic', qty: 1 }], window: 'asap', destination: 'door' };
    const noDoor = await call(owner, 'POST', '/v1/shop/orders', door);
    expect(noDoor.status).toBe(409);
    expect(errCode(noDoor.body)).toBe('NO_HOME_DOOR');

    // Lease a home with a door.
    const lease = await call(owner, 'POST', '/v1/homes', { kind: 'penthouse' });
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    const homeId = lease.body.homeId as string;

    // Validation.
    expect((await call(owner, 'POST', '/v1/shop/orders', { ...door, window: 'now' })).status).toBe(
      400,
    );
    expect(
      (
        await call(owner, 'POST', '/v1/shop/orders', {
          ...door,
          items: [{ itemId: 'sofa_basic', qty: 99 }],
        })
      ).status,
    ).toBe(400);
    expect((await call(owner, 'POST', '/v1/shop/orders', { ...door, totalCents: 1 })).status).toBe(
      201,
    ); // unknown keys (a client-sent price) are ignored, never used
    const broke = await call(other, 'POST', '/v1/shop/orders', { ...door, destination: 'locker' });
    expect(broke.status).toBe(201);

    // Order + idempotent replay with the same key.
    const key = uuidv7();
    const placed = await call(
      owner,
      'POST',
      '/v1/shop/orders',
      { items: [{ itemId: 'lamp_floor', qty: 2 }], window: '30m', destination: 'door' },
      key,
    );
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body).toMatchObject({
      status: 'placed',
      window: '30m',
      destination: 'door',
      unitId: UNIT,
      feeCents: 0,
    });
    const orderId = placed.body.orderId as string;
    const replay = await call(
      owner,
      'POST',
      '/v1/shop/orders',
      { items: [{ itemId: 'lamp_floor', qty: 2 }], window: '30m', destination: 'door' },
      key,
    );
    expect(replay.body.orderId).toBe(orderId);
    const spent = await db.withConnection((c) =>
      c.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE ref_id = $1 AND reason = 'shop_order'`,
        [orderId],
      ),
    );
    expect(spent.rows[0]?.n).toBe('1');

    // Missing Idempotency-Key.
    const noKey = await app.inject({
      method: 'POST',
      url: '/v1/shop/orders',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: door,
    });
    expect(noKey.statusCode).toBe(400);

    // Mine only; another player sees 404 for read and cancel.
    const mine = await call(owner, 'GET', '/v1/shop/orders');
    expect((mine.body.items as Array<{ orderId: string }>).some((o) => o.orderId === orderId)).toBe(
      true,
    );
    expect((await call(other, 'GET', '/v1/shop/orders')).body.items).not.toContainEqual(
      expect.objectContaining({ orderId }),
    );
    expect((await call(other, 'GET', `/v1/shop/orders/${orderId}`)).status).toBe(404);
    expect((await call(other, 'POST', `/v1/shop/orders/${orderId}/cancel`)).status).toBe(404);
    expect((await call(owner, 'GET', '/v1/shop/orders/not-a-uuid')).status).toBe(400);
    expect((await call(owner, 'GET', `/v1/shop/orders/${orderId}`)).body.orderId).toBe(orderId);

    // Cancel refunds; a second order is delivered.
    const toCancel = await call(owner, 'POST', '/v1/shop/orders', {
      items: [{ itemId: 'plant_pothos', qty: 1 }],
      window: '1h',
      destination: 'door',
    });
    const cancelled = await call(owner, 'POST', `/v1/shop/orders/${toCancel.body.orderId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');

    const ctx = buildContext();
    await deliverOrder(ctx, orderId, new Date(Date.now() + 2 * 3_600_000));
    await deliverOrder(ctx, toCancel.body.orderId as string, new Date(Date.now() + 2 * 3_600_000));
    expect((await call(owner, 'GET', `/v1/shop/orders/${orderId}`)).body.status).toBe('delivered');
    const lateCancel = await call(owner, 'POST', `/v1/shop/orders/${orderId}/cancel`);
    expect(lateCancel.status).toBe(409);
    expect(errCode(lateCancel.body)).toBe('ORDER_NOT_CANCELLABLE');

    // /me/items: two lamps, and the cancelled plant never arrived.
    const items = (await call(owner, 'GET', '/v1/me/items')).body.items as Array<{
      itemInstanceId: string;
      itemId: string;
    }>;
    const lamps = items.filter((i) => i.itemId === 'lamp_floor');
    expect(lamps).toHaveLength(2);
    expect(items.some((i) => i.itemId === 'plant_pothos')).toBe(false);
    expect(((await call(other, 'GET', '/v1/me/items')).body.items as unknown[]).length).toBe(0);

    // Placements: owner only, validated.
    const [lampA, lampB] = lamps as unknown as [
      { itemInstanceId: string },
      { itemInstanceId: string },
    ];
    const put = await call(owner, 'PUT', `/v1/homes/${homeId}/placements`, {
      placements: [
        { itemInstanceId: lampA.itemInstanceId, x: 1, z: 2, rotY: 0.25 },
        { itemInstanceId: lampB.itemInstanceId, x: -2, z: 1, rotY: 3 },
      ],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((put.body.placements as unknown[]).length).toBe(2);
    const dup = await call(owner, 'PUT', `/v1/homes/${homeId}/placements`, {
      placements: [
        { itemInstanceId: lampA.itemInstanceId, x: 1, z: 2, rotY: 0 },
        { itemInstanceId: lampA.itemInstanceId, x: 2, z: 2, rotY: 0 },
      ],
    });
    expect(dup.status).toBe(409);
    expect(errCode(dup.body)).toBe('ITEM_ALREADY_PLACED');
    const foreign = await call(other, 'PUT', `/v1/homes/${homeId}/placements`, { placements: [] });
    expect(foreign.status).toBe(403);
    expect(errCode(foreign.body)).toBe('NOT_HOME_OWNER');
    const stolen = await call(other, 'PUT', `/v1/homes/${homeId}/placements`, {
      placements: [{ itemInstanceId: lampA.itemInstanceId, x: 0, z: 0, rotY: 0 }],
    });
    expect(stolen.status).toBe(403);
    expect(
      (await call(owner, 'PUT', `/v1/homes/${homeId}/placements`, { placements: [{ x: 1 }] }))
        .status,
    ).toBe(400);
    expect(
      (await call(owner, 'PUT', `/v1/homes/home:nope/placements`, { placements: [] })).status,
    ).toBe(404);

    // Visitors: a stranger is refused, a guest reads them.
    const refused = await call(guest, 'GET', `/v1/homes/${homeId}/placements`);
    expect(refused.status).toBe(403);
    expect(errCode(refused.body)).toBe('FORBIDDEN');
    expect((await call(owner, 'POST', `/v1/homes/${homeId}/guests/${guest.sub}`)).status).toBe(200);
    const seen = await call(guest, 'GET', `/v1/homes/${homeId}/placements`);
    expect(seen.status).toBe(200);
    expect((seen.body.placements as unknown[]).length).toBe(2);
    expect((await call(owner, 'GET', `/v1/homes/${homeId}/placements`)).status).toBe(200);
    expect((await call(owner, 'GET', `/v1/homes/home:nope/placements`)).status).toBe(404);

    await cleanup();
  });
});
