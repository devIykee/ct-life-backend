/**
 * Spot trade pricing: one unit convention (price_micros = micro-USD per base
 * unit) on both sides, so a small buy -> sell round trip passes a tight
 * slippage cap at any coin price.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { centsForUnits, executeTrade, quoteSpotTrade } from './terminal-cafe.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const DEPTH = 30_000_000n; // market.json curve.virtualReservesY
const FEE = 100n;

describe('quoteSpotTrade', () => {
  it.each([1n, 7n, 1_000n, 15_000n, 50_000n])(
    'round-trips a $10 trade at %s micros per unit',
    (priceMicros) => {
      const buy = quoteSpotTrade({
        side: 'buy',
        priceMicros,
        amountIn: 1_000n,
        depthCents: DEPTH,
        feeBps: FEE,
      });
      expect(buy.feeCents).toBe(10n);
      expect(buy.cashCents).toBe(1_000n);
      expect(buy.slippageBps).toBeLessThan(100n);
      // Units bought are worth about the net cash at the quote price.
      expect(centsForUnits(priceMicros, buy.units)).toBeGreaterThanOrEqual(980n);
      expect(centsForUnits(priceMicros, buy.units)).toBeLessThanOrEqual(990n);

      const sell = quoteSpotTrade({
        side: 'sell',
        priceMicros,
        amountIn: buy.units,
        depthCents: DEPTH,
        feeBps: FEE,
      });
      expect(sell.units).toBe(buy.units);
      expect(sell.slippageBps).toBeLessThan(100n);
      // Two 1% fees plus impact and whole-unit rounding: about $9.70-$9.80 back.
      expect(sell.cashCents).toBeGreaterThanOrEqual(965n);
      expect(sell.cashCents).toBeLessThanOrEqual(981n);
    },
  );

  it('still reports real slippage on a trade that moves the curve', () => {
    const q = quoteSpotTrade({
      side: 'buy',
      priceMicros: 1_000n,
      amountIn: 3_000_000n, // 10% of the curve's depth
      depthCents: DEPTH,
      feeBps: FEE,
    });
    expect(q.slippageBps).toBeGreaterThan(500n);
  });

  it('flags coarse fills at high unit prices instead of overcharging silently', () => {
    // $1 per base unit: $9.90 net fills 9 whole units, a ~10% worse price.
    const q = quoteSpotTrade({
      side: 'buy',
      priceMicros: 1_000_000n,
      amountIn: 1_000n,
      depthCents: DEPTH,
      feeBps: FEE,
    });
    expect(q.units).toBe(9n);
    expect(q.slippageBps).toBeGreaterThan(200n);
  });

  it('rejects a trade too small to fill', () => {
    expect(() =>
      quoteSpotTrade({
        side: 'sell',
        priceMicros: 1n,
        amountIn: 1n,
        depthCents: DEPTH,
        feeBps: FEE,
      }),
    ).toThrow();
  });
});

describe('executeTrade buy -> sell', () => {
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  const userId = uuidv7();
  const coinId = uuidv7();

  beforeAll(async () => {
    await pool.query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userId, `spot-${userId}`]);
    await pool.query(
      `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 100000, 0)`,
      [userId],
    );
    await pool.query(
      `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
                          change_5m_bps, holders, launched_at, hidden_arc, seed)
       VALUES ($1, $2, 'Spot test', 'new', 1000, 1000000, 0, 0, 0, now(), '{}', 1)`,
      [coinId, `S${coinId.slice(-6).toUpperCase()}`],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('sells exactly the bought units under a 200 bps cap and books the cash once', async () => {
    const ctx = buildContext();
    const buy = await executeTrade(ctx, {
      userId,
      coinId,
      side: 'buy',
      cashCents: 1_000,
      maxSlippageBps: 200,
    });
    expect(BigInt(buy.newUnits)).toBe(BigInt(buy.units));

    const sell = await executeTrade(ctx, {
      userId,
      coinId,
      side: 'sell',
      units: buy.units,
      maxSlippageBps: 200,
    });
    expect(sell.units).toBe(buy.units);
    expect(sell.newUnits).toBe('0');
    expect(BigInt(sell.cashCents)).toBeGreaterThanOrEqual(978n);
    // Realized = proceeds - the $10 cost basis.
    expect(BigInt(sell.realizedCents)).toBe(BigInt(sell.cashCents) - 1_000n);

    const bal = await pool.query<{ cash_cents: string }>(
      'SELECT cash_cents FROM balances WHERE user_id = $1',
      [userId],
    );
    expect(BigInt(bal.rows[0]!.cash_cents)).toBe(100_000n - 1_000n + BigInt(sell.cashCents));

    await expect(
      executeTrade(ctx, {
        userId,
        coinId,
        side: 'sell',
        units: '1000000',
        maxSlippageBps: 200,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CASH' });
  });
});
