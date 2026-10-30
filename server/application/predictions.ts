/**
 * Prediction Pit bets (unlock D3, app capability `predict`).
 *
 *   POST /v1/predictions/markets/{marketId}/bets {outcomeId, stakeCents}
 *   GET  /v1/predictions?status=          the caller's bets (unwrapped array)
 *   POST /v1/predictions                  410 GONE (use market bets)
 *
 * A bet names a server market (prediction-markets.ts) and one of its
 * outcomes; anything else is refused. House-banked fixed odds: the stake is
 * debited now, a win pays stake x payoutBps / 10000 from the house, a loss
 * pays nothing. Cash never moves between players. Play money only: Cash
 * cannot be withdrawn (docs/ECONOMY.md).
 *
 * Limits: the market's min/max stake, a daily stake cap per player (UTC day,
 * predictions.json `dailyStakeCapCents`), the 18+ confirmation the casino and
 * the Factory use, not being in Jail (route preHandler), and the bet window
 * (`closesAt`). Sim and event outcomes are sealed commit-reveal draws, so no
 * public data decides them before `resolvesAt`.
 *
 * Resolution and payouts: prediction-resolver.ts (workers only, behind
 * PREDICTIONS_SETTLEMENT_ENABLED).
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  AgeRequiredError,
  ConflictError,
  InsufficientCashError,
  NotFoundError,
  RateLimitedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { recordQuestEvent } from './quests.js';
import type { AppContext } from './context.js';
import { predictionsConfig, type Horizon } from './prediction-config.js';
import { MARKET_COLUMNS, type MarketRow } from './prediction-markets.js';
import { resolveDueMarkets, settleBets } from './prediction-resolver.js';
import type { ReferencePriceSource } from './price-source.js';

export type { Horizon } from './prediction-config.js';
export type PredictionStatus = 'open' | 'won' | 'lost' | 'cancelled';

export interface BetInput {
  readonly userId: string;
  readonly marketId: string;
  readonly outcomeId: string;
  readonly stakeCents: number;
}

export interface BetReceipt {
  readonly predictionId: string;
  readonly marketId: string;
  readonly outcomeId: string;
  readonly stakeCents: number;
  readonly potentialPayoutCents: number;
  readonly status: 'open';
  readonly closesAt: string;
  readonly createdAt: string;
}

export interface PredictionRow {
  readonly predictionId: string;
  readonly outcomeId: string;
  readonly stakeCents: string;
  readonly status: PredictionStatus;
  readonly horizon: Horizon;
  readonly closesAt: string;
  readonly createdAt: string;
  readonly marketId: string | null;
  readonly questionKey: string | null;
  readonly params: Record<string, string> | null;
  readonly resolvedOutcomeId: string | null;
  readonly payoutCents: number | null;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function loadBettableMarket(ctx: AppContext, input: BetInput, now: Date): Promise<MarketRow> {
  const r = await ctx.db.withConnection((c) =>
    c.query<MarketRow>(`SELECT ${MARKET_COLUMNS} FROM prediction_markets WHERE market_id = $1`, [
      input.marketId,
    ]),
  );
  const m = r.rows[0];
  if (!m) throw new NotFoundError({ resource: 'prediction_market', id: input.marketId });
  if (m.status !== 'open' || m.closes_at <= now) {
    throw new ConflictError({ reason: 'market_closed', closesAt: m.closes_at.toISOString() });
  }
  if (!m.outcomes.some((o) => o.outcomeId === input.outcomeId)) {
    throw new ValidationFailedError({ reason: 'unknown_outcome' });
  }
  const min = Number(m.min_stake_cents);
  const max = Number(m.max_stake_cents);
  if (input.stakeCents < min || input.stakeCents > max) {
    throw new ValidationFailedError({ reason: 'stake_out_of_range', min, max });
  }
  const age = await ctx.db.withConnection((c) =>
    c.query<{ age_confirmed_at: Date | null }>(
      `SELECT age_confirmed_at FROM characters WHERE user_id = $1`,
      [input.userId],
    ),
  );
  if (!age.rows[0]?.age_confirmed_at) throw new AgeRequiredError();
  return m;
}

/**
 * Place a bet on a market outcome. Debits the stake in the same transaction
 * that writes the bet; the balance row lock serializes the daily cap check.
 * @param ctx - The app context.
 * @param input - Who, which market and outcome, how much.
 * @param now - The current time.
 * @returns The receipt.
 */
export async function placeBet(
  ctx: AppContext,
  input: BetInput,
  now: Date = new Date(),
): Promise<BetReceipt> {
  const m = await loadBettableMarket(ctx, input, now);
  const cfg = predictionsConfig();
  const predictionId = uuidv7();
  const stake = BigInt(input.stakeCents);
  await runInTransaction(async (client) => {
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [input.userId],
    );
    const dayStart = utcDayStart(now);
    const used = await client.query<{ s: string }>(
      `SELECT COALESCE(sum(stake_cents), 0) AS s FROM predictions
        WHERE user_id = $1 AND market_id IS NOT NULL AND created_at >= $2`,
      [input.userId, dayStart],
    );
    const usedCents = BigInt(used.rows[0]?.s ?? '0');
    if (usedCents + stake > BigInt(cfg.dailyStakeCapCents)) {
      const resetAt = new Date(dayStart.getTime() + 86_400_000);
      throw new RateLimitedError(resetAt.getTime() - now.getTime(), {
        reason: 'daily_stake_cap',
        resetAt: resetAt.toISOString(),
        capCents: cfg.dailyStakeCapCents,
        usedCents: Number(usedCents),
      });
    }
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < stake) {
      throw new InsufficientCashError({ have: cash.toString(), need: stake.toString() });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [stake.toString(), input.userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'prediction', 'prediction', $3, $4)`,
      [input.userId, (-stake).toString(), predictionId, `pred:${predictionId}`],
    );
    await client.query(
      `INSERT INTO predictions
         (prediction_id, user_id, outcome_id, stake_cents, status, horizon, closes_at, created_at, market_id)
       VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8)`,
      [
        predictionId,
        input.userId,
        input.outcomeId,
        stake.toString(),
        m.horizon,
        m.resolves_at,
        now,
        m.market_id,
      ],
    );
  });
  await recordQuestEvent(ctx, input.userId, 'prediction_place', predictionId);
  return {
    predictionId,
    marketId: m.market_id,
    outcomeId: input.outcomeId,
    stakeCents: input.stakeCents,
    potentialPayoutCents: Number((stake * BigInt(m.payout_bps)) / 10_000n),
    status: 'open',
    closesAt: m.closes_at.toISOString(),
    createdAt: now.toISOString(),
  };
}

/**
 * The settlement sweep (workers, every 5 s, behind PREDICTIONS_SETTLEMENT_ENABLED):
 * resolve due markets from their recorded source values, then pay or refund
 * the bets on them (and refund legacy bets).
 * @param ctx - The app context.
 * @param source - The crypto reference source, or null when off.
 * @param now - The current time.
 * @returns How many bets were settled.
 */
export async function resolveClosedPredictions(
  ctx: AppContext,
  source: ReferencePriceSource | null = null,
  now: Date = new Date(),
): Promise<number> {
  await resolveDueMarkets(ctx, now, source);
  return settleBets(ctx, now);
}

/**
 * List the caller's bets, newest first, with the market's question and result.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param status - Optional status filter.
 * @returns Up to 200 bets.
 */
export async function listPredictions(
  ctx: AppContext,
  userId: string,
  status: PredictionStatus | null,
): Promise<PredictionRow[]> {
  const params: unknown[] = [userId];
  let where = 'p.user_id = $1';
  if (status !== null) {
    params.push(status);
    where += ` AND p.status = $${params.length}`;
  }
  const r = await ctx.db.withConnection((c) =>
    c.query<{
      prediction_id: string;
      outcome_id: string;
      stake_cents: string;
      status: PredictionStatus;
      horizon: Horizon;
      closes_at: Date;
      created_at: Date;
      market_id: string | null;
      question_key: string | null;
      params: Record<string, string> | null;
      resolved_outcome_id: string | null;
      payout_cents: string | null;
    }>(
      `SELECT p.prediction_id, p.outcome_id, p.stake_cents, p.status, p.horizon, p.closes_at,
              p.created_at, p.market_id, m.question_key, m.params, m.resolved_outcome_id,
              p.payout_cents
         FROM predictions p
         LEFT JOIN prediction_markets m ON m.market_id = p.market_id
        WHERE ${where}
        ORDER BY p.created_at DESC
        LIMIT 200`,
      params,
    ),
  );
  return r.rows.map((row) => ({
    predictionId: row.prediction_id,
    outcomeId: row.outcome_id,
    stakeCents: row.stake_cents,
    status: row.status,
    horizon: row.horizon,
    closesAt: row.closes_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    marketId: row.market_id,
    questionKey: row.question_key,
    params: row.params,
    resolvedOutcomeId: row.resolved_outcome_id,
    payoutCents: row.payout_cents === null ? null : Number(row.payout_cents),
  }));
}
