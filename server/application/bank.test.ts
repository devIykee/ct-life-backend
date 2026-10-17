/**
 * Bank tests: debt repayment, cash history, the debt schedule, and the
 * live PnL on open perps.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { debtSchedule, listLedger, nextSundayUnlock, repayDebt } from './bank.js';
import { closePerp, listPerps, openPerp } from './perp-pit.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let user: string;

const balances = async (): Promise<{ cash: number; debt: number }> => {
  const r = await pool.query<{ cash_cents: string; debt_cents: string }>(
    `SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1`,
    [user],
  );
  return { cash: Number(r.rows[0]!.cash_cents), debt: Number(r.rows[0]!.debt_cents) };
};

const setBalances = (cash: number, debt: number): Promise<unknown> =>
  pool.query(`UPDATE balances SET cash_cents = $1, debt_cents = $2 WHERE user_id = $3`, [
    cash,
    debt,
    user,
  ]);

beforeAll(async () => {
  user = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [user, `bank-${user}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)`, [
    user,
  ]);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await setBalances(50_000, 72_000);
});

describe('repayDebt', () => {
  it('moves cash onto debt and books both ledger sides', async () => {
    const ctx = buildContext();
    const key = uuidv7();
    const out = await repayDebt(ctx, user, 12_000, key);
    expect(out).toEqual({ repaidCents: 12_000, cashCents: 38_000, debtCents: 60_000 });
    expect(await balances()).toEqual({ cash: 38_000, debt: 60_000 });
    const rows = await pool.query<{ account: string; delta_cents: string }>(
      `SELECT account, delta_cents FROM ledger_entries
       WHERE user_id = $1 AND reason = 'loan_repay' AND idempotency_ref LIKE $2
       ORDER BY account`,
      [user, `%${key}%`],
    );
    expect(rows.rows.map((r) => [r.account, Number(r.delta_cents)])).toEqual([
      ['cash', -12_000],
      ['debt', -12_000],
    ]);
  });

  it('caps an overpayment at the outstanding debt', async () => {
    const ctx = buildContext();
    await setBalances(100_000, 5_000);
    const out = await repayDebt(ctx, user, 20_000, uuidv7());
    expect(out).toEqual({ repaidCents: 5_000, cashCents: 95_000, debtCents: 0 });
  });

  it('replays the same key without paying twice', async () => {
    const ctx = buildContext();
    const key = uuidv7();
    await repayDebt(ctx, user, 10_000, key);
    const again = await repayDebt(ctx, user, 10_000, key);
    expect(again).toEqual({ repaidCents: 10_000, cashCents: 40_000, debtCents: 62_000 });
    expect(await balances()).toEqual({ cash: 40_000, debt: 62_000 });
  });

  it('refuses with INSUFFICIENT_CASH and moves nothing', async () => {
    const ctx = buildContext();
    await setBalances(1_000, 72_000);
    await expect(repayDebt(ctx, user, 12_000, uuidv7())).rejects.toMatchObject({
      code: 'INSUFFICIENT_CASH',
    });
    expect(await balances()).toEqual({ cash: 1_000, debt: 72_000 });
  });

  it('refuses with NOTHING_TO_REPAY when debt is zero', async () => {
    const ctx = buildContext();
    await setBalances(1_000, 0);
    await expect(repayDebt(ctx, user, 100, uuidv7())).rejects.toMatchObject({
      code: 'NOTHING_TO_REPAY',
      httpStatus: 409,
    });
  });
});

describe('debt schedule', () => {
  it('is due at the next Sunday 20:00 UTC', () => {
    // Fri 2026-10-16 -> Sun 2026-10-18 20:00
    expect(nextSundayUnlock(new Date('2026-10-16T12:00:00Z')).toISOString()).toBe(
      '2026-10-18T20:00:00.000Z',
    );
    // Sunday before the unlock -> same day
    expect(nextSundayUnlock(new Date('2026-10-18T19:59:59Z')).toISOString()).toBe(
      '2026-10-18T20:00:00.000Z',
    );
    // Exactly at / after the unlock -> next week
    expect(nextSundayUnlock(new Date('2026-10-18T20:00:00Z')).toISOString()).toBe(
      '2026-10-25T20:00:00.000Z',
    );
  });

  it('reports the weekly instalment, capped at what is owed, and null when debt-free', () => {
    const ctx = buildContext();
    const now = new Date('2026-10-16T12:00:00Z');
    expect(debtSchedule(ctx, 72_000, now)).toEqual({
      debtDueAt: '2026-10-18T20:00:00.000Z',
      debtWeeklyDueCents: 12_000,
    });
    expect(debtSchedule(ctx, 5_000, now).debtWeeklyDueCents).toBe(5_000);
    expect(debtSchedule(ctx, 0, now)).toEqual({ debtDueAt: null, debtWeeklyDueCents: null });
  });
});

describe('listLedger', () => {
  it('pages the cash history newest first with signed amounts', async () => {
    const ctx = buildContext();
    const pageUser = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
      pageUser,
      `ledger-${pageUser}`,
    ]);
    await pool.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason) VALUES
         ($1, 50000, 'cash', 'topup'),
         ($1, -18000, 'cash', 'rent'),
         ($1, 72000, 'debt', 'loan_disburse'),
         ($1, 0, 'cash', 'liq_pay'),
         ($1, 2500, 'cash', 'shift_pay')`,
      [pageUser],
    );

    const first = await listLedger(ctx, pageUser, null, 2);
    expect(first.items.map((i) => [i.kind, i.amountCents, i.label])).toEqual([
      ['shift_pay', 2500, 'Shift pay'],
      ['rent', -18000, 'Rent'],
    ]);
    expect(first.next).toBe(first.items[1]!.id);

    const second = await listLedger(ctx, pageUser, first.next, 2);
    // Debt-account and zero-amount rows are not cash history.
    expect(second.items.map((i) => i.kind)).toEqual(['topup']);
    expect(second.next).toBeNull();
  });
});

describe('perp live PnL', () => {
  it('reports unrealized PnL on open perps that matches the close', async () => {
    const ctx = buildContext();
    const coinId = uuidv7();
    await pool.query(
      `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
                          change_5m_bps, holders, launched_at, hidden_arc, seed)
       VALUES ($1, $2, 'PnL test', 'new', 1000000, 1000000, 0, 0, 0, now(), '{}', 1)`,
      [coinId, `P${coinId.slice(-6).toUpperCase()}`],
    );
    const perp = await openPerp(ctx, {
      userId: user,
      coinId,
      side: 'long',
      leverage: 1,
      marginCents: 10_000,
    });
    // +10%
    await pool.query(`UPDATE coins SET price_micros = 1100000 WHERE coin_id = $1`, [coinId]);

    const open = (await listPerps(ctx, user, 'open')).find((p) => p.perpId === perp.perpId)!;
    expect(open.markMicros).toBe('1100000');
    expect(open.unrealizedPnlCents).toBe('1000');

    const closed = await closePerp(ctx, user, perp.perpId);
    expect(closed.realizedCents).toBe(open.unrealizedPnlCents);

    const after = (await listPerps(ctx, user, 'closed')).find((p) => p.perpId === perp.perpId)!;
    expect(after.unrealizedPnlCents).toBeUndefined();
  });
});
