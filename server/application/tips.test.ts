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
    expect(Number(aliceBal.rows[0]?.cash_cents)).toBe(99000); // pays the full amount
    const bobBal = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [bob],
    );
    expect(Number(bobBal.rows[0]?.cash_cents)).toBe(970); // 1000 minus the 3% fee
    expect(tip).toMatchObject({ amountCents: 1000, feeCents: 30, receivedCents: 970 });
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

describe('tip fee (burned)', () => {
  const cash = async (id: string): Promise<number> =>
    Number(
      (await pool.query(`SELECT cash_cents FROM balances WHERE user_id = $1`, [id])).rows[0]
        .cash_cents,
    );
  const ledgerOf = async (id: string, tipId: string): Promise<Array<[string, number]>> =>
    (
      await pool.query(
        `SELECT reason, delta_cents FROM ledger_entries WHERE user_id = $1 AND ref_id = $2 ORDER BY id`,
        [id, tipId],
      )
    ).rows.map((r) => [r.reason, Number(r.delta_cents)]);

  it('computes ceil(bps) with a 1 cent minimum', async () => {
    const { tipFeeCents } = await import('./tips.js');
    expect([2, 10, 33, 34, 100, 1000, 999_999].map((a) => tipFeeCents(a, 300))).toEqual([
      1, 1, 1, 2, 3, 30, 30_000,
    ]);
    expect(tipFeeCents(1000, 0)).toBe(0);
    expect(tipFeeCents(1000, 500)).toBe(50);
  });

  it('writes the burn as its own ledger row; the sender rows add up to the amount', async () => {
    const ctx = buildContext();
    const { sendCashTip } = await import('./tips.js');
    const tip = await sendCashTip(ctx, alice, bob, 1000, null);
    expect(await ledgerOf(alice, tip.tipId)).toEqual([
      ['tip_out', -970],
      ['tip_fee_burn', -30],
    ]);
    expect(await ledgerOf(bob, tip.tipId)).toEqual([['tip', 970]]);
    // nobody is credited the fee: the economy lost 30 cents
    expect((await cash(alice)) + (await cash(bob))).toBe(100000 - 30);
    const stored = await pool.query(`SELECT fee_cents FROM tips WHERE tip_id = $1`, [tip.tipId]);
    expect(Number(stored.rows[0].fee_cents)).toBe(30);
  });

  it('rounds the fee up and refuses a tip the fee would swallow', async () => {
    const ctx = buildContext();
    const { sendCashTip } = await import('./tips.js');
    const t = await sendCashTip(ctx, alice, bob, 34, null);
    expect(t).toMatchObject({ feeCents: 2, receivedCents: 32 });
    await expect(sendCashTip(ctx, alice, bob, 1, null)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await cash(alice)).toBe(100000 - 34);
  });

  it('a two-account ping-pong loses Cash every round', async () => {
    const ctx = buildContext();
    const { sendCashTip } = await import('./tips.js');
    let before = (await cash(alice)) + (await cash(bob));
    await pool.query(`UPDATE balances SET cash_cents = 50000 WHERE user_id = $1`, [bob]);
    before = (await cash(alice)) + (await cash(bob));
    let total = before;
    for (let round = 0; round < 6; round++) {
      const [from, to] = round % 2 === 0 ? [alice, bob] : [bob, alice];
      await sendCashTip(ctx, from, to, 10_000, null);
      const now = (await cash(alice)) + (await cash(bob));
      expect(now, `round ${round}`).toBeLessThan(total);
      total = now;
    }
    expect(before - total).toBe(6 * 300);
  });

  it('concurrent tips from one sender never overspend and each pays its own fee', async () => {
    const ctx = buildContext();
    const { sendCashTip } = await import('./tips.js');
    await pool.query(`UPDATE balances SET cash_cents = 2500 WHERE user_id = $1`, [alice]);
    const res = await Promise.allSettled(
      Array.from({ length: 5 }, () => sendCashTip(ctx, alice, bob, 1000, null)),
    );
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2); // 2 x 1000 fits in 2500, a third does not
    expect(await cash(alice)).toBe(500);
    expect(await cash(bob)).toBe(2 * 970);
    const burned = await pool.query(
      `SELECT COALESCE(-SUM(delta_cents),0) AS n FROM ledger_entries
        WHERE user_id = $1 AND reason = 'tip_fee_burn' AND created_at > now() - interval '1 minute'`,
      [alice],
    );
    expect(Number(burned.rows[0].n)).toBeGreaterThanOrEqual(60);
  });
});
