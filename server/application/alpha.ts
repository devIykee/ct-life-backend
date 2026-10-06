/**
 * Alpha Calls + Trust Score + Smart Money.
 *
 * Endpoints (M3 #44):
 *
 *   POST /v1/alpha-calls              — immutable call
 *   GET  /v1/alpha-calls?userId=<id>  — calls + trust score
 *   GET  /v1/smart-money?limit=50     — recent big trades from opted-in users
 *   POST /v1/me/smart-money           — toggle the opt-in flag
 *
 * Alpha calls are immutable. The worker evaluates each open
 * call every 30 s and resolves:
 *   - price_micros >= target_micros → 'hit_target'
 *   - price_micros <= stop_micros   → 'hit_stop'
 *   - older than 7 days unresolved  → 'expired'
 *
 * Trust score (Redis sorted set trust:<userId>):
 *   hitRate       = hits / resolved
 *   avgReturnBps  = mean of (exit - entry) / entry in bps
 *   maxDrawdownBps = worst drawdown across resolved calls
 *   heldBagPct    = open / total
 *
 * Smart Money:
 *   The 50 most recent trades >= 10,000 cashCents from users
 *   with is_opted_in_smart_money = true. The opt-in is
 *   flipped by /v1/me/smart-money.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type CallStatus = 'open' | 'hit_target' | 'hit_stop' | 'expired';

export interface AlphaCallInput {
  readonly userId: string;
  readonly coinId: string;
  readonly entryMicros: string;
  readonly targetMicros: string;
  readonly stopMicros: string;
}

export interface AlphaCallRow {
  readonly callId: string;
  readonly userId: string;
  readonly coinId: string;
  readonly entryMicros: string;
  readonly targetMicros: string;
  readonly stopMicros: string;
  readonly status: CallStatus;
  readonly createdAt: string;
}

export interface TrustScore {
  readonly hitRate: number;
  readonly avgReturnBps: number;
  readonly maxDrawdownBps: number;
  readonly heldBagPct: number;
}

const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const SMART_MONEY_MIN_CENTS = 10_000;

/**
 * Place an alpha call. Immutable; no edit/delete.
 */
export async function placeAlphaCall(
  _ctx: AppContext,
  input: AlphaCallInput,
): Promise<AlphaCallRow> {
  const entry = BigInt(input.entryMicros);
  const target = BigInt(input.targetMicros);
  const stop = BigInt(input.stopMicros);
  if (entry <= 0n || target <= 0n || stop <= 0n) {
    throw new ValidationFailedError({ reason: 'amounts must be > 0' });
  }
  if (target <= stop) {
    throw new ValidationFailedError({ reason: 'target must be > stop' });
  }
  const callId = uuidv7();
  await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO alpha_calls (call_id, user_id, coin_id, entry_micros, target_micros, stop_micros, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'open')`,
      [callId, input.userId, input.coinId, input.entryMicros, input.targetMicros, input.stopMicros],
    );
  });
  return {
    callId,
    userId: input.userId,
    coinId: input.coinId,
    entryMicros: input.entryMicros,
    targetMicros: input.targetMicros,
    stopMicros: input.stopMicros,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Evaluate every open call. Called by the worker every 30 s.
 */
export async function evaluateAlphaCalls(ctx: AppContext): Promise<number> {
  let resolved = 0;
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      call_id: string;
      coin_id: string;
      entry_micros: string;
      target_micros: string;
      stop_micros: string;
      created_at: Date;
    }>(
      `SELECT call_id, coin_id, entry_micros, target_micros, stop_micros, created_at
       FROM alpha_calls
       WHERE status = 'open'
       LIMIT 1000`,
    );
  });
  for (const row of r.rows) {
    const cr = await ctx.db.withConnection(async (c) => {
      return c.query<{ price_micros: string }>(
        `SELECT price_micros FROM coins WHERE coin_id = $1`,
        [row.coin_id],
      );
    });
    const price = BigInt(cr.rows[0]?.price_micros ?? '0');
    const target = BigInt(row.target_micros);
    const stop = BigInt(row.stop_micros);
    let nextStatus: CallStatus | null = null;
    if (price >= target) nextStatus = 'hit_target';
    else if (price <= stop) nextStatus = 'hit_stop';
    else if (Date.now() - row.created_at.getTime() > EXPIRY_MS) nextStatus = 'expired';
    if (nextStatus === null) continue;
    await ctx.db.withConnection(async (c) => {
      await c.query(`UPDATE alpha_calls SET status = $1 WHERE call_id = $2 AND status = 'open'`, [
        nextStatus,
        row.call_id,
      ]);
    });
    resolved++;
  }
  return resolved;
}

/**
 * Compute the trust score for a user. With zero resolved
 * calls, hitRate is 0 (the spec's edge case).
 */
export async function getTrustScore(ctx: AppContext, userId: string): Promise<TrustScore> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      total: string;
      resolved: string;
      hits: string;
      avg_return: string | null;
      max_dd: string | null;
      open: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status <> 'open')::text AS resolved,
         COUNT(*) FILTER (WHERE status = 'hit_target')::text AS hits,
         AVG(
           CASE
             WHEN status = 'hit_target' THEN ((target_micros - entry_micros) * 10000) / entry_micros
             WHEN status = 'hit_stop'   THEN ((stop_micros - entry_micros) * 10000) / entry_micros
             ELSE NULL
           END
         )::text AS avg_return,
         MIN(
           CASE
             WHEN status = 'hit_target' THEN ((target_micros - entry_micros) * 10000) / entry_micros
             WHEN status = 'hit_stop'   THEN ((stop_micros - entry_micros) * 10000) / entry_micros
             ELSE NULL
           END
         )::text AS max_dd,
         COUNT(*) FILTER (WHERE status = 'open')::text AS open
       FROM alpha_calls WHERE user_id = $1`,
      [userId],
    );
  });
  const row = r.rows[0]!;
  const total = Number(row.total);
  const resolved = Number(row.resolved);
  const hits = Number(row.hits);
  const open = Number(row.open);
  return {
    hitRate: resolved === 0 ? 0 : hits / resolved,
    avgReturnBps: row.avg_return === null ? 0 : Math.round(Number(row.avg_return)),
    maxDrawdownBps: row.max_dd === null ? 0 : Math.round(Number(row.max_dd)),
    heldBagPct: total === 0 ? 0 : open / total,
  };
}

/**
 * List a user's alpha calls (newest first) and trust score.
 */
export async function listCalls(
  ctx: AppContext,
  userId: string,
): Promise<{ calls: AlphaCallRow[]; trustScore: TrustScore }> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      call_id: string;
      user_id: string;
      coin_id: string;
      entry_micros: string;
      target_micros: string;
      stop_micros: string;
      status: CallStatus;
      created_at: Date;
    }>(
      `SELECT call_id, user_id, coin_id, entry_micros, target_micros, stop_micros, status, created_at
       FROM alpha_calls
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [userId],
    );
  });
  const calls = r.rows.map((row) => ({
    callId: row.call_id,
    userId: row.user_id,
    coinId: row.coin_id,
    entryMicros: row.entry_micros,
    targetMicros: row.target_micros,
    stopMicros: row.stop_micros,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  }));
  const trustScore = await getTrustScore(ctx, userId);
  return { calls, trustScore };
}

/**
 * Smart Money: the 50 most recent trades >= 10k cents from
 * opted-in users.
 */
export async function listSmartMoney(
  ctx: AppContext,
  limit: number,
): Promise<
  Array<{
    readonly userId: string;
    readonly alias: string;
    readonly coinId: string;
    readonly ticker: string;
    readonly side: 'buy' | 'sell';
    readonly cashCents: string;
    readonly at: string;
  }>
> {
  const capped = Math.max(1, Math.min(limit, 50));
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      user_id: string;
      alias: string;
      coin_id: string;
      ticker: string;
      side: 'buy' | 'sell';
      cash_cents: string;
      created_at: Date;
    }>(
      `SELECT l.user_id, COALESCE(ch.alias, u.wallet) AS alias, l.ref_id AS coin_id,
              c.ticker, l.reason AS side, l.delta_cents AS cash_cents, l.created_at
       FROM ledger_entries l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN characters ch ON ch.user_id = l.user_id
       JOIN coins c ON c.coin_id = l.ref_id::uuid
       WHERE u.is_opted_in_smart_money = true
         AND l.account = 'cash'
         AND l.reason IN ('trade_buy', 'trade_sell')
         AND ABS(l.delta_cents) >= $1
       ORDER BY l.created_at DESC
       LIMIT $2`,
      [SMART_MONEY_MIN_CENTS, capped],
    );
  });
  return r.rows.map((row) => ({
    userId: row.user_id,
    alias: row.alias,
    coinId: row.coin_id,
    ticker: row.ticker,
    side: (row.side as string) === 'trade_sell' ? 'sell' : 'buy',
    cashCents: row.cash_cents,
    at: row.created_at.toISOString(),
  }));
}

/**
 * Toggle the smart-money opt-in flag for the current user.
 */
export async function setSmartMoneyOptIn(
  ctx: AppContext,
  userId: string,
  optIn: boolean,
): Promise<void> {
  await ctx.db.withConnection(async (c) => {
    await c.query(`UPDATE users SET is_opted_in_smart_money = $1 WHERE id = $2`, [optIn, userId]);
  });
}
