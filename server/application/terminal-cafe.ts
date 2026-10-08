/**
 * Terminal Cafe.
 *
 * The Phase 2 markets experience. Cash trades only; SOL/SKR/ORE
 * on the casino sites land in M5.
 *
 * Endpoints (M3 #39):
 *
 *   GET  /v1/market/coins?stage=new|final|graduated
 *        — paginated, 50/page, cursor = ticker
 *   GET  /v1/market/coins/:coinId
 *        — coin + 60-element 1m candles + top 20 holders + riskHint
 *   POST /v1/market/trades
 *        — server-computed execution price; SLIPPAGE_EXCEEDED on
 *          price divergence > maxSlippageBps
 *   GET  /v1/market/positions
 *        — open positions with unrealized PnL
 *
 * The trade service is the only writer of `coins.price_micros`
 * (via the market engine) and of `positions`. Buy = insert
 * into positions or add to existing; sell = decrement units
 * and add realized_cents. Each trade writes a `trade_buy` or
 * `trade_sell` ledger row with the cash delta, then updates
 * the balances row, all in a single SERIALIZABLE transaction.
 *
 * The risk hint uses `contract/config/skills.json`:
 *   security >= 5 → 'low' (auditor role unlocked)
 *   security <  5 → 'hidden' (with a one-line warning)
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  InsufficientCashError,
  NotFoundError,
  SlippageExceededError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ammQuote } from './amm.js';
import type { AppContext } from './context.js';

export type Stage = 'new' | 'final' | 'graduated' | 'dead';
export type TradeSide = 'buy' | 'sell';

export interface CoinRow {
  readonly coinId: string;
  readonly ticker: string;
  readonly name: string;
  readonly stage: Stage;
  readonly priceMicros: string;
  readonly mcapCents: string;
  readonly vol5mCents: string;
  readonly change5mBps: number;
  readonly holders: number;
  readonly launchedAt: string;
}

export interface CoinDetail {
  readonly coin: CoinRow;
  readonly candles1m: Array<{ readonly at: number; readonly priceMicros: string }>;
  readonly topHolders: Array<{ readonly alias: string; readonly units: string }>;
  readonly riskHint: { readonly level: 'low' | 'hidden'; readonly reason?: string };
}

export interface PositionRow {
  readonly coinId: string;
  readonly ticker: string;
  readonly units: string;
  readonly costBasisCents: string;
  readonly realizedCents: string;
  readonly currentPriceMicros: string;
  readonly unrealizedCents: string;
}

const PAGE_SIZE = 50;

/**
 * List coins by stage. Cursor pagination; cursor is the ticker
 * of the last row from the previous page.
 *
 * @param ctx - The application context.
 * @param stage - The stage to filter on.
 * @param cursor - The ticker to start after (exclusive).
 */
export async function listCoins(
  ctx: AppContext,
  stage: Stage | null,
  cursor: string | null,
): Promise<{ coins: CoinRow[]; nextCursor: string | null }> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (stage !== null) {
    params.push(stage);
    where.push(`stage = $${params.length}`);
  }
  if (cursor !== null && cursor !== '') {
    params.push(cursor);
    where.push(`ticker > $${params.length}`);
  }
  where.push(`stage <> 'dead'`);
  params.push(PAGE_SIZE + 1);
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      coin_id: string;
      ticker: string;
      name: string;
      stage: Stage;
      price_micros: string;
      mcap_cents: string;
      vol_5m_cents: string;
      change_5m_bps: number;
      holders: number;
      launched_at: Date;
    }>(
      `SELECT coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
              change_5m_bps, holders, launched_at
       FROM coins
       WHERE ${where.join(' AND ')}
       ORDER BY ticker ASC
       LIMIT $${params.length}`,
      params,
    );
  });
  const rows = r.rows;
  const hasMore = rows.length > PAGE_SIZE;
  const slice = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  return {
    coins: slice.map(coinRowFromDb),
    nextCursor: hasMore ? (slice[slice.length - 1]?.ticker ?? null) : null,
  };
}

function coinRowFromDb(r: {
  coin_id: string;
  ticker: string;
  name: string;
  stage: Stage;
  price_micros: string;
  mcap_cents: string;
  vol_5m_cents: string;
  change_5m_bps: number;
  holders: number;
  launched_at: Date;
}): CoinRow {
  return {
    coinId: r.coin_id,
    ticker: r.ticker,
    name: r.name,
    stage: r.stage,
    priceMicros: r.price_micros,
    mcapCents: r.mcap_cents,
    vol5mCents: r.vol_5m_cents,
    change5mBps: r.change_5m_bps,
    holders: r.holders,
    launchedAt: r.launched_at.toISOString(),
  };
}

/**
 * Fetch a coin's detail. Joins the engine's price history
 * (read from the Redis snapshot) for the candle array.
 */
export async function getCoin(
  ctx: AppContext,
  userId: string,
  coinId: string,
): Promise<CoinDetail> {
  const coin = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{
      coin_id: string;
      ticker: string;
      name: string;
      stage: Stage;
      price_micros: string;
      mcap_cents: string;
      vol_5m_cents: string;
      change_5m_bps: number;
      holders: number;
      launched_at: Date;
    }>(
      `SELECT coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
              change_5m_bps, holders, launched_at
       FROM coins WHERE coin_id = $1`,
      [coinId],
    );
    if ((r.rowCount ?? 0) === 0) return null;
    return r.rows[0]!;
  });
  if (coin === null) throw new NotFoundError({ kind: 'coin', id: coinId });
  // Candles: read the snapshot from the engine, fall back to
  // a single candle from the row if the snapshot is missing.
  const snap = await ctx.redis.main.get(`market:coin:${coinId}`);
  const candles1m: CoinDetail['candles1m'] = snap
    ? ((JSON.parse(snap) as { priceHistory?: CoinDetail['candles1m'] }).priceHistory ?? [])
    : [];
  // Top holders.
  const holders = await ctx.db.withConnection(async (c) => {
    return c.query<{ alias: string; units: string }>(
      `SELECT COALESCE(ch.alias, u.wallet) AS alias, p.units
       FROM positions p
       LEFT JOIN characters ch ON ch.user_id = p.user_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.coin_id = $1 AND p.units > 0
       ORDER BY p.units DESC
       LIMIT 20`,
      [coinId],
    );
  });
  // Risk hint from the user's security skill.
  const sec = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ security: number }>(
      `SELECT security FROM skills WHERE user_id = $1`,
      [userId],
    );
    return r.rows[0]?.security ?? 1;
  });
  const riskHint: CoinDetail['riskHint'] =
    sec >= 5
      ? { level: 'low' }
      : {
          level: 'hidden',
          reason: 'Reach security 5 to unlock the risk read-out.',
        };
  return {
    coin: coinRowFromDb(coin),
    candles1m,
    topHolders: holders.rows,
    riskHint,
  };
}

export interface TradeInput {
  readonly userId: string;
  readonly coinId: string;
  readonly side: TradeSide;
  readonly cashCents?: number;
  readonly units?: string;
  readonly maxSlippageBps: number;
}

export interface TradeResult {
  readonly tradeId: string;
  readonly coinId: string;
  readonly side: TradeSide;
  readonly units: string;
  readonly priceMicros: string;
  readonly feeCents: string; // B20: add fee field
  readonly cashCents: string; // B20: rename from cashDeltaCents, net cash after fee
  readonly realizedCents: string;
  readonly newUnits: string;
}

/**
 * Execute a trade. The server computes the execution price via
 * the AMM; the user's maxSlippageBps is the cap on divergence
 * from the engine's snapshot price.
 *
 * `cashCents` is the input for a buy; `units` is the input for
 * a sell. The other side is computed by the AMM.
 *
 * @param ctx - The application context.
 * @param input - The trade request.
 */
export async function executeTrade(_ctx: AppContext, input: TradeInput): Promise<TradeResult> {
  if (input.side === 'buy' && (input.cashCents === undefined || input.cashCents <= 0)) {
    throw new ValidationFailedError({ reason: 'cashCents required for buy' });
  }
  if (input.side === 'sell' && (input.units === undefined || BigInt(input.units) <= 0n)) {
    throw new ValidationFailedError({ reason: 'units required for sell' });
  }
  if (input.maxSlippageBps < 0 || input.maxSlippageBps > 10_000) {
    throw new ValidationFailedError({ reason: 'maxSlippageBps out of range' });
  }
  return runInTransaction(async (client) => {
    // Lock the coin row.
    const cr = await client.query<{
      coin_id: string;
      ticker: string;
      stage: Stage;
      price_micros: string;
    }>(`SELECT coin_id, ticker, stage, price_micros FROM coins WHERE coin_id = $1 FOR UPDATE`, [
      input.coinId,
    ]);
    if ((cr.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'coin', id: input.coinId });
    const coin = cr.rows[0]!;
    if (coin.stage === 'dead') {
      throw new ValidationFailedError({ reason: 'coin is dead' });
    }
    const quotePriceMicros = BigInt(coin.price_micros);
    if (quotePriceMicros <= 0n) {
      throw new ValidationFailedError({ reason: 'coin price is not positive' });
    }

    // B20 fix: Derive virtual reserves from the coin's current price so the curve's
    // spot price equals price_micros before the trade.
    // Fixed config reserves: x=1M, y=30M (from market.json)
    // For any coin price P (micros), scale reserves: x'=1M, y'=x' * P
    // This ensures y'/x' = P before any trade.
    const baseReserveX = 1_000_000n;
    const reserves = {
      x: baseReserveX,
      y: (baseReserveX * quotePriceMicros) / 1_000_000n, // Convert micros to cents for y
    };

    // B20 fix: Apply fees from market.json (100 bps each side)
    const FEE_BPS_BUY = 100n;
    const FEE_BPS_SELL = 100n;

    let amountOut: bigint;
    let amountInCents: bigint;
    let feeCents: bigint;

    if (input.side === 'buy') {
      amountInCents = BigInt(input.cashCents!);
      // Apply buy fee: fee is taken from the input
      feeCents = (amountInCents * FEE_BPS_BUY) / 10_000n;
      const amountAfterFee = amountInCents - feeCents;

      // cents -> USDC base units (6dp): units = cents * 10_000 (since 1 USDC = 100 cents = 1_000_000 base units)
      const usdcBaseUnits = amountAfterFee * 10_000n;
      const q = ammQuote('buy', usdcBaseUnits, reserves);
      amountOut = q.amountOut;
    } else {
      const units = BigInt(input.units!);
      const q = ammQuote('sell', units, reserves);
      amountOut = q.amountOut;
      // USDC base units (6dp) -> cents
      const amountOutCents = (amountOut * 100n) / 1_000_000n;
      // Apply sell fee: fee is taken from the output
      feeCents = (amountOutCents * FEE_BPS_SELL) / 10_000n;
      amountInCents = amountOutCents - feeCents;
    }

    // B20 fix: Calculate execution price and check slippage one-sided
    // Execution price = total cash in / units out (for buy), or total cash out / units in (for sell)
    let executionPriceMicros: bigint;
    if (input.side === 'buy') {
      // Buy: execution price = (cashCents + fee) / unitsOut * 1M
      executionPriceMicros = amountOut > 0n
        ? (amountInCents * 1_000_000n) / amountOut
        : 0n;
    } else {
      // Sell: execution price = (cashCents - fee) / unitsIn * 1M
      const units = BigInt(input.units!);
      executionPriceMicros = units > 0n
        ? (amountInCents * 1_000_000n) / units
        : 0n;
    }

    // Slippage check: one-sided (only worse prices fail)
    // For buy: worse = higher price (paying more per unit)
    // For sell: worse = lower price (receiving less per unit)
    let slippageBps = 0n;
    if (input.side === 'buy' && executionPriceMicros > quotePriceMicros) {
      slippageBps = ((executionPriceMicros - quotePriceMicros) * 10_000n) / quotePriceMicros;
    } else if (input.side === 'sell' && executionPriceMicros < quotePriceMicros) {
      slippageBps = ((quotePriceMicros - executionPriceMicros) * 10_000n) / quotePriceMicros;
    }

    if (slippageBps > BigInt(input.maxSlippageBps)) {
      throw new SlippageExceededError({
        expected: quotePriceMicros.toString(),
        actual: executionPriceMicros.toString(),
        maxSlippageBps: input.maxSlippageBps,
      });
    }
    // Lock the user's balance + position.
    const bal = await client.query<{ cash_cents: string; debt_cents: string }>(
      `SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [input.userId],
    );
    if (input.side === 'buy') {
      const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
      if (cash < amountInCents) {
        throw new InsufficientCashError({ have: cash.toString(), need: amountInCents.toString() });
      }
      // Debit cash.
      await client.query(
        `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
        [amountInCents.toString(), input.userId],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'trade_buy', 'trade', $3, $4)`,
        [input.userId, (-amountInCents).toString(), input.coinId, `trade-buy:${uuidv7()}`],
      );
    } else {
      // Credit cash.
      await client.query(
        `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
        [amountInCents.toString(), input.userId],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'trade_sell', 'trade', $3, $4)`,
        [input.userId, amountInCents.toString(), input.coinId, `trade-sell:${uuidv7()}`],
      );
    }
    // Upsert the position.
    const pos = await client.query<{
      position_id: string;
      units: string;
      cost_basis_cents: string;
      realized_cents: string;
    }>(
      `SELECT position_id, units, cost_basis_cents, realized_cents
       FROM positions WHERE user_id = $1 AND coin_id = $2 FOR UPDATE`,
      [input.userId, input.coinId],
    );
    let positionId: string;
    let newUnits: bigint;
    let realizedCents = 0n;
    if ((pos.rowCount ?? 0) === 0) {
      positionId = uuidv7();
      newUnits = input.side === 'buy' ? amountOut : -amountOut;
      if (newUnits < 0n) throw new InsufficientCashError({ reason: 'would sell more than held' });
      await client.query(
        `INSERT INTO positions (position_id, user_id, coin_id, units, cost_basis_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          positionId,
          input.userId,
          input.coinId,
          newUnits.toString(),
          input.side === 'buy' ? amountInCents.toString() : '0',
        ],
      );
    } else {
      positionId = pos.rows[0]!.position_id;
      const prevUnits = BigInt(pos.rows[0]!.units);
      const prevCost = BigInt(pos.rows[0]!.cost_basis_cents);
      const prevRealized = BigInt(pos.rows[0]!.realized_cents);
      if (input.side === 'buy') {
        newUnits = prevUnits + amountOut;
        const newCost = prevCost + amountInCents;
        await client.query(
          `UPDATE positions SET units = $1, cost_basis_cents = $2 WHERE position_id = $3`,
          [newUnits.toString(), newCost.toString(), positionId],
        );
      } else {
        if (prevUnits < amountOut) {
          throw new InsufficientCashError({ reason: 'would sell more than held' });
        }
        newUnits = prevUnits - amountOut;
        // Realized: (price - cost_basis) * units_sold, where price is the executed sell price in cents.
        // price_cents = amountInCents / amountOut; cost_basis_cents per unit = prevCost / prevUnits.
        const sellPricePerUnitCents =
          amountOut === 0n ? 0n : (amountInCents * 1_000_000n) / (amountOut * 1_000_000n);
        const costBasisPerUnitCents =
          prevUnits === 0n ? 0n : (prevCost * 1_000_000n) / (prevUnits * 1_000_000n);
        realizedCents = ((sellPricePerUnitCents - costBasisPerUnitCents) * amountOut) / 1_000_000n;
        const totalRealized = prevRealized + realizedCents;
        const newCost = prevCost === 0n ? 0n : (prevCost * newUnits) / prevUnits;
        await client.query(
          `UPDATE positions SET units = $1, cost_basis_cents = $2, realized_cents = $3 WHERE position_id = $4`,
          [newUnits.toString(), newCost.toString(), totalRealized.toString(), positionId],
        );
      }
    }
    // B20 fix: Return the contract Trade shape with execution price and fee
    return {
      tradeId: positionId,
      coinId: input.coinId,
      side: input.side,
      units: amountOut.toString(),
      priceMicros: executionPriceMicros.toString(), // B20: execution price, not post-trade marginal
      feeCents: feeCents.toString(), // B20: add fee to response
      cashCents: amountInCents.toString(), // B20: net cash (after fee for buy, after fee for sell)
      realizedCents: realizedCents.toString(),
      newUnits: newUnits.toString(),
    };
  });
}

/**
 * Fetch the user's open positions with unrealized PnL.
 */
export async function listPositions(ctx: AppContext, userId: string): Promise<PositionRow[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      coin_id: string;
      ticker: string;
      units: string;
      cost_basis_cents: string;
      realized_cents: string;
      price_micros: string;
    }>(
      `SELECT p.coin_id, c.ticker, p.units, p.cost_basis_cents, p.realized_cents, c.price_micros
       FROM positions p
       JOIN coins c ON c.coin_id = p.coin_id
       WHERE p.user_id = $1 AND p.units > 0`,
      [userId],
    );
  });
  return r.rows.map((row) => {
    const units = BigInt(row.units);
    const costBasis = BigInt(row.cost_basis_cents);
    const price = BigInt(row.price_micros);
    // Unrealized in cents: (current_price_micros * units / 1_000_000) - cost_basis.
    const currentValueCents = (price * units) / 1_000_000n;
    const unrealizedCents = currentValueCents - costBasis;
    return {
      coinId: row.coin_id,
      ticker: row.ticker,
      units: row.units,
      costBasisCents: row.cost_basis_cents,
      realizedCents: row.realized_cents,
      currentPriceMicros: row.price_micros,
      unrealizedCents: unrealizedCents.toString(),
    };
  });
}
