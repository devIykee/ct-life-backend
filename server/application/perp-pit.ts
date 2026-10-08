/**
 * Perp Pit.
 *
 * Leveraged long/short positions on a coin. Endpoints:
 *
 *   POST /v1/perps                       — open a perp
 *   POST /v1/perps/:perpId/close         — close a perp
 *   GET  /v1/perps?status=open|closed    — list the user's perps
 *
 * Liquidation:
 *
 *   The liquidation worker (server/workers/liquidation.ts) runs
 *   every 5 s, reads the engine's price_micros for each open
 *   perp, and closes the perp with status='liquidated' if the
 *   price crosses liq_micros. On liquidation, the worker
 *   writes a 'liq_pay' ledger row, emits a city room
 *   'liquidated' event, and a city room 'liquidated' message
 *   to the user (the REKT card).
 *
 * Math:
 *
 *   liq_micros long  = entry * (1 - 1/leverage)
 *   liq_micros short = entry * (1 + 1/leverage)
 *   realized         = (close - entry) * sign * units
 *
 * Skill gate:
 *
 *   leverage is capped by trading_skill_level + tribe bonus
 *   (perp_degen +5). The gate reads contract/config/skills.json.
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  InsufficientCashError,
  LeverageNotAllowedError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type PerpSide = 'long' | 'short';
export type PerpStatus = 'open' | 'closed' | 'liquidated';

export interface PerpRow {
  readonly perpId: string;
  readonly coinId: string;
  readonly ticker: string;
  readonly side: PerpSide;
  readonly leverage: number;
  readonly marginCents: string;
  readonly entryMicros: string;
  readonly liqMicros: string;
  readonly status: PerpStatus;
  readonly realizedCents: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
}

export interface OpenPerpInput {
  readonly userId: string;
  readonly coinId: string;
  readonly side: PerpSide;
  readonly leverage: number;
  readonly marginCents: number;
}

const MIN_LEVERAGE = 1;
const MAX_LEVERAGE = 20; // B38: fix from 25 to 20

/**
 * Open a new perp position.
 */
export async function openPerp(ctx: AppContext, input: OpenPerpInput): Promise<PerpRow> {
  if (input.leverage < MIN_LEVERAGE || input.leverage > MAX_LEVERAGE) {
    throw new LeverageNotAllowedError({ leverage: input.leverage });
  }
  if (input.marginCents <= 0) {
    throw new ValidationFailedError({ reason: 'marginCents must be > 0' });
  }
  const cfg = ctx.configCache.load<{
    leverageByTradingLevel: Array<{ level: number; leverage: number }>;
    tribeBonusLeverage: Record<string, number>;
  }>('skills');
  const trading = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ trading: number }>(`SELECT trading FROM skills WHERE user_id = $1`, [
      input.userId,
    ]);
    return r.rows[0]?.trading ?? 1;
  });
  const tribe = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ tribe_id: string | null }>(
      `SELECT tribe_id FROM characters WHERE user_id = $1`,
      [input.userId],
    );
    return r.rows[0]?.tribe_id ?? null;
  });
  const skillCap = cfg.leverageByTradingLevel.find((l) => l.level === trading)?.leverage ?? 1;
  const tribeBonus = tribe !== null ? (cfg.tribeBonusLeverage[tribe] ?? 0) : 0;
  const maxAllowed = Math.min(MAX_LEVERAGE, skillCap + tribeBonus);
  if (input.leverage > maxAllowed) {
    throw new LeverageNotAllowedError({
      requested: input.leverage,
      allowed: maxAllowed,
      trading,
      tribe,
    });
  }
  return runInTransaction(async (client) => {
    const cr = await client.query<{ coin_id: string; ticker: string; price_micros: string; stage: string }>(
      `SELECT coin_id, ticker, price_micros, stage FROM coins WHERE coin_id = $1 FOR UPDATE`,
      [input.coinId],
    );
    if ((cr.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'coin', id: input.coinId });
    const coin = cr.rows[0]!;
    // B38: reject dead coins
    if (coin.stage === 'dead') {
      throw new ValidationFailedError({ reason: 'coin is dead' });
    }
    const entry = BigInt(coin.price_micros);
    const lev = BigInt(input.leverage);
    const liq = input.side === 'long' ? (entry * (lev - 1n)) / lev : (entry * (lev + 1n)) / lev;
    // Lock + debit the margin.
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [input.userId],
    );
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(input.marginCents)) {
      // B38: use InsufficientCashError (402) instead of ForbiddenError
      throw new InsufficientCashError({ have: cash.toString(), need: input.marginCents.toString() });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [input.marginCents, input.userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'perp_margin', 'perp', $3, $4)`,
      [input.userId, -input.marginCents, input.coinId, `perp-margin:${uuidv7()}`],
    );
    const perpId = uuidv7();
    await client.query(
      `INSERT INTO perps
       (perp_id, user_id, coin_id, side, leverage, margin_cents, entry_micros, liq_micros, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')`,
      [
        perpId,
        input.userId,
        input.coinId,
        input.side,
        input.leverage,
        input.marginCents,
        entry.toString(),
        liq.toString(),
      ],
    );
    return {
      perpId,
      coinId: input.coinId,
      ticker: coin.ticker,
      side: input.side,
      leverage: input.leverage,
      marginCents: input.marginCents.toString(),
      entryMicros: entry.toString(),
      liqMicros: liq.toString(),
      status: 'open' as const,
      realizedCents: null,
      closedAt: null,
      createdAt: new Date().toISOString(),
    };
  });
}

/**
 * Close an open perp. Server-computes realized PnL:
 *   long  : (close - entry) * units where units = margin * leverage
 *   short : (entry - close) * units
 */
export async function closePerp(
  _ctx: AppContext,
  userId: string,
  perpId: string,
): Promise<PerpRow> {
  return runInTransaction(async (client) => {
    const pr = await client.query<{
      perp_id: string;
      user_id: string;
      coin_id: string;
      side: PerpSide;
      leverage: number;
      margin_cents: string;
      entry_micros: string;
      liq_micros: string;
      status: PerpStatus;
    }>(
      `SELECT perp_id, user_id, coin_id, side, leverage, margin_cents, entry_micros, liq_micros, status
       FROM perps WHERE perp_id = $1 FOR UPDATE`,
      [perpId],
    );
    if ((pr.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'perp', id: perpId });
    const perp = pr.rows[0]!;
    if (perp.user_id !== userId) throw new NotFoundError({ kind: 'perp', id: perpId });
    if (perp.status !== 'open') {
      throw new ValidationFailedError({ reason: 'perp not open' });
    }
    const cr = await client.query<{ price_micros: string; ticker: string }>(
      `SELECT price_micros, ticker FROM coins WHERE coin_id = $1 FOR UPDATE`,
      [perp.coin_id],
    );
    const close = BigInt(cr.rows[0]?.price_micros ?? '0');
    const entry = BigInt(perp.entry_micros);
    const lev = BigInt(perp.leverage);
    const margin = BigInt(perp.margin_cents);
    const units = margin * lev; // in cents
    // realized in cents: (close - entry) * units / entry for long;
    // (entry - close) * units / entry for short.
    const diff =
      perp.side === 'long'
        ? ((close - entry) * units) / (entry === 0n ? 1n : entry)
        : ((entry - close) * units) / (entry === 0n ? 1n : entry);
    const realized = diff;
    // Settle: credit the margin + realized back to the user.
    const payout = margin + realized;
    if (payout < 0n) {
      // The perp went below the margin; the loss is the full margin.
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'perp_close', 'perp', $3, $4)`,
        [userId, 0, perp.perp_id, `perp-close:${perp.perp_id}`],
      );
    } else {
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
        [userId, payout.toString()],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'perp_close', 'perp', $3, $4)`,
        [userId, payout.toString(), perp.perp_id, `perp-close:${perp.perp_id}`],
      );
    }
    await client.query(
      `UPDATE perps SET status = 'closed', realized_cents = $1, closed_at = now() WHERE perp_id = $2`,
      [realized.toString(), perp.perp_id],
    );
    return {
      perpId: perp.perp_id,
      coinId: perp.coin_id,
      ticker: cr.rows[0]?.ticker ?? '',
      side: perp.side,
      leverage: perp.leverage,
      marginCents: perp.margin_cents,
      entryMicros: perp.entry_micros,
      liqMicros: perp.liq_micros,
      status: 'closed',
      realizedCents: realized.toString(),
      closedAt: new Date().toISOString(),
      createdAt: '',
    };
  });
}

/**
 * Liquidate a perp if the engine's price has crossed liq_micros.
 * Called by the liquidation worker. Returns true if the perp was
 * liquidated; false otherwise. The worker then writes a 'liq_pay'
 * ledger row, emits a city room 'liquidated' event, and a city
 * room 'liquidated' message to the user.
 */
export async function liquidatePerp(ctx: AppContext, perpId: string): Promise<boolean> {
  return runInTransaction(async (client) => {
    const pr = await client.query<{
      perp_id: string;
      user_id: string;
      coin_id: string;
      side: PerpSide;
      leverage: number;
      margin_cents: string;
      entry_micros: string;
      liq_micros: string;
      status: PerpStatus;
    }>(
      `SELECT perp_id, user_id, coin_id, side, leverage, margin_cents, entry_micros, liq_micros, status
       FROM perps WHERE perp_id = $1 FOR UPDATE`,
      [perpId],
    );
    if ((pr.rowCount ?? 0) === 0) return false;
    const perp = pr.rows[0]!;
    if (perp.status !== 'open') return false;
    const cr = await client.query<{ price_micros: string }>(
      `SELECT price_micros FROM coins WHERE coin_id = $1 FOR UPDATE`,
      [perp.coin_id],
    );
    const price = BigInt(cr.rows[0]?.price_micros ?? '0');
    const liq = BigInt(perp.liq_micros);
    const crossed = perp.side === 'long' ? price <= liq : price >= liq;
    if (!crossed) return false;

    // B38: Calculate realized loss (negative value)
    const entry = BigInt(perp.entry_micros);
    const margin = BigInt(perp.margin_cents);
    const lev = BigInt(perp.leverage);
    const units = margin * lev; // in cents
    const diff =
      perp.side === 'long'
        ? ((price - entry) * units) / (entry === 0n ? 1n : entry)
        : ((entry - price) * units) / (entry === 0n ? 1n : entry);
    const realized = diff; // This will be negative (a loss)
    const lossCents = -realized; // Positive value of the loss

    // B38: Store realized_cents on liquidation
    await client.query(
      `UPDATE perps SET status = 'liquidated', realized_cents = $1, closed_at = now() WHERE perp_id = $2`,
      [realized.toString(), perp.perp_id],
    );
    // The user loses their margin; the loss is the liq_pay
    // ledger row (the user is debited 0, the loss was already
    // booked at open via the margin debit).
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, 0, 'cash', 'liq_pay', 'perp', $2, $3)`,
      [perp.user_id, perp.perp_id, `liq:${perp.perp_id}`],
    );
    // B38: Publish a city room event with lossCents for the REKT card.
    await ctx.redis.main.publish(
      'city:events',
      JSON.stringify({
        kind: 'liquidated',
        userId: perp.user_id,
        perpId: perp.perp_id,
        coinId: perp.coin_id,
        lossCents: lossCents.toString(), // B38: add lossCents
        at: Date.now(),
      }),
    );
    return true;
  });
}

/**
 * List the user's perps. Optional status filter.
 */
export async function listPerps(
  ctx: AppContext,
  userId: string,
  status: PerpStatus | null,
): Promise<PerpRow[]> {
  const params: unknown[] = [userId];
  let where = 'p.user_id = $1';
  if (status !== null) {
    params.push(status);
    where += ` AND p.status = $${params.length}`;
  }
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      perp_id: string;
      coin_id: string;
      ticker: string;
      side: PerpSide;
      leverage: number;
      margin_cents: string;
      entry_micros: string;
      liq_micros: string;
      status: PerpStatus;
      realized_cents: string | null;
      closed_at: Date | null;
      created_at: Date;
    }>(
      `SELECT p.perp_id, p.coin_id, c.ticker, p.side, p.leverage, p.margin_cents,
              p.entry_micros, p.liq_micros, p.status, p.realized_cents, p.closed_at, p.created_at
       FROM perps p
       JOIN coins c ON c.coin_id = p.coin_id
       WHERE ${where}
       ORDER BY p.created_at DESC
       LIMIT 200`,
      params,
    );
  });
  return r.rows.map((row) => ({
    perpId: row.perp_id,
    coinId: row.coin_id,
    ticker: row.ticker,
    side: row.side,
    leverage: row.leverage,
    marginCents: row.margin_cents,
    entryMicros: row.entry_micros,
    liqMicros: row.liq_micros,
    status: row.status,
    realizedCents: row.realized_cents,
    closedAt: row.closed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}
