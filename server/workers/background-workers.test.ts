/**
 * The five sweeps that were in the repo but never started (liquidation,
 * prediction resolution, alpha grading, payment poller, weekly rent), run
 * through their BullMQ handlers against the real test Postgres and Redis.
 *
 * Each case also runs the sweep a second time, or two at once, the way a
 * second replica or an overlapping tick would, and checks nothing is
 * applied twice.
 */
import { Pool } from 'pg';
import type { Job } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests, type AppContext } from '../application/context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { HeliusClient } from '../shared/solana/helius.js';
import { handleLiquidation } from './liquidation.js';
import { handlePredictions } from './predictions.js';
import { handleAlphaGrading } from './alpha.js';
import { placeAlphaCall } from '../application/alpha.js';
import { loadConfig } from '../shared/config/config.js';
import { handlePaymentPoller } from './payment-poller.js';
import { rentWeekKey, runWeeklyRent } from './rent.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const job = {} as Job;
const homes: string[] = [];

afterAll(async () => {
  if (homes.length > 0) await pool.query(`DELETE FROM homes WHERE home_id = ANY($1)`, [homes]);
  await pool.end();
});

async function newUser(cashCents: number): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `bgw-${id}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)`, [
    id,
    cashCents,
  ]);
  return id;
}

async function newCoin(priceMicros: number): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, launched_at, hidden_arc, seed)
     VALUES ($1, $2, 'Sweep Test', 'new', $3, 0, now(), '{}', 1)`,
    [id, `W${id.slice(-7)}`, priceMicros],
  );
  return id;
}

async function balance(userId: string): Promise<{ cash: number; debt: number }> {
  const r = await pool.query<{ cash_cents: string; debt_cents: string }>(
    `SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return { cash: Number(r.rows[0]!.cash_cents), debt: Number(r.rows[0]!.debt_cents) };
}

describe('liquidation sweep', () => {
  it('liquidates only perps whose liquidation price was crossed, once', async () => {
    const user = await newUser(0);
    const coin = await newCoin(400_000);
    const perp = async (side: string, liq: number): Promise<string> => {
      const id = uuidv7();
      await pool.query(
        `INSERT INTO perps (perp_id, user_id, coin_id, side, leverage, margin_cents, entry_micros, liq_micros, status)
         VALUES ($1, $2, $3, $4, 2, 1000, 1000000, $5, 'open')`,
        [id, user, coin, side, liq],
      );
      return id;
    };
    const longCrossed = await perp('long', 500_000); // price 0.4 <= liq 0.5
    const shortCrossed = await perp('short', 300_000); // price 0.4 >= liq 0.3
    const longSafe = await perp('long', 200_000);
    const shortSafe = await perp('short', 900_000);

    await Promise.all([handleLiquidation(job, ctx), handleLiquidation(job, ctx)]);
    await handleLiquidation(job, ctx);

    const r = await pool.query<{ perp_id: string; status: string }>(
      `SELECT perp_id, status FROM perps WHERE user_id = $1`,
      [user],
    );
    const status = new Map(r.rows.map((x) => [x.perp_id, x.status]));
    expect(status.get(longCrossed)).toBe('liquidated');
    expect(status.get(shortCrossed)).toBe('liquidated');
    expect(status.get(longSafe)).toBe('open');
    expect(status.get(shortSafe)).toBe('open');
    const liq = await pool.query(
      `SELECT 1 FROM ledger_entries WHERE user_id = $1 AND reason = 'liq_pay'`,
      [user],
    );
    expect(liq.rowCount).toBe(2);
  });
});

describe('prediction resolution', () => {
  it('resolves closed predictions and pays a winner exactly once', async () => {
    const user = await newUser(0);
    // 'btc-24h-up' is the canned market (the dev resolver flips it each
    // minute); any other outcome id resolves as lost.
    const won = uuidv7();
    const lost = uuidv7();
    const open = uuidv7();
    const insert = (id: string, outcome: string, closes: string): Promise<unknown> =>
      pool.query(
        `INSERT INTO predictions (prediction_id, user_id, outcome_id, stake_cents, status, horizon, closes_at, created_at)
         VALUES ($1, $2, $3, 500, 'open', '5m', now() + $4::interval, now() - interval '10 minutes')`,
        [id, user, outcome, closes],
      );
    await insert(won, 'btc-24h-up', '-1 minute');
    await insert(lost, 'no-such-market', '-1 minute');
    await insert(open, 'btc-24h-up', '10 minutes');

    const [a, b] = await Promise.all([handlePredictions(job, ctx), handlePredictions(job, ctx)]);
    await handlePredictions(job, ctx);
    expect(a + b).toBeGreaterThanOrEqual(2);

    const r = await pool.query<{ prediction_id: string; status: string }>(
      `SELECT prediction_id, status FROM predictions WHERE user_id = $1`,
      [user],
    );
    const status = new Map(r.rows.map((x) => [x.prediction_id, x.status]));
    expect(status.get(lost)).toBe('lost');
    expect(status.get(open)).toBe('open');
    expect(['won', 'lost']).toContain(status.get(won));
    const payouts = await pool.query(
      `SELECT 1 FROM ledger_entries WHERE user_id = $1 AND reason = 'prediction_payout'`,
      [user],
    );
    const paid = status.get(won) === 'won' ? 1 : 0;
    expect(payouts.rowCount).toBe(paid);
    expect((await balance(user)).cash).toBe(paid * 1000);
  });
});

describe('alpha grading', () => {
  it('grades hit target and hit stop, leaves the rest open', async () => {
    const user = await newUser(0);
    const coin = await newCoin(1_500_000);
    const call = async (target: number, stop: number): Promise<string> => {
      const id = uuidv7();
      await pool.query(
        `INSERT INTO alpha_calls (call_id, user_id, coin_id, entry_micros, target_micros, stop_micros, status)
         VALUES ($1, $2, $3, 1000000, $4, $5, 'open')`,
        [id, user, coin, target, stop],
      );
      return id;
    };
    const hit = await call(1_200_000, 800_000);
    const stopped = await call(3_000_000, 1_600_000);
    const open = await call(2_000_000, 1_000_000);

    await Promise.all([handleAlphaGrading(job, ctx), handleAlphaGrading(job, ctx)]);

    const r = await pool.query<{ call_id: string; status: string }>(
      `SELECT call_id, status FROM alpha_calls WHERE user_id = $1`,
      [user],
    );
    const status = new Map(r.rows.map((x) => [x.call_id, x.status]));
    expect(status.get(hit)).toBe('hit_target');
    expect(status.get(stopped)).toBe('hit_stop');
    expect(status.get(open)).toBe('open');
  });
});

describe('alpha call placement', () => {
  it('stores the server price as entry and refuses a band the price is already outside', async () => {
    const user = await newUser(0);
    const coin = await newCoin(1_500_000);
    const call = (target: string, stop: string): ReturnType<typeof placeAlphaCall> =>
      placeAlphaCall(ctx, {
        userId: user,
        coinId: coin,
        entryMicros: '1',
        targetMicros: target,
        stopMicros: stop,
      });
    // The client claims an entry of 1 micro; the server records 1.5.
    const ok = await call('2000000', '1000000');
    expect(ok.entryMicros).toBe('1500000');
    const stored = await pool.query<{ entry_micros: string }>(
      `SELECT entry_micros FROM alpha_calls WHERE call_id = $1`,
      [ok.callId],
    );
    expect(stored.rows[0]!.entry_micros).toBe('1500000');
    // Target already reached / stop already hit: no instant grade.
    await expect(call('1200000', '800000')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'price_outside_band' },
    });
    await expect(call('3000000', '1600000')).rejects.toMatchObject({
      details: { reason: 'price_outside_band' },
    });
    await expect(
      placeAlphaCall(ctx, {
        userId: user,
        coinId: uuidv7(),
        entryMicros: '1',
        targetMicros: '2',
        stopMicros: '1',
      }),
    ).rejects.toMatchObject({ details: { reason: 'unknown_coin' } });
  });
});

describe('prediction settlement flag', () => {
  it('is off unless PREDICTIONS_SETTLEMENT_ENABLED is set', () => {
    const raw = (process.env.PREDICTIONS_SETTLEMENT_ENABLED ?? '').toLowerCase();
    if (!['1', 'true', 'yes', 'on'].includes(raw)) {
      expect(loadConfig().features.predictionSettlement).toBe(false);
    }
  });
});

describe('payment poller', () => {
  it('runs a full pass against a chain with nothing on it', async () => {
    const helius = {
      async rpc<T>(method: string): Promise<T> {
        if (method === 'getSignaturesForAddress') return [] as T;
        if (method === 'getTransaction') return null as T;
        throw new Error(`unexpected rpc ${method}`);
      },
    } as unknown as HeliusClient;
    const withFakeChain: AppContext = { ...ctx, helius };
    await expect(handlePaymentPoller(job, withFakeChain)).resolves.toBeUndefined();
  });
});

describe('weekly rent', () => {
  const MONDAY = new Date('2030-01-07T00:00:05.000Z');
  const week = (n: number): Date => new Date(MONDAY.getTime() + n * 7 * 86_400_000);

  async function newHome(owner: string, rent: number): Promise<string> {
    const id = `home:${uuidv7()}`;
    await pool.query(
      `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week) VALUES ($1, $2, 'studio', $3)`,
      [id, owner, rent],
    );
    homes.push(id);
    return id;
  }

  async function home(id: string): Promise<{ status: string; missed_weeks: number }> {
    const r = await pool.query<{ status: string; missed_weeks: number }>(
      `SELECT status, missed_weeks FROM homes WHERE home_id = $1`,
      [id],
    );
    return r.rows[0]!;
  }

  it('keys a run to the Monday (UTC) of its week', () => {
    expect(rentWeekKey(new Date('2026-10-26T00:00:00.000Z'))).toBe('2026-10-26');
    expect(rentWeekKey(new Date('2026-10-30T13:45:00.000Z'))).toBe('2026-10-26');
    expect(rentWeekKey(new Date('2026-11-01T23:59:59.999Z'))).toBe('2026-10-26');
    expect(rentWeekKey(new Date('2026-11-02T00:00:00.000Z'))).toBe('2026-11-02');
  });

  it('debits a paying home once per week, however many runs', async () => {
    const owner = await newUser(10_000);
    const id = await newHome(owner, 3_000);
    await Promise.all([runWeeklyRent(ctx.db, week(0)), runWeeklyRent(ctx.db, week(0))]);
    await runWeeklyRent(ctx.db, new Date(week(0).getTime() + 3 * 86_400_000)); // same week
    expect((await balance(owner)).cash).toBe(7_000);
    await runWeeklyRent(ctx.db, week(1));
    expect((await balance(owner)).cash).toBe(4_000);
    const rows = await pool.query(
      `SELECT 1 FROM ledger_entries WHERE ref_id = $1 AND reason = 'rent' AND delta_cents = -3000`,
      [id],
    );
    expect(rows.rowCount).toBe(2);
    expect(await home(id)).toEqual({ status: 'active', missed_weeks: 0 });
  });

  it('counts a missed week once per week, and evicts after four', async () => {
    const owner = await newUser(0);
    const id = await newHome(owner, 3_000);
    await runWeeklyRent(ctx.db, week(0));
    await runWeeklyRent(ctx.db, week(0));
    expect(await home(id)).toEqual({ status: 'overdue', missed_weeks: 1 });
    expect(await balance(owner)).toEqual({ cash: 0, debt: 3_000 });
    for (let n = 1; n <= 3; n++) await runWeeklyRent(ctx.db, week(n));
    expect(await home(id)).toEqual({ status: 'evicted', missed_weeks: 4 });
    expect(await balance(owner)).toEqual({ cash: 0, debt: 12_000 });
    // The zero-delta markers stay off the statement: no cash moved.
    const cash = await pool.query<{ s: string }>(
      `SELECT COALESCE(SUM(delta_cents), 0)::text AS s FROM ledger_entries WHERE ref_id = $1`,
      [id],
    );
    expect(cash.rows[0]!.s).toBe('0');
    // Evicted homes owe nothing more.
    await runWeeklyRent(ctx.db, week(4));
    expect(await balance(owner)).toEqual({ cash: 0, debt: 12_000 });
  });
});
