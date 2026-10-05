/**
 * Alpha + predictions trust-score edge cases.
 *
 * The trust score with zero resolved calls must return
 * hitRate=0 (not NaN). The prediction horizon math
 * (closes_at > created_at) is enforced at the DB layer
 * (verified in pnpm db:verify).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { buildContext, _resetContextForTests } from './context.js';
import { evaluateAlphaCalls, getTrustScore, placeAlphaCall } from './alpha.js';
import { placePrediction } from './predictions.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://ctlife:ctlife@localhost:5434/ctlife';

let pg: Client;
let testUserId: string;
let testCoinId: string;

async function ensureUserAndCoin(): Promise<void> {
  const wallet = `TrustTest${Date.now().toString().padStart(20, '0')}`;
  const userId = `00000000-0000-7000-8000-${Math.floor(Math.random() * 1e12)
    .toString()
    .padStart(12, '0')}`;
  await pg.query(`INSERT INTO users (id, wallet) VALUES ($1, $2) ON CONFLICT (wallet) DO NOTHING`, [
    userId,
    wallet,
  ]);
  testUserId = userId;
  if (testCoinId === undefined) {
    const coinId = `00000000-0000-7000-8000-${Math.floor(Math.random() * 1e12)
      .toString()
      .padStart(12, '0')}`;
    await pg.query(
      `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents, change_5m_bps, holders, launched_at, hidden_arc, seed)
       VALUES ($1, $2, $3, 'new', 1000000, 100000000, 0, 0, 0, now(), '{"outcome":"sideways","slopeBps":0,"noiseBps":0,"drawdownBps":0}', 1)
       ON CONFLICT (ticker) DO NOTHING`,
      [
        coinId,
        `TRUST${Math.floor(Math.random() * 1e6)
          .toString()
          .padStart(6, '0')}`,
        'TRUST',
      ],
    );
    testCoinId = coinId;
  }
}

beforeAll(async () => {
  pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  // Force a fresh context so it picks up .env.
  _resetContextForTests();
  buildContext();
});

afterAll(async () => {
  await pg.end();
});

beforeEach(async () => {
  await ensureUserAndCoin();
});

describe('Trust score edge cases', () => {
  it('returns 0 hitRate for a user with zero resolved calls', async () => {
    const score = await getTrustScore(buildContext(), testUserId);
    expect(score.hitRate).toBe(0);
    expect(Number.isFinite(score.hitRate)).toBe(true);
  });

  it('hitRate counts only resolved calls (not open)', async () => {
    const ctx = buildContext();
    // Place one open call.
    await placeAlphaCall(ctx, {
      userId: testUserId,
      coinId: testCoinId,
      entryMicros: '1000000',
      targetMicros: '2000000',
      stopMicros: '500000',
    });
    const score = await getTrustScore(ctx, testUserId);
    expect(score.hitRate).toBe(0); // no resolved yet
  });
});

describe('Alpha call evaluation', () => {
  it('does not throw on empty work set', async () => {
    const ctx = buildContext();
    const n = await evaluateAlphaCalls(ctx);
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe('Prediction horizon', () => {
  it('rejects zero or negative stake', async () => {
    const ctx = buildContext();
    await expect(
      placePrediction(ctx, {
        userId: testUserId,
        outcomeId: 'btc-24h-up',
        stakeCents: 0,
        horizon: '5m',
      }),
    ).rejects.toThrow();
    await expect(
      placePrediction(ctx, {
        userId: testUserId,
        outcomeId: 'btc-24h-up',
        stakeCents: -100,
        horizon: '5m',
      }),
    ).rejects.toThrow();
  });
});
