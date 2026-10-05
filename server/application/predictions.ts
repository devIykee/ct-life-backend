/**
 * Prediction Pit.
 *
 * Binary bets at 5m/15m/1h/daily horizons. Endpoints:
 *
 *   POST /v1/predictions            — place a bet
 *   GET  /v1/predictions?status=   — list the user's bets
 *
 * The current market list is a Redis sorted set
 * (predictions:active:<horizon>) seeded from
 * contract/config/predictions.json. The M3 smoke seeds a
 * single canned market 'BTC 24h > 0?'.
 *
 * On `closes_at` the worker resolves:
 *   - correct       → 2x stake credited via ledger (status='won')
 *   - incorrect     → stake forfeit; status='lost'
 *   - cancelled     → stake refunded; status='cancelled'
 *
 * The 'house' is the burning of the loser's stake. The worker
 * runs every 5 s and resolves all open predictions whose
 * closes_at is in the past.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { InsufficientCashError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type Horizon = '5m' | '15m' | '1h' | 'daily';
export type PredictionStatus = 'open' | 'won' | 'lost' | 'cancelled';

export interface PredictionInput {
  readonly userId: string;
  readonly outcomeId: string;
  readonly stakeCents: number;
  readonly horizon: Horizon;
}

export interface PredictionRow {
  readonly predictionId: string;
  readonly outcomeId: string;
  readonly stakeCents: string;
  readonly status: PredictionStatus;
  readonly horizon: Horizon;
  readonly closesAt: string;
  readonly createdAt: string;
}

const HORIZON_SECONDS: Record<Horizon, number> = {
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  daily: 24 * 60 * 60,
};

const ACTIVE_KEY = (horizon: Horizon): string => `predictions:active:${horizon}`;

/**
 * Place a prediction. Debits cash via ledger and writes a
 * predictions row.
 */
export async function placePrediction(
  ctx: AppContext,
  input: PredictionInput,
): Promise<PredictionRow> {
  if (input.stakeCents <= 0) {
    throw new ValidationFailedError({ reason: 'stakeCents must be > 0' });
  }
  const horizonSec = HORIZON_SECONDS[input.horizon];
  if (horizonSec === undefined) {
    throw new ValidationFailedError({ horizon: input.horizon });
  }
  const closesAt = new Date(Date.now() + horizonSec * 1000);
  const predictionId = uuidv7();
  return runInTransaction(async (client) => {
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [input.userId],
    );
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(input.stakeCents)) {
      throw new InsufficientCashError({
        have: cash.toString(),
        need: input.stakeCents.toString(),
      });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [input.stakeCents, input.userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'prediction', 'prediction', $3, $4)`,
      [input.userId, -input.stakeCents, predictionId, `pred:${predictionId}`],
    );
    await client.query(
      `INSERT INTO predictions
       (prediction_id, user_id, outcome_id, stake_cents, status, horizon, closes_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $6)`,
      [
        predictionId,
        input.userId,
        input.outcomeId,
        input.stakeCents,
        input.horizon,
        closesAt.toISOString(),
      ],
    );
    // Track in the active set for the worker.
    await ctx.redis.main.zadd(ACTIVE_KEY(input.horizon), closesAt.getTime(), predictionId);
    return {
      predictionId,
      outcomeId: input.outcomeId,
      stakeCents: input.stakeCents.toString(),
      status: 'open',
      horizon: input.horizon,
      closesAt: closesAt.toISOString(),
      createdAt: new Date().toISOString(),
    };
  });
}

/**
 * Resolve all open predictions whose closes_at is in the past.
 * The "house" is the burning of the loser's stake; the
 * winner gets 2x stake back. The M3 dev path uses a coin-flip
 * resolver for the canned 'BTC 24h > 0?' market.
 */
export async function resolveClosedPredictions(ctx: AppContext): Promise<number> {
  let resolved = 0;
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      prediction_id: string;
      user_id: string;
      stake_cents: string;
      outcome_id: string;
      horizon: Horizon;
    }>(
      `SELECT prediction_id, user_id, stake_cents, outcome_id, horizon
       FROM predictions
       WHERE status = 'open' AND closes_at <= now()
       LIMIT 500`,
    );
  });
  for (const row of r.rows) {
    const correct = await resolveOutcome(ctx, row.outcome_id);
    await runInTransaction(async (client) => {
      if (correct) {
        // 2x stake back.
        const payout = BigInt(row.stake_cents) * 2n;
        await client.query(
          `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
          [row.user_id, payout.toString()],
        );
        await client.query(
          `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
           VALUES ($1, $2, 'cash', 'prediction_payout', 'prediction', $3, $4)`,
          [row.user_id, payout.toString(), row.prediction_id, `pred-payout:${row.prediction_id}`],
        );
        await client.query(`UPDATE predictions SET status = 'won' WHERE prediction_id = $1`, [
          row.prediction_id,
        ]);
      } else {
        // Loser; stake forfeit (no payout).
        await client.query(`UPDATE predictions SET status = 'lost' WHERE prediction_id = $1`, [
          row.prediction_id,
        ]);
      }
    });
    await ctx.redis.main.zrem(ACTIVE_KEY(row.horizon), row.prediction_id);
    resolved++;
  }
  return resolved;
}

async function resolveOutcome(_ctx: AppContext, outcomeId: string): Promise<boolean> {
  // The M3 dev path: the canned 'BTC 24h > 0?' market flips
  // every minute. Production: a Pyth / CoinGecko check.
  if (outcomeId === 'btc-24h-up') {
    return Math.floor(Date.now() / 60_000) % 2 === 0;
  }
  return false;
}

/**
 * List the user's predictions. Optional status filter.
 */
export async function listPredictions(
  ctx: AppContext,
  userId: string,
  status: PredictionStatus | null,
): Promise<PredictionRow[]> {
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (status !== null) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      prediction_id: string;
      outcome_id: string;
      stake_cents: string;
      status: PredictionStatus;
      horizon: Horizon;
      closes_at: Date;
      created_at: Date;
    }>(
      `SELECT prediction_id, outcome_id, stake_cents, status, horizon, closes_at, created_at
       FROM predictions
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT 200`,
      params,
    );
  });
  return r.rows.map((row) => ({
    predictionId: row.prediction_id,
    outcomeId: row.outcome_id,
    stakeCents: row.stake_cents,
    status: row.status,
    horizon: row.horizon,
    closesAt: row.closes_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }));
}
