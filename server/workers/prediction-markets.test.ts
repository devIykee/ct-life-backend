/**
 * The market generator fails closed: it opens nothing unless both
 * PREDICTIONS_SETTLEMENT_ENABLED and the `predict` capability are on.
 */
import type { Job } from 'bullmq';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests, type AppContext } from '../application/context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { handlePredictionMarkets } from './prediction-markets.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const base = buildContext();
const job = {} as Job;
// An hour in 2032, different per run.
const now = new Date(Date.UTC(2032, 0, 1) + Math.floor(Math.random() * 8000) * 3_600_000 + 2_000);
const coin = uuidv7();

function withFlags(settlement: boolean, predict: boolean): AppContext {
  return {
    ...base,
    config: {
      ...base.config,
      features: {
        ...base.config.features,
        predictionSettlement: settlement,
        predictionCryptoSource: 'off',
      },
      capabilities: { ...base.config.capabilities, on: new Set(predict ? ['predict'] : []) },
    },
  } as AppContext;
}

afterAll(async () => {
  await pool.query(`DELETE FROM prediction_markets WHERE opens_at = $1`, [now]);
  await pool.query(`DELETE FROM prediction_price_snapshots WHERE coin_id = $1`, [coin]);
  await pool.query(`DELETE FROM coins WHERE coin_id = $1`, [coin]);
  await pool.end();
});

describe('prediction market generator gate', () => {
  it('opens markets only with the settlement flag and the predict capability', async () => {
    await pool.query(
      `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
                          launched_at, hidden_arc, seed)
       VALUES ($1, $2, 'Gate Test', 'graduated', 1000, 1000, 8000000000000000, now(), '{}'::jsonb, 1)`,
      [coin, `GT${coin.slice(-6).toUpperCase()}`],
    );
    expect(await handlePredictionMarkets(job, withFlags(false, true), now)).toBe(0);
    expect(await handlePredictionMarkets(job, withFlags(true, false), now)).toBe(0);
    expect(await handlePredictionMarkets(job, withFlags(true, true), now)).toBeGreaterThan(0);
  });
});
