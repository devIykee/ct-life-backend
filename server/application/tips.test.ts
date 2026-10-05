/**
 * Tips service tests.
 *
 * Covers cash tip happy path, on-chain pending row, list, and
 * the validation guards.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let alice: string;
let bob: string;

beforeAll(async () => {
  alice = uuidv7();
  bob = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2), ($3, $4)`, [
    alice,
    `tipAlice-${alice}`,
    bob,
    `tipBob-${bob}`,
  ]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000), ($2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = EXCLUDED.cash_cents`,
    [alice, bob],
  );
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`UPDATE balances SET cash_cents = 100000 WHERE user_id = $1`, [alice]);
  await pool.query(`UPDATE balances SET cash_cents = 0 WHERE user_id = $1`, [bob]);
});

describe('tips service', () => {
  it('sendCashTip credits bob and debits alice', async () => {
    const ctx = buildContext();
    const { sendCashTip } = await import('./tips.js');
    const tip = await sendCashTip(ctx, alice, bob, 1000, 'gm');
    expect(tip.kind).toBe('cash');
    expect(tip.status).toBe('confirmed');
    expect(Number(tip.amountCents)).toBe(1000);
    const aliceBal = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [alice],
    );
    expect(Number(aliceBal.rows[0]?.cash_cents)).toBe(99000);
    const bobBal = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [bob],
    );
    expect(Number(bobBal.rows[0]?.cash_cents)).toBe(1000);
  });

  it('sendCashTip refuses self-tip', async () => {
    const ctx = buildContext();
    const { sendCashTip } = await import('./tips.js');
    await expect(sendCashTip(ctx, alice, alice, 100, null)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('sendCashTip refuses when balance is insufficient', async () => {
    const ctx = buildContext();
    await pool.query(`UPDATE balances SET cash_cents = 0 WHERE user_id = $1`, [alice]);
    const { sendCashTip } = await import('./tips.js');
    await expect(sendCashTip(ctx, alice, bob, 100, null)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('recordOnchainTip persists a pending row', async () => {
    const ctx = buildContext();
    const { recordOnchainTip } = await import('./tips.js');
    const sig = `sig-${uuidv7()}`;
    const tip = await recordOnchainTip(ctx, alice, bob, sig, '1000000', null, null);
    expect(tip.kind).toBe('onchain');
    expect(tip.status).toBe('pending');
    expect(tip.signature).toBe(sig);
    expect(tip.amountLamports).toBe('1000000');
  });

  it('recordOnchainTip refuses duplicate signature', async () => {
    const ctx = buildContext();
    const { recordOnchainTip } = await import('./tips.js');
    const sig = `sig-dup-${uuidv7()}`;
    await recordOnchainTip(ctx, alice, bob, sig, '1000000', null, null);
    await expect(
      recordOnchainTip(ctx, alice, bob, sig, '1000000', null, null),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('listTipsTo returns recent tips to the user', async () => {
    const ctx = buildContext();
    const { sendCashTip, listTipsTo } = await import('./tips.js');
    await sendCashTip(ctx, alice, bob, 100, 'first');
    await sendCashTip(ctx, alice, bob, 200, 'second');
    const list = await listTipsTo(ctx, bob, 10);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]?.toUserId).toBe(bob);
  });
});
