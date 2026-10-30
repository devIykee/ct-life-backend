/**
 * Prediction Pit resolution and settlement (unlock D3). Replaces the M3
 * coin-flip `resolveOutcome`.
 *
 * Two steps, so an outcome is decided exactly once:
 *
 *   1. Resolve: for each market past `resolves_at`, read the source value at
 *      `resolves_at` and store it with the winning outcome in one conditional
 *      UPDATE (`resolved_value_micros`, `resolved_outcome_id`). A market whose
 *      source never answers within the grace period becomes `void`.
 *        - sim, event: a sealed commit-reveal draw (prediction-markets.ts).
 *                  The secret committed at open gives the outcome; it is
 *                  published with the result. A secret that does not match
 *                  its commitment voids the market (refund).
 *        - crypto: the close of the 1-minute candle that ends at `resolves_at`
 *                  from the reference source; void after `resolveGraceSec`.
 *   2. Settle: every open bet on a resolved or void market is claimed with a
 *      conditional status update, then paid: a win gets
 *      stake x payoutBps / 10000, a loss nothing, a void market the stake back
 *      (status `cancelled`). The player gets `prediction_settled`.
 *
 * Legacy bets (no market, from the retired POST /v1/predictions) are refunded
 * once their `closes_at` passes: the stub that "resolved" them is gone.
 *
 * Runs only in the workers process, only with PREDICTIONS_SETTLEMENT_ENABLED=1.
 * Cash only ever comes from the house (a faucet on a win, a sink on a loss);
 * it never moves between players.
 */
import { runInTransaction } from '../shared/db/uow.js';
import type { AppContext } from './context.js';
import { predictionsConfig } from './prediction-config.js';
import { MARKET_COLUMNS, commitmentOf, drawOutcome, type MarketRow } from './prediction-markets.js';
import type { ReferencePriceSource } from './price-source.js';
import { publishToUser } from './realtime-bus.js';

type Decision = { valueMicros: bigint; outcomeId: 'yes' | 'no' } | 'void' | 'wait';

const MINUTE_MS = 60_000;

function pastGrace(m: MarketRow, now: Date, graceSec: number): boolean {
  return now.getTime() - m.resolves_at.getTime() > graceSec * 1000;
}

/** A sealed draw (sim, event): reveal the committed secret's outcome. */
function decideDraw(m: MarketRow): Decision {
  const seed = m.basis.seed;
  // A sealed market without its secret cannot be settled honestly: refund.
  if (!seed || !m.basis.commitment || commitmentOf(seed) !== m.basis.commitment) return 'void';
  const outcomeId = drawOutcome(seed, m.market_id);
  return { valueMicros: outcomeId === 'yes' ? 1n : 0n, outcomeId };
}

async function decideCrypto(
  ctx: AppContext,
  m: MarketRow,
  now: Date,
  source: ReferencePriceSource | null,
): Promise<Decision> {
  const grace = predictionsConfig().resolveGraceSec;
  if (!source || source.ref !== m.source.ref) return pastGrace(m, now, grace) ? 'void' : 'wait';
  // Ask the source at most every 30 s per market, whatever the sweep rate.
  const throttle = await ctx.redis.main.set(
    `predictions:resolve:${m.market_id}`,
    '1',
    'EX',
    30,
    'NX',
  );
  if (throttle !== 'OK') return 'wait';
  const openTimeMs = m.resolves_at.getTime() - MINUTE_MS;
  const candle = await source.minuteCandle(m.basis.symbol ?? '', openTimeMs);
  if (!candle || candle.closeTimeMs >= now.getTime()) {
    return pastGrace(m, now, grace) ? 'void' : 'wait';
  }
  const v = candle.closeMicros;
  return { valueMicros: v, outcomeId: v > BigInt(m.strike_micros ?? '0') ? 'yes' : 'no' };
}

/**
 * Resolve every market past `resolves_at` (step 1).
 * @param ctx - The app context.
 * @param now - The current time.
 * @param source - The crypto reference source, or null when off.
 * @returns How many markets were resolved or voided.
 */
export async function resolveDueMarkets(
  ctx: AppContext,
  now: Date,
  source: ReferencePriceSource | null,
): Promise<number> {
  const due = await ctx.db.withConnection((c) =>
    c.query<MarketRow>(
      `SELECT ${MARKET_COLUMNS} FROM prediction_markets
        WHERE status IN ('open', 'closed') AND resolves_at <= $1
        ORDER BY resolves_at LIMIT 200`,
      [now],
    ),
  );
  let n = 0;
  for (const m of due.rows) {
    try {
      const d =
        m.kind === 'sim' || m.kind === 'event'
          ? decideDraw(m)
          : m.kind === 'crypto'
            ? await decideCrypto(ctx, m, now, source)
            : 'void';
      if (d === 'wait') continue;
      const r = await ctx.db.withConnection((c) =>
        d === 'void'
          ? c.query(
              `UPDATE prediction_markets SET status = 'void', resolved_at = $2
                WHERE market_id = $1 AND status IN ('open', 'closed')`,
              [m.market_id, now],
            )
          : c.query(
              `UPDATE prediction_markets
                  SET status = 'resolved', resolved_value_micros = $2, resolved_outcome_id = $3,
                      resolved_at = $4
                WHERE market_id = $1 AND status IN ('open', 'closed')`,
              [m.market_id, d.valueMicros.toString(), d.outcomeId, now],
            ),
      );
      n += r.rowCount ?? 0;
    } catch (e) {
      // One bad market must not stop the batch; the next sweep retries it.
      console.error(`[predictions] resolve ${m.market_id} failed:`, (e as Error).message);
    }
  }
  return n;
}

interface OpenBet {
  prediction_id: string;
  user_id: string;
  market_id: string | null;
  outcome_id: string;
  stake_cents: string;
  market_status: 'resolved' | 'void' | null;
  resolved_outcome_id: string | null;
  payout_bps: number | null;
}

/** What one bet pays and its final status. */
function payoutOf(b: OpenBet): { status: 'won' | 'lost' | 'cancelled'; payout: bigint } {
  const stake = BigInt(b.stake_cents);
  if (b.market_id === null || b.market_status === 'void')
    return { status: 'cancelled', payout: stake };
  if (b.outcome_id === b.resolved_outcome_id) {
    return { status: 'won', payout: (stake * BigInt(b.payout_bps ?? 10_000)) / 10_000n };
  }
  return { status: 'lost', payout: 0n };
}

async function settleOne(ctx: AppContext, b: OpenBet, now: Date): Promise<boolean> {
  const { status, payout } = payoutOf(b);
  const claimed = await runInTransaction(async (client) => {
    const claim = await client.query(
      `UPDATE predictions SET status = $2, payout_cents = $3, resolved_at = $4
        WHERE prediction_id = $1 AND status = 'open'`,
      [b.prediction_id, status, payout.toString(), now],
    );
    if ((claim.rowCount ?? 0) === 0) return false;
    if (payout > 0n) {
      const reason = status === 'won' ? 'prediction_payout' : 'prediction_refund';
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
        [b.user_id, payout.toString()],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', $3, 'prediction', $4, $5)`,
        [b.user_id, payout.toString(), reason, b.prediction_id, `pred-payout:${b.prediction_id}`],
      );
    }
    return true;
  });
  if (claimed) {
    await publishToUser(ctx, b.user_id, 'prediction_settled', {
      predictionId: b.prediction_id,
      marketId: b.market_id,
      status,
      payoutCents: Number(payout),
    });
  }
  return claimed;
}

/**
 * Settle every open bet whose market is resolved or void, and refund legacy
 * bets past their `closes_at` (step 2).
 * @param ctx - The app context.
 * @param now - The current time.
 * @returns How many bets were settled.
 */
export async function settleBets(ctx: AppContext, now: Date): Promise<number> {
  const r = await ctx.db.withConnection((c) =>
    c.query<OpenBet>(
      `SELECT p.prediction_id, p.user_id, p.market_id, p.outcome_id, p.stake_cents,
              m.status AS market_status, m.resolved_outcome_id, m.payout_bps
         FROM predictions p
         LEFT JOIN prediction_markets m ON m.market_id = p.market_id
        WHERE p.status = 'open'
          AND ((p.market_id IS NULL AND p.closes_at <= $1) OR m.status IN ('resolved', 'void'))
        LIMIT 500`,
      [now],
    ),
  );
  let n = 0;
  for (const b of r.rows) {
    try {
      if (await settleOne(ctx, b, now)) n++;
    } catch (e) {
      console.error(`[predictions] settle ${b.prediction_id} failed:`, (e as Error).message);
    }
  }
  return n;
}
