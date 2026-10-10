/**
 * Launchpad Tower.
 *
 * Coin creation, hidden-arc commit, lifecycle, and tombstones.
 *
 * Endpoints (M3 #42):
 *
 *   POST /v1/market/launchpad            — create a new coin
 *   POST /v1/market/launchpad/:coinId/buy — buy during the bonding curve
 *   GET  /v1/rekt/tombstones?limit=50    — recent tombstones
 *
 * The launchpad is the only place that creates coins; only the
 * market engine transitions their stage. The supply is fixed
 * at 1_000_000_000 base units. The bonding curve is
 * `price = base_price + (raised / supply) * slope`. Graduation
 * to the AMM happens when the raised balance hits the
 * configured `graduateMcapCents` ($50k by default).
 *
 * The `hidden_arc` is sampled at launch and committed to the
 * coin row. It is NEVER exposed to clients.
 *
 * On a rug or slow-bleed termination, the engine writes a row
 * to `tombstones` (lost_cents, reason, alias). The Rekt Clinic
 * serves the most recent 50 with a join to users for alias.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ammQuote } from './amm.js';
import { sampleHiddenArc, type HiddenArc } from './hidden-arc.js';
import type { AppContext } from './context.js';
import { publishWorldEvent } from './realtime-bus.js';

const COIN_SUPPLY = 1_000_000_000n; // 1B base units
const BASE_PRICE_MICROS = 1_000n; // 0.001 USDC per base unit at launch
const TOMBSTONE_LIMIT = 50;

export interface LaunchInput {
  readonly userId: string;
  readonly name: string;
  readonly ticker: string;
  readonly supply?: string; // default 1B
}

export interface LaunchResult {
  readonly coinId: string;
  readonly ticker: string;
  readonly stage: 'new';
  readonly priceMicros: string;
  readonly supply: string;
  readonly seed: number;
  readonly hiddenArc: HiddenArc;
}

/**
 * Create a new coin. Generates a seed, samples the hidden
 * arc, and writes the coin row. The market engine loads the
 * coin on its next tick.
 */
export async function launchCoin(ctx: AppContext, input: LaunchInput): Promise<LaunchResult> {
  if (input.ticker.length < 2 || input.ticker.length > 8) {
    throw new ValidationFailedError({ reason: 'ticker length 2..8' });
  }
  if (input.name.length < 1 || input.name.length > 64) {
    throw new ValidationFailedError({ reason: 'name length 1..64' });
  }
  const supply = input.supply !== undefined ? BigInt(input.supply) : COIN_SUPPLY;
  if (supply <= 0n) {
    throw new ValidationFailedError({ reason: 'supply must be > 0' });
  }
  const cfg = ctx.configCache.load<{
    outcomeMix: { rug: number; slow_bleed: number; sideways: number; moon: number };
  }>('market');
  const seed = (Math.random() * 0x7fffffff) >>> 0;
  const hiddenArc = sampleHiddenArc(seed, cfg.outcomeMix);
  const coinId = uuidv7();
  const initialPrice = BASE_PRICE_MICROS;
  const initialMcap = (initialPrice * supply) / 1_000_000n;
  await runInTransaction(async (client) => {
    try {
      await client.query(
        `INSERT INTO coins
         (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents, change_5m_bps, holders, launched_at, hidden_arc, seed)
         VALUES ($1, $2, $3, 'new', $4, $5, 0, 0, 0, now(), $6, $7)`,
        [
          coinId,
          input.ticker.toUpperCase(),
          input.name,
          initialPrice.toString(),
          initialMcap.toString(),
          JSON.stringify(hiddenArc),
          seed.toString(),
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ValidationFailedError({ reason: 'ticker already exists' });
      }
      throw e;
    }
  });
  // Tell the city. The contract has evt_coin_launch but nothing ever
  // emitted it, so a launch was invisible to everyone not on the board.
  await publishWorldEvent(ctx, 'evt_coin_launch', {
    coinId,
    ticker: input.ticker.toUpperCase(),
  });
  return {
    coinId,
    ticker: input.ticker.toUpperCase(),
    stage: 'new',
    priceMicros: initialPrice.toString(),
    supply: supply.toString(),
    seed,
    hiddenArc,
  };
}

/**
 * Buy during the bonding curve. The trade service in
 * terminal-cafe.ts handles the post-graduation AMM trades;
 * this is the launchpad-only path.
 *
 * The current implementation reuses the AMM with the launch
 * reserves; the engine is responsible for transitioning the
 * stage to 'final' when mcap >= graduateMcapCents.
 */
export async function launchpadBuy(
  _ctx: AppContext,
  userId: string,
  coinId: string,
  cashCents: number,
  maxSlippageBps: number,
): Promise<{ tradeId: string; units: string; priceMicros: string; cashCents: number }> {
  if (cashCents <= 0) {
    throw new ValidationFailedError({ reason: 'cashCents must be > 0' });
  }
  return runInTransaction(async (client) => {
    const cr = await client.query<{
      coin_id: string;
      ticker: string;
      price_micros: string;
      stage: string;
    }>(`SELECT coin_id, ticker, price_micros, stage FROM coins WHERE coin_id = $1 FOR UPDATE`, [
      coinId,
    ]);
    if ((cr.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'coin', id: coinId });
    const coin = cr.rows[0]!;
    if (coin.stage !== 'new') {
      throw new ValidationFailedError({ reason: 'coin already past launchpad' });
    }
    // Bonding-curve math: price = base + (raised / supply) * slope.
    // For the M3 dev path, the simple "linear" curve is approximated
    // by an AMM with reserves { x: supply, y: base * supply }.
    const x0 = COIN_SUPPLY;
    const y0 = BASE_PRICE_MICROS * COIN_SUPPLY;
    const usdcBaseUnits = BigInt(cashCents) * 10_000n; // cents -> USDC base units (6dp)
    const q = ammQuote('buy', usdcBaseUnits, { x: x0, y: y0 });
    const newX = q.newX;
    const newY = q.newY;
    const newPrice = (newY * 1_000_000n) / (newX === 0n ? 1n : newX);
    const snapPrice = BigInt(coin.price_micros);
    const diffBps =
      snapPrice === 0n
        ? 0n
        : newPrice > snapPrice
          ? ((newPrice - snapPrice) * 10_000n) / snapPrice
          : ((snapPrice - newPrice) * 10_000n) / snapPrice;
    if (diffBps > BigInt(maxSlippageBps)) {
      throw new ValidationFailedError({ reason: 'slippage_exceeded' });
    }
    // Debit cash, credit units, update the coin's price.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents - $2, updated_at = now()`,
      [userId, cashCents],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'trade_buy', 'trade', $3, $4)`,
      [userId, -cashCents, coinId, `launchpad-buy:${uuidv7()}`],
    );
    const pos = await client.query<{
      position_id: string;
      units: string;
      cost_basis_cents: string;
    }>(
      `SELECT position_id, units, cost_basis_cents FROM positions WHERE user_id = $1 AND coin_id = $2 FOR UPDATE`,
      [userId, coinId],
    );
    if ((pos.rowCount ?? 0) === 0) {
      await client.query(
        `INSERT INTO positions (position_id, user_id, coin_id, units, cost_basis_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv7(), userId, coinId, q.amountOut.toString(), cashCents],
      );
    } else {
      const prev = pos.rows[0]!;
      const newUnits = BigInt(prev.units) + q.amountOut;
      const newCost = BigInt(prev.cost_basis_cents) + BigInt(cashCents);
      await client.query(
        `UPDATE positions SET units = $1, cost_basis_cents = $2 WHERE position_id = $3`,
        [newUnits.toString(), newCost.toString(), prev.position_id],
      );
    }
    await client.query(
      `UPDATE coins SET price_micros = $1, holders = holders + 1 WHERE coin_id = $2`,
      [newPrice.toString(), coinId],
    );
    return {
      tradeId: coinId,
      units: q.amountOut.toString(),
      priceMicros: newPrice.toString(),
      cashCents,
    };
  });
}

/**
 * Tombstone a user+coin on a rug. Called by the engine when a
 * coin transitions to stage='dead'. Inserts a tombstones row.
 */
export async function writeTombstone(
  _ctx: AppContext,
  coinId: string,
  userId: string,
  alias: string,
  lostCents: bigint,
  reason: 'rug' | 'slow_bleed',
): Promise<void> {
  await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO tombstones (coin_id, user_id, alias, lost_cents, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (coin_id, user_id) DO UPDATE SET lost_cents = tombstones.lost_cents + EXCLUDED.lost_cents, at = now()`,
      [coinId, userId, alias, lostCents.toString(), reason],
    );
  });
}

/**
 * Fetch the most recent tombstones. The Rekt Clinic joins
 * users for the alias.
 */
export async function listTombstones(
  ctx: AppContext,
  limit: number,
): Promise<
  Array<{
    readonly coinId: string;
    readonly ticker: string;
    readonly alias: string;
    readonly lostCents: string;
    readonly reason: 'rug' | 'slow_bleed';
    readonly at: string;
  }>
> {
  const cappedLimit = Math.max(1, Math.min(limit, TOMBSTONE_LIMIT));
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      coin_id: string;
      ticker: string;
      alias: string;
      lost_cents: string;
      reason: 'rug' | 'slow_bleed';
      at: Date;
    }>(
      `SELECT t.coin_id, c.ticker, t.alias, t.lost_cents, t.reason, t.at
       FROM tombstones t
       JOIN coins c ON c.coin_id = t.coin_id
       ORDER BY t.at DESC
       LIMIT $1`,
      [cappedLimit],
    );
  });
  return r.rows.map((row) => ({
    coinId: row.coin_id,
    ticker: row.ticker,
    alias: row.alias,
    lostCents: row.lost_cents,
    reason: row.reason,
    at: row.at.toISOString(),
  }));
}
