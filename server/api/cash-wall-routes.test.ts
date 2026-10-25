/**
 * Cash: purchasable, non-transferable, no cash-out, no on-chain. Each refusal over HTTP.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { assertMintable } from '../application/nft-mint.js';
import { ensureCatalog } from '../application/cosmetics.js';
import { buildContext } from '../application/context.js';

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
    headers: { 'idempotency-key': `cw-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  const b = r.json() as { id: string; accessToken: string };
  return { sub: b.id, accessToken: b.accessToken };
}
async function call(u: U, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.accessToken}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': uuidv7() }),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
}
const cash = async (u: U): Promise<number> =>
  Number(
    (
      await db.withConnection((c) =>
        c.query(`SELECT COALESCE(SUM(cash_cents), 0) AS c FROM balances WHERE user_id = $1`, [
          u.sub,
        ]),
      )
    ).rows[0].c,
  );

describe('Cash tips', () => {
  it('POST /v1/tips is 410 CASH_NOT_TRANSFERABLE whatever the body, and moves nothing', async () => {
    const a = await devAuth();
    const b = await devAuth();
    await db.withConnection((c) =>
      c.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 5000) ON CONFLICT (user_id) DO UPDATE SET cash_cents = 5000`,
        [a.sub],
      ),
    );
    for (const payload of [
      { toUserId: b.sub, amountCents: 100 },
      { toUserId: b.sub, amountCents: 100, message: 'hi' },
      {},
    ]) {
      const r = await call(a, 'POST', '/v1/tips', payload);
      expect(r.status).toBe(410);
      expect(r.body.error.code).toBe('CASH_NOT_TRANSFERABLE');
    }
    expect(await cash(a)).toBe(5000);
    expect(await cash(b)).toBe(0);
    const noAuth = await app.inject({ method: 'POST', url: '/v1/tips', payload: {} });
    expect(noAuth.statusCode).toBe(401);
  });

  it('an on-chain tip note credits nobody', async () => {
    const a = await devAuth();
    const b = await devAuth();
    const r = await call(a, 'POST', '/v1/tips/onchain', {
      toUserId: b.sub,
      signature: `sig-${uuidv7()}-${uuidv7()}`,
      amountLamports: '1000000',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ kind: 'onchain', status: 'pending' });
    expect(await cash(a)).toBe(0);
    expect(await cash(b)).toBe(0);
  });
});

describe('NFT mint', () => {
  it('a Cash-bought item is refused with 403 NFT_MINT_NOT_ALLOWED', async () => {
    const u = await devAuth();
    await ensureCatalog(buildContext());
    const item = await db.withConnection((c) =>
      c.query<{ item_id: string }>(
        `SELECT item_id FROM cosmetic_items WHERE item_key = 'top_hoodie_black'`,
      ),
    );
    const itemId = item.rows[0]!.item_id;
    await db.withConnection((c) =>
      c.query(
        `INSERT INTO cosmetic_inventory (inventory_id, user_id, item_id, source) VALUES ($1, $2, $3, 'shop')`,
        [uuidv7(), u.sub, itemId],
      ),
    );
    const r = await call(u, 'POST', '/v1/nft/mint', { itemId });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NFT_MINT_NOT_ALLOWED');
    expect(r.body.error.details.reason).toBe('bought_with_cash');
    const minted = await db.withConnection((c) =>
      c.query(`SELECT 1 FROM nft_mints WHERE user_id = $1`, [u.sub]),
    );
    expect(minted.rowCount).toBe(0);
  });

  it('an item earned in the game is refused too', async () => {
    const u = await devAuth();
    const item = await db.withConnection((c) =>
      c.query<{ item_id: string }>(
        `SELECT item_id FROM cosmetic_items WHERE item_key = 'lanyard_breakpoint_2026'`,
      ),
    );
    const itemId = item.rows[0]!.item_id;
    await db.withConnection((c) =>
      c.query(
        `INSERT INTO cosmetic_inventory (inventory_id, user_id, item_id, source) VALUES ($1, $2, $3, 'grant')`,
        [uuidv7(), u.sub, itemId],
      ),
    );
    const r = await call(u, 'POST', '/v1/nft/mint', { itemId });
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe('earned_in_game');
  });

  it('the guard lets only an on-chain acquisition through (a future swap must use it)', () => {
    expect(() => assertMintable('shop', 'x')).toThrow(/not acquired on-chain/);
    expect(() => assertMintable('grant', 'x')).toThrow();
    expect(() => assertMintable('mint', 'x')).not.toThrow();
  });
});

describe('no path turns real money into another player Cash', () => {
  // Cash may be credited to a player only for their OWN top-up, their own play, or a reward.
  // These two settlement paths must never write Cash for the call's payee or payer.
  const noCashWrites = (file: string): void => {
    const src = readFileSync(file, 'utf8');
    // The settle code must not touch balances or write ledger rows of its own.
    const settle = src.slice(src.indexOf("status = 'settled'"));
    expect(settle).not.toMatch(/INSERT INTO balances/);
    expect(settle).not.toMatch(/UPDATE balances/);
    expect(settle).not.toMatch(/INSERT INTO ledger_entries/);
  };
  it('paid-call settlement (off-chain math and the program webhook) writes no Cash', () => {
    noCashWrites('server/application/paid-calls.ts');
    noCashWrites('server/application/program-webhook.ts');
  });
});
