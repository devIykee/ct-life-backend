/**
 * PATCH /v1/characters/me/look and the Breakpoint handle DM over HTTP: auth,
 * the zod contract, idempotent replay, ownership, rate limit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';

loadDotenv({ path: process.cwd() + '/.env' });

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;
const db = createDb();

beforeAll(async () => {
  process.env.APP_ENV = process.env.APP_ENV ?? 'local';
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
  process.env.LOG_LEVEL = 'warn';
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}, 30_000);
afterAll(async () => {
  await stop();
}, 30_000);

interface U {
  sub: string;
  accessToken: string;
}
async function devAuth(): Promise<U> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `look-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  return { sub: b.id, accessToken: b.accessToken };
}
async function call(
  u: U,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
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

const BASE = {
  skinTone: 'skin_tone3',
  headId: 'head_ubc_m',
  hairId: 'hair_ubc_m',
  topId: 'top_ubc_m',
  bottomId: 'bottom_ubc_m',
  shoesId: 'shoes_ubc_m',
  accId: 'acc_none',
};
let n = 0;
async function makeCharacter(u: U): Promise<void> {
  await db.withConnection((c) =>
    c.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
       VALUES ($1, $2, $3, $4, 'degens', '{}', 'x', 'h')`,
      [uuidv7(), u.sub, `lr${Date.now().toString(36)}${n++}`, BASE],
    ),
  );
}
async function grantLanyard(u: U): Promise<void> {
  await db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO cosmetic_inventory (inventory_id, user_id, item_id, source)
       SELECT $1, $2, item_id, 'grant' FROM cosmetic_items WHERE item_key = 'lanyard_breakpoint_2026'
       ON CONFLICT DO NOTHING`,
      [uuidv7(), u.sub],
    );
  });
}

describe('PATCH /v1/characters/me/look', () => {
  it('needs a token and an idempotency key', async () => {
    const a = await app.inject({
      method: 'PATCH',
      url: '/v1/characters/me/look',
      payload: { accId: 'x' },
    });
    expect(a.statusCode).toBe(401);
    const u = await devAuth();
    const b = await app.inject({
      method: 'PATCH',
      url: '/v1/characters/me/look',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { accId: 'acc_none' },
    });
    expect(b.statusCode).toBe(400);
  });

  it('validates the body: at least one known field, no extras, strings only', async () => {
    const u = await devAuth();
    await makeCharacter(u);
    for (const body of [
      {},
      { nope: 'x' },
      { accId: 5 },
      { accId: '' },
      { accId: 'a', owner: 'me' },
    ]) {
      const r = await call(u, 'PATCH', '/v1/characters/me/look', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(errCode(r.body)).toBe('VALIDATION_FAILED');
    }
  });

  it('equips an owned lanyard; refuses before it is owned; replays are idempotent', async () => {
    const u = await devAuth();
    await makeCharacter(u);
    // The catalogue is created on first use of cosmetics; trigger it through the shop listing.
    expect((await call(u, 'GET', '/v1/shop')).status).toBe(200);
    const denied = await call(u, 'PATCH', '/v1/characters/me/look', {
      accId: 'lanyard_breakpoint_2026',
    });
    expect(denied.status).toBe(403);
    expect(errCode(denied.body)).toBe('ITEM_NOT_OWNED');
    await grantLanyard(u);
    const key = uuidv7();
    const ok = await call(
      u,
      'PATCH',
      '/v1/characters/me/look',
      { accId: 'lanyard_breakpoint_2026' },
      key,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      look: { ...BASE, accId: 'lanyard_breakpoint_2026' },
      tribeId: 'degens',
      homeId: 'h',
      likenessJobId: null,
    });
    const replay = await call(
      u,
      'PATCH',
      '/v1/characters/me/look',
      { accId: 'lanyard_breakpoint_2026' },
      key,
    );
    expect(replay.body).toEqual(ok.body);
    const me = await call(u, 'GET', '/v1/me');
    expect((me.body.character as { look: { accId: string } }).look.accId).toBe(
      'lanyard_breakpoint_2026',
    );
  });

  it('answers 404 for a player without a character', async () => {
    const u = await devAuth();
    const r = await call(u, 'PATCH', '/v1/characters/me/look', { accId: 'acc_none' });
    expect(r.status).toBe(404);
  });
});

describe('Breakpoint admin geofence and IRL DM routes', () => {
  it('rejects a bad geofence and unknown handles; admin needs the allowlist', async () => {
    const u = await devAuth();
    const admin = await call(u, 'PUT', '/v1/admin/events/breakpoint-2026', {
      geofence: { lat: 51.5, lng: -0.2, radiusM: 300, source: 'https://example.com' },
    });
    expect(admin.status).toBe(403);
    const dm = await call(u, 'POST', `/v1/events/breakpoint-2026/irl/${'A'.repeat(22)}/dm`, {
      text: 'hi',
    });
    expect(dm.status).toBe(403); // not checked in
    const badHandle = await call(u, 'POST', '/v1/events/breakpoint-2026/irl/not-a-handle/dm', {
      text: 'hi',
    });
    expect(badHandle.status).toBe(400);
    const badBody = await call(u, 'POST', `/v1/events/breakpoint-2026/irl/${'A'.repeat(22)}/dm`, {
      text: '',
    });
    expect(badBody.status).toBe(400);
  });
});
