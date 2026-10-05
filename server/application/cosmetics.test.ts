/**
 * Cosmetics service tests.
 *
 * Covers the shop listing (slot filter), Cash purchase (debits
 * 'cosmetic' ledger row, appends cosmetic_inventory),
 * inventory listing, the daily purchase cap, the
 * already-owned idempotency, the onchain-only refusal, and
 * the insufficient-cash refusal.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ValidationFailedError, NotFoundError } from '../shared/domain/errors.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let userId: string;

beforeAll(async () => {
  userId = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
    userId,
    `cosmeticUser-${userId}`,
  ]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 1000000, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = 1000000, debt_cents = 0`,
    [userId],
  );
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM cosmetic_inventory WHERE user_id = $1`, [userId]);
  await pool.query(`UPDATE balances SET cash_cents = 1000000, debt_cents = 0 WHERE user_id = $1`, [
    userId,
  ]);
});

describe('cosmetics service', () => {
  it('listShop seeds the catalog and returns items by slot', async () => {
    const ctx = buildContext();
    const { listShop } = await import('./cosmetics.js');
    const all = await listShop(ctx, null);
    expect(all.length).toBeGreaterThan(0);
    const tops = await listShop(ctx, 'top');
    expect(tops.every((t) => t.slot === 'top')).toBe(true);
    expect(tops.length).toBeGreaterThan(0);
  });

  it('purchase debits cash, writes ledger row, appends inventory', async () => {
    const ctx = buildContext();
    const { listShop, purchase } = await import('./cosmetics.js');
    const shop = await listShop(ctx, 'top');
    const item = shop.find((s) => !s.onchainOnly);
    expect(item).toBeDefined();
    const before = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [userId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    const out = await purchase(ctx, userId, item!.itemId);
    expect(out.itemId).toBe(item!.itemId);
    expect(out.source).toBe('shop');
    const after = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [userId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    expect(after).toBe(before - item!.priceCents);
    const led = await pool.query<{ reason: string; delta_cents: string }>(
      `SELECT reason, delta_cents FROM ledger_entries
       WHERE user_id = $1 AND reason = 'cosmetic' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(led.rows[0]?.reason).toBe('cosmetic');
    expect(Number(led.rows[0]?.delta_cents)).toBe(-item!.priceCents);
  });

  it('listInventory returns the user-owned cosmetics newest first', async () => {
    const ctx = buildContext();
    const { listShop, purchase, listInventory } = await import('./cosmetics.js');
    const tops = await listShop(ctx, 'top');
    const item1 = tops.find((t) => !t.onchainOnly)!;
    const item2 = tops.filter((t) => !t.onchainOnly)[1]!;
    await purchase(ctx, userId, item1.itemId);
    await purchase(ctx, userId, item2.itemId);
    const inv = await listInventory(ctx, userId);
    expect(inv.length).toBeGreaterThanOrEqual(2);
    expect(inv[0]!.acquiredAt >= inv[1]!.acquiredAt).toBe(true);
  });

  it('re-purchasing an already-owned item is idempotent (no double debit)', async () => {
    const ctx = buildContext();
    const { listShop, purchase } = await import('./cosmetics.js');
    const tops = await listShop(ctx, 'top');
    const item = tops.find((t) => !t.onchainOnly)!;
    const before = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [userId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    await purchase(ctx, userId, item.itemId);
    const afterFirst = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [userId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    const replay = await purchase(ctx, userId, item.itemId);
    expect(replay.itemId).toBe(item.itemId);
    const afterReplay = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [userId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    expect(afterReplay).toBe(afterFirst);
    expect(afterFirst).toBe(before - item.priceCents);
  });

  it('onchain-only item refuses the Cash purchase path', async () => {
    const ctx = buildContext();
    const { listShop, purchase } = await import('./cosmetics.js');
    const all = await listShop(ctx, null);
    const onchain = all.find((i) => i.onchainOnly);
    expect(onchain).toBeDefined();
    await expect(purchase(ctx, userId, onchain!.itemId)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('insufficient cash refuses the purchase', async () => {
    const ctx = buildContext();
    const { listShop, purchase } = await import('./cosmetics.js');
    await pool.query(`UPDATE balances SET cash_cents = 0 WHERE user_id = $1`, [userId]);
    const tops = await listShop(ctx, 'top');
    const item = tops.find((t) => !t.onchainOnly && t.priceCents > 0)!;
    await expect(purchase(ctx, userId, item.itemId)).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('daily cap refuses the 6th purchase in a day', async () => {
    const ctx = buildContext();
    const { listShop, purchase } = await import('./cosmetics.js');
    const all = await listShop(ctx, null);
    const buyable = all.filter((t) => !t.onchainOnly && t.priceCents > 0);
    // Pad cash so cap, not cash, is the limit.
    await pool.query(`UPDATE balances SET cash_cents = 10000000 WHERE user_id = $1`, [userId]);
    expect(buyable.length).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < 5; i++) {
      await purchase(ctx, userId, buyable[i]!.itemId);
    }
    await expect(purchase(ctx, userId, buyable[5]!.itemId)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('unknown itemId raises NotFoundError', async () => {
    const ctx = buildContext();
    const { purchase } = await import('./cosmetics.js');
    await expect(purchase(ctx, userId, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });
});
