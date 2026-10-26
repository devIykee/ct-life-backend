/**
 * Rugpull Factory: player-launched, Cash-only, server-simulated parody coins.
 *
 *   POST /v1/factory/coins             — launch a coin (fee + liquidity in Cash)
 *   GET  /v1/factory/coins?view=       — trending | new | mine
 *   GET  /v1/factory/coins/:coinId     — one coin with chart, holders, creator view
 *   GET  /v1/factory/config            — fees, limits, templates, arc odds
 *   GET  /v1/factory/me                — my heat, launches today, next launch time
 *
 * Trading uses the existing `POST /v1/market/trades`; a player coin is a
 * normal row in `coins` (flag `player_launched`), so it shows on the Pulse
 * board and the market room, ticks on the same engine and follows the same
 * hidden arc, sampled here from the server's own odds. The client never
 * chooses the arc, the price or the odds.
 *
 * Money (integer cents). Launching debits the fee (`factory_launch_fee`, a
 * Cash sink) and the liquidity (`factory_liquidity`, locked in the coin; also
 * a sink) in one transaction. The creator is credited `devAllocationBps` of
 * the units the liquidity buys at the launch price; the rest is the float that
 * players trade against. Nothing here is a token, withdrawable, or on chain.
 *
 * See docs/FACTORY.md.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  InsufficientCashError,
  LaunchCooldownError,
  LaunchLimitReachedError,
  NameNotAllowedError,
  NotFoundError,
  TickerTakenError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import { cleanCoinText } from './factory-filter.js';
import {
  MOON_MULTIPLE_BPS,
  CREATOR_FEE_SHARE_BPS,
  RUG_SELL_BPS,
  RUG_WINDOW_MS,
} from './factory-rug.js';
import { sampleHiddenArc } from './hidden-arc.js';
import { getHeat, type HeatLevel } from './player-heat.js';
import { publishWorldEvent } from './realtime-bus.js';
import { getCoin, type CoinDetail } from './terminal-cafe.js';

/** Art ids the client maps to coin art. [Inference: placeholder set; FE can extend by PR.] */
export const FACTORY_TEMPLATES = [
  'rf_frog',
  'rf_dog',
  'rf_cat',
  'rf_rocket',
  'rf_robot',
  'rf_skull',
  'rf_diamond',
  'rf_banana',
  'rf_ghost',
  'rf_chad',
  'rf_clown',
  'rf_crown',
] as const;
export type FactoryTemplateId = (typeof FACTORY_TEMPLATES)[number];

/** Tuning values. [Inference: starting numbers, expected to be tuned from play data.] */
export const LAUNCH_FEE_CENTS = 500;
export const MIN_LIQUIDITY_CENTS = 1_000;
export const MAX_LIQUIDITY_CENTS = 100_000;
export const MAX_DEV_ALLOCATION_BPS = 5_000;
export const DAILY_LAUNCH_CAP = 3;
export const LAUNCH_COOLDOWN_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Same launch price as the house launchpad: 0.001 USD per unit. */
const LAUNCH_PRICE_MICROS = 1_000n;
const COIN_SUPPLY = 1_000_000_000n;
const LIST_MAX = 50;

export interface FactoryCoin {
  readonly coinId: string;
  readonly ticker: string;
  readonly name: string;
  readonly templateId: string;
  readonly stage: string;
  readonly priceMicros: string;
  readonly mcapCents: string;
  readonly vol5mCents: string;
  readonly change5mBps: number;
  readonly holders: number;
  readonly launchedAt: string;
  readonly liquidityCents: string;
  readonly devAllocationBps: number;
  readonly creator: { readonly userId: string; readonly alias: string };
  readonly isMine: boolean;
  readonly mooned: boolean;
  readonly rugFlagged: boolean;
  /** Only the creator sees what they earned. */
  readonly creatorFeesCents: string | null;
}

export interface FactoryCoinDetail extends FactoryCoin {
  readonly candles1m: CoinDetail['candles1m'];
  readonly topHolders: CoinDetail['topHolders'];
  readonly riskHint: CoinDetail['riskHint'];
}

export interface LaunchInput {
  readonly name: string;
  readonly ticker: string;
  readonly templateId: string;
  readonly liquidityCents: number;
  readonly devAllocationBps: number;
}

interface Row {
  coin_id: string;
  ticker: string;
  name: string;
  stage: string;
  price_micros: string;
  mcap_cents: string;
  vol_5m_cents: string;
  change_5m_bps: number;
  launched_at: Date;
  holders: number;
  creator_id: string;
  template_id: string;
  liquidity_cents: string;
  dev_allocation_bps: number;
  launch_price_micros: string;
  creator_fees_cents: string;
  mooned_at: Date | null;
  rug_flagged_at: Date | null;
  creator_alias: string | null;
}

const SELECT = `
  SELECT c.coin_id, c.ticker, c.name, c.stage, c.price_micros, c.mcap_cents, c.vol_5m_cents,
         c.change_5m_bps, c.launched_at,
         (SELECT COUNT(*)::int FROM positions p WHERE p.coin_id = c.coin_id AND p.units > 0) AS holders,
         f.creator_id, f.template_id, f.liquidity_cents, f.dev_allocation_bps,
         f.launch_price_micros, f.creator_fees_cents, f.mooned_at, f.rug_flagged_at,
         ch.alias AS creator_alias
    FROM coins c
    JOIN factory_coins f ON f.coin_id = c.coin_id
    LEFT JOIN characters ch ON ch.user_id = f.creator_id`;

function toCoin(r: Row, viewerId: string): FactoryCoin {
  const mine = r.creator_id === viewerId;
  const mooned =
    r.mooned_at !== null ||
    BigInt(r.price_micros) * 10_000n >= BigInt(r.launch_price_micros) * BigInt(MOON_MULTIPLE_BPS);
  return {
    coinId: r.coin_id,
    ticker: r.ticker,
    name: r.name,
    templateId: r.template_id,
    stage: r.stage,
    priceMicros: r.price_micros,
    mcapCents: r.mcap_cents,
    vol5mCents: r.vol_5m_cents,
    change5mBps: r.change_5m_bps,
    holders: r.holders,
    launchedAt: r.launched_at.toISOString(),
    liquidityCents: r.liquidity_cents,
    devAllocationBps: r.dev_allocation_bps,
    creator: { userId: r.creator_id, alias: r.creator_alias ?? 'anon' },
    isMine: mine,
    mooned,
    rugFlagged: r.rug_flagged_at !== null,
    creatorFeesCents: mine ? r.creator_fees_cents : null,
  };
}

/** Static rules for the Launchpad Tower UI. */
export function getFactoryConfig(ctx: AppContext): Record<string, unknown> {
  const mix = ctx.configCache.load<{ outcomeMix: Record<string, number> }>('market').outcomeMix;
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  return {
    launchFeeCents: LAUNCH_FEE_CENTS,
    minLiquidityCents: MIN_LIQUIDITY_CENTS,
    maxLiquidityCents: MAX_LIQUIDITY_CENTS,
    maxDevAllocationBps: MAX_DEV_ALLOCATION_BPS,
    dailyLaunchCap: DAILY_LAUNCH_CAP,
    cooldownSec: LAUNCH_COOLDOWN_MS / 1000,
    name: { min: 2, max: 24 },
    ticker: { min: 2, max: 6 },
    templates: FACTORY_TEMPLATES,
    arcOddsPct: Object.fromEntries(
      Object.entries(mix).map(([k, v]) => [k, Math.round((v * 1000) / total) / 10]),
    ),
    moonMultipleBps: MOON_MULTIPLE_BPS,
    creatorFeeShareBps: CREATOR_FEE_SHARE_BPS,
    rug: { sellBps: RUG_SELL_BPS, windowMin: RUG_WINDOW_MS / 60_000 },
  };
}

async function coinById(
  client: PoolClient,
  coinId: string,
  viewerId: string,
): Promise<FactoryCoin | null> {
  const r = await client.query<Row>(`${SELECT} WHERE c.coin_id = $1`, [coinId]);
  return r.rows[0] ? toCoin(r.rows[0], viewerId) : null;
}

/**
 * Launch a coin.
 * @param ctx - The application context.
 * @param userId - The launcher (from the session; never from the body).
 * @param input - Name, ticker, art id, liquidity and dev allocation.
 * @param idempotencyKey - The request's Idempotency-Key.
 * @param now - The current time (injectable for tests).
 * @param seed - Test hook: fixes the arc seed. The route never passes it.
 */
export async function launchFactoryCoin(
  ctx: AppContext,
  userId: string,
  input: LaunchInput,
  idempotencyKey: string,
  now: Date = new Date(),
  seed?: number,
): Promise<{ coin: FactoryCoin; fresh: boolean }> {
  const clean = cleanCoinText(input.name, input.ticker);
  if (!clean) throw new NameNotAllowedError({ reason: 'name or ticker not allowed' });
  if (!(FACTORY_TEMPLATES as readonly string[]).includes(input.templateId)) {
    throw new ValidationFailedError({ reason: 'unknown templateId' });
  }
  if (
    !Number.isSafeInteger(input.liquidityCents) ||
    input.liquidityCents < MIN_LIQUIDITY_CENTS ||
    input.liquidityCents > MAX_LIQUIDITY_CENTS
  ) {
    throw new ValidationFailedError({
      reason: 'liquidityCents out of range',
      min: MIN_LIQUIDITY_CENTS,
      max: MAX_LIQUIDITY_CENTS,
    });
  }
  if (
    !Number.isSafeInteger(input.devAllocationBps) ||
    input.devAllocationBps < 0 ||
    input.devAllocationBps > MAX_DEV_ALLOCATION_BPS
  ) {
    throw new ValidationFailedError({
      reason: 'devAllocationBps out of range',
      max: MAX_DEV_ALLOCATION_BPS,
    });
  }
  // The arc comes from the server's own odds and RNG, committed at launch.
  const mix = ctx.configCache.load<{
    outcomeMix: { rug: number; slow_bleed: number; sideways: number; moon: number };
  }>('market').outcomeMix;
  const arcSeed = seed ?? (Math.random() * 0x7fffffff) >>> 0;
  const hiddenArc = sampleHiddenArc(arcSeed, mix);
  const ref = `factory-launch:${userId}:${idempotencyKey}`;
  const coinId = uuidv7();
  const liquidity = BigInt(input.liquidityCents);
  // 1 cent = 10,000 micros: units the liquidity buys at the launch price.
  const seedUnits = (liquidity * 10_000n) / LAUNCH_PRICE_MICROS;
  const creatorUnits = (seedUnits * BigInt(input.devAllocationBps)) / 10_000n;
  const total = LAUNCH_FEE_CENTS + input.liquidityCents;

  const done = await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    // The balance lock serialises one player's launches: cap, cooldown and cash can't race.
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const prior = await client.query<{ ref_id: string }>(
      `SELECT ref_id FROM ledger_entries WHERE idempotency_ref = $1`,
      [ref],
    );
    if (prior.rows[0]) {
      const existing = await coinById(client, prior.rows[0].ref_id, userId);
      if (existing) return { coin: existing, fresh: false };
    }
    const recent = await client.query<{ n: string; first: Date | null; last: Date | null }>(
      `SELECT COUNT(*)::text AS n, MIN(created_at) AS first, MAX(created_at) AS last
         FROM factory_coins WHERE creator_id = $1 AND created_at > $2`,
      [userId, new Date(now.getTime() - DAY_MS)],
    );
    const { first, last } = recent.rows[0]!;
    if (last && now.getTime() - last.getTime() < LAUNCH_COOLDOWN_MS) {
      throw new LaunchCooldownError({
        retryAfterMs: LAUNCH_COOLDOWN_MS - (now.getTime() - last.getTime()),
      });
    }
    if (Number(recent.rows[0]!.n) >= DAILY_LAUNCH_CAP) {
      throw new LaunchLimitReachedError({
        cap: DAILY_LAUNCH_CAP,
        // The same moment GET /factory/me reports as nextLaunchAt: the oldest launch in the
        // rolling 24 hours falls out of the window then, and a slot opens.
        retryAfterMs: first ? Math.max(0, first.getTime() + DAY_MS - now.getTime()) : 0,
      });
    }
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(total)) {
      throw new InsufficientCashError({ have: cash.toString(), need: String(total) });
    }
    try {
      await client.query(
        `INSERT INTO coins
           (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents, change_5m_bps,
            holders, launched_at, hidden_arc, seed, player_launched, creator_id)
         VALUES ($1, $2, $3, 'new', $4, $5, 0, 0, 0, $6, $7, $8, true, $9)`,
        [
          coinId,
          clean.ticker,
          clean.name,
          LAUNCH_PRICE_MICROS.toString(),
          ((LAUNCH_PRICE_MICROS * COIN_SUPPLY) / 1_000_000n).toString(),
          now,
          JSON.stringify(hiddenArc),
          arcSeed.toString(),
          userId,
        ],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new TickerTakenError({});
      throw e;
    }
    await client.query(
      `INSERT INTO factory_coins
         (coin_id, creator_id, template_id, liquidity_cents, launch_fee_cents, dev_allocation_bps,
          launch_price_micros, creator_units, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        coinId,
        userId,
        input.templateId,
        input.liquidityCents,
        LAUNCH_FEE_CENTS,
        input.devAllocationBps,
        LAUNCH_PRICE_MICROS.toString(),
        creatorUnits.toString(),
        now,
      ],
    );
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $2, updated_at = now() WHERE user_id = $1`,
      [userId, total],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'factory_launch_fee', 'coin', $3, $4)`,
      [userId, -LAUNCH_FEE_CENTS, coinId, ref],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'factory_liquidity', 'coin', $3, $4)`,
      [userId, -input.liquidityCents, coinId, `${ref}:liq`],
    );
    if (creatorUnits > 0n) {
      await client.query(
        `INSERT INTO positions (position_id, user_id, coin_id, units, cost_basis_cents)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          uuidv7(),
          userId,
          coinId,
          creatorUnits.toString(),
          ((liquidity * BigInt(input.devAllocationBps)) / 10_000n).toString(),
        ],
      );
    }
    const coin = await coinById(client, coinId, userId);
    return { coin: coin!, fresh: true };
  });

  if (done.fresh) {
    // The market room mirrors the coins table every 2 s and the sim starts
    // ticking the coin within 5 s; this tells the city now.
    await publishWorldEvent(ctx, 'evt_coin_launch', {
      coinId: done.coin.coinId,
      ticker: done.coin.ticker,
      playerLaunched: '1',
      templateId: done.coin.templateId,
      creatorAlias: done.coin.creator.alias,
    });
  }
  return done;
}

export type FactoryView = 'trending' | 'new' | 'mine';

/**
 * List player coins.
 * @param ctx - The application context.
 * @param userId - The viewer.
 * @param view - `trending` (live coins by 5m volume), `new` (newest live) or `mine` (all of mine).
 * @param limit - 1..50.
 */
export async function listFactoryCoins(
  ctx: AppContext,
  userId: string,
  view: FactoryView,
  limit: number,
): Promise<FactoryCoin[]> {
  const n = Math.max(1, Math.min(limit, LIST_MAX));
  let where = `c.stage <> 'dead'`;
  let order = `c.vol_5m_cents DESC, c.launched_at DESC`;
  const params: unknown[] = [];
  if (view === 'mine') {
    params.push(userId);
    where = `f.creator_id = $1`;
    order = `c.launched_at DESC`;
  } else if (view === 'new') {
    order = `c.launched_at DESC`;
  }
  params.push(n);
  const r = await ctx.db.withConnection((c) =>
    c.query<Row>(`${SELECT} WHERE ${where} ORDER BY ${order} LIMIT $${params.length}`, params),
  );
  return r.rows.map((row) => toCoin(row, userId));
}

/**
 * One player coin with its chart (the market candles), top holders and risk hint.
 * @param ctx - The application context.
 * @param userId - The viewer.
 * @param coinId - The coin; a house coin id is a 404 here.
 */
export async function getFactoryCoin(
  ctx: AppContext,
  userId: string,
  coinId: string,
): Promise<FactoryCoinDetail> {
  const r = await ctx.db.withConnection((c) =>
    c.query<Row>(`${SELECT} WHERE c.coin_id = $1`, [coinId]),
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ kind: 'coin', id: coinId });
  const market = await getCoin(ctx, userId, coinId);
  return {
    ...toCoin(row, userId),
    candles1m: market.candles1m,
    topHolders: market.topHolders,
    riskHint: market.riskHint,
  };
}

export interface FactoryMe {
  readonly heat: number;
  readonly heatLevel: HeatLevel;
  readonly launchesToday: number;
  readonly dailyLaunchCap: number;
  readonly nextLaunchAt: string | null;
}

/**
 * The caller's Factory state: heat and launch allowance.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param now - The current time.
 */
export async function getFactoryMe(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<FactoryMe> {
  const h = await getHeat(ctx, userId, now);
  const r = await ctx.db.withConnection((c) =>
    c.query<{ n: string; first: Date | null; last: Date | null }>(
      `SELECT COUNT(*)::text AS n, MIN(created_at) AS first, MAX(created_at) AS last
         FROM factory_coins WHERE creator_id = $1 AND created_at > $2`,
      [userId, new Date(now.getTime() - DAY_MS)],
    ),
  );
  const n = Number(r.rows[0]!.n);
  const { first, last } = r.rows[0]!;
  let next: number | null = null;
  if (last) next = last.getTime() + LAUNCH_COOLDOWN_MS;
  if (n >= DAILY_LAUNCH_CAP && first) next = Math.max(next ?? 0, first.getTime() + DAY_MS);
  return {
    heat: h.heat,
    heatLevel: h.level,
    launchesToday: n,
    dailyLaunchCap: DAILY_LAUNCH_CAP,
    nextLaunchAt: next !== null && next > now.getTime() ? new Date(next).toISOString() : null,
  };
}
