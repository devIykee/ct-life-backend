/**
 * Market engine.
 *
 * The single writer of every coin's `price_micros`, `mcap_cents`,
 * `vol_5m_cents`, and `change_5m_bps`. The engine holds an
 * in-memory map of active coins. For each coin, a per-coin
 * BullMQ repeatable job (every `tickLengthSec`, default 2 s) is
 * the writer.
 *
 * Single-writer enforcement:
 *
 *   The job uses a Redis SETNX lock per coin (key
 *   `market:lock:<coin_id>`, TTL 1500 ms) to guarantee that only
 *   one worker replica holds the write lease. The tick interval
 *   is 2000 ms; the lock TTL is 1500 ms so the lock is always
 *   held by the current tick.
 *
 * Stage lifecycle:
 *
 *   - `new`       — bonding curve (linear, base_price +
 *                    raised/supply * slope)
 *   - `final`     — virtual-reserve constant-product AMM (x*y=k)
 *   - `graduated` — survived; price follows the AMM
 *   - `dead`      — rug or slow-bleed completed; tombstone row
 *
 * Graduation happens when raised balance >= the configured
 * `graduateMcapCents`. The engine transitions the stage atomically
 * with the new price write.
 *
 * Death: a coin whose price falls `hiddenArc.drawdownBps` below its
 * peak goes to `dead` and stops ticking (a 0 drawdown never dies).
 * Each tick starts from the stored price, so trade impact is kept.
 *
 * The engine runs as a singleton in the workers process. The API
 * reads via `GET /v1/market/coins`. The engine is paused on
 * `config.market.paused = true` (set by the runtime feature flag).
 *
 * Determinism:
 *
 *   Tests run on a `SimulatedClock` and a fixed seed. The price
 *   path is asserted to be deterministic.
 */
import type { PoolClient } from 'pg';
import type { Redis } from 'ioredis';
import type { Db } from '../shared/db/pool.js';
import { createDb } from '../shared/db/pool.js';
import { createRedis } from '../shared/redis/client.js';
import { SeededRng, type Rng } from '../shared/domain/rng.js';
import type { Clock } from '../shared/domain/clock.js';
import { SystemClock } from '../shared/domain/clock.js';
import type { HiddenArc } from './hidden-arc.js';
export { ammQuote } from './amm.js';
export { sampleHiddenArc, type ArcOutcome, type HiddenArc } from './hidden-arc.js';

/** Coin row as the engine sees it (subset of the table). */
export interface CoinState {
  readonly coinId: string;
  readonly ticker: string;
  readonly name: string;
  stage: 'new' | 'final' | 'graduated' | 'dead';
  priceMicros: bigint;
  mcapCents: bigint;
  vol5mCents: bigint;
  change5mBps: number;
  holders: number;
  readonly launchedAt: number;
  /** Turned at the price ceiling (slope flips negative), so not readonly. */
  hiddenArc: HiddenArc;
  readonly seed: bigint;
  readonly rng: Rng;
  readonly priceHistory: Array<{ at: number; priceMicros: bigint }>;
  raisedCents: bigint;
  /** Highest price seen since the engine loaded the coin. */
  peakMicros: bigint;
}

/** Market engine configuration, loaded from contract/config/market.json. */
export interface MarketConfig {
  readonly version: string;
  readonly tickLengthSec: number;
  readonly maxActiveCoins: number;
  readonly curve: {
    readonly type: string;
    readonly virtualReservesX: number;
    readonly virtualReservesY: number;
    readonly graduateMcapCents: number;
  };
  readonly outcomeMix: {
    readonly rug: number;
    readonly slow_bleed: number;
    readonly sideways: number;
    readonly moon: number;
  };
  readonly feesBps: { readonly buy: number; readonly sell: number };
  readonly minTradeCents: number;
  readonly tapeThresholdCents: number;
}

const DEFAULT_TICK_LENGTH_SEC = 2;
const LOCK_TTL_MS = 1500;
const SNAPSHOT_TTL_SEC = 30;

/**
 * The ceiling for a simulated coin: a $1T market cap. A positive slope compounds every tick and nothing else
 * stops a rising coin, so without a top the price grew until mcap_cents overflowed bigint (every UPDATE then
 * failed, the coin froze and logged an error each tick). At the top the run turns: the slope flips negative.
 */
export const MAX_MCAP_CENTS = 100_000_000_000_000n;
/** Price matching {@link MAX_MCAP_CENTS} (mcap_cents = price_micros * 1000). */
export const MAX_PRICE_MICROS = MAX_MCAP_CENTS / 1_000n;

/** True once `price` is `drawdownBps` or more below `peak`. A 0 drawdown never trips. */
export function isDrawnDown(peak: bigint, price: bigint, drawdownBps: number): boolean {
  if (drawdownBps <= 0 || peak <= 0n) return false;
  return (peak - price) * 10_000n >= peak * BigInt(drawdownBps);
}

function makeLockKey(coinId: string): string {
  return `market:lock:${coinId}`;
}

function makeSnapshotKey(coinId: string): string {
  return `market:coin:${coinId}`;
}

export class MarketEngine {
  private readonly db: Db;
  private readonly redis: Redis;
  private readonly clock: Clock;
  private readonly coins = new Map<string, CoinState>();
  private readonly cfg: MarketConfig;
  private paused = false;
  private running = false;
  private readonly intervals = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly onDead: ((state: CoinState) => Promise<void>) | undefined;

  /**
   * @param cfg - The market config. Pass a partial in tests; defaults are applied.
   * @param overrides - Dependency overrides for tests (db, redis, clock).
   */
  constructor(
    cfg: Partial<MarketConfig> = {},
    overrides: {
      db?: Db;
      redis?: Redis;
      clock?: Clock;
      onDead?: (state: CoinState) => Promise<void>;
    } = {},
  ) {
    this.cfg = {
      version: '1.0.0-rc1',
      tickLengthSec: cfg.tickLengthSec ?? DEFAULT_TICK_LENGTH_SEC,
      maxActiveCoins: cfg.maxActiveCoins ?? 40,
      curve: cfg.curve ?? {
        type: 'constant_product',
        virtualReservesX: 1_000_000,
        virtualReservesY: 30_000_000,
        graduateMcapCents: 500_000_000,
      },
      outcomeMix: cfg.outcomeMix ?? { rug: 25, slow_bleed: 40, sideways: 20, moon: 15 },
      feesBps: cfg.feesBps ?? { buy: 100, sell: 100 },
      minTradeCents: cfg.minTradeCents ?? 100,
      tapeThresholdCents: cfg.tapeThresholdCents ?? 100_000,
    };
    this.db = overrides.db ?? createDb();
    this.redis = overrides.redis ?? createRedis().main;
    this.clock = overrides.clock ?? new SystemClock();
    this.onDead = overrides.onDead;
  }

  /**
   * Pause the engine. The API keeps serving the last snapshot,
   * but no ticks run.
   */
  pause(): void {
    this.paused = true;
  }
  /** Resume the engine. */
  resume(): void {
    this.paused = false;
  }
  /** @returns The current paused state. */
  isPaused(): boolean {
    return this.paused;
  }
  /** @returns The number of coins currently in the in-memory map. */
  size(): number {
    return this.coins.size;
  }

  /**
   * Load a coin from the DB into the in-memory map.
   * @param coinId - The coin to load.
   */
  async load(coinId: string): Promise<CoinState> {
    const state = await this.fetchCoin(coinId);
    this.coins.set(coinId, state);
    return state;
  }
  /**
   * Load a coin and, if the engine is running, start ticking it.
   * No-op for a coin already tracked.
   */
  async track(coinId: string): Promise<void> {
    if (this.coins.has(coinId)) return;
    const state = await this.load(coinId);
    if (this.running && state.stage !== 'dead') this.schedule(state, this.cfg.tickLengthSec * 1000);
  }
  /** Remove a coin from the in-memory map (does not touch the DB). */
  forget(coinId: string): void {
    const h = this.intervals.get(coinId);
    if (h !== undefined) clearTimeout(h);
    this.intervals.delete(coinId);
    this.coins.delete(coinId);
  }
  /** @returns The in-memory coin state, or null. */
  get(coinId: string): CoinState | null {
    return this.coins.get(coinId) ?? null;
  }
  /** @returns All in-memory coin states. */
  list(): CoinState[] {
    return Array.from(this.coins.values());
  }

  /**
   * Tick a single coin under the single-writer lock. Returns
   * false if a peer held the lock for this tick.
   */
  async tick(coinId: string): Promise<boolean> {
    if (this.paused) return false;
    const state = this.coins.get(coinId);
    if (state === undefined) return false;
    if (state.stage === 'dead') return false;
    const acquired = await this.acquireLock(coinId);
    if (!acquired) return false;
    let died: boolean;
    try {
      died = await this.tickLocked(state);
    } finally {
      await this.releaseLock(coinId);
    }
    if (died) {
      this.forget(coinId);
      if (this.onDead) await this.onDead(state);
    }
    return true;
  }

  /**
   * Drive the engine with setInterval. Each active coin ticks
   * every `tickLengthSec` seconds. Returns a cleanup function.
   */
  start(): () => void {
    const tickMs = this.cfg.tickLengthSec * 1000;
    this.running = true;
    for (const state of this.coins.values()) {
      if (state.stage !== 'dead') this.schedule(state, tickMs);
    }
    return () => {
      this.running = false;
      for (const h of this.intervals.values()) clearTimeout(h);
      this.intervals.clear();
    };
  }

  /**
   * Tick a coin every `tickMs`, starting at a random offset so the
   * coins spread across the interval instead of all hitting the DB
   * pool on the same beat.
   */
  private schedule(state: CoinState, tickMs: number): void {
    if (this.intervals.has(state.coinId)) return;
    const run = (): void => void this.tick(state.coinId).catch(() => undefined);
    const start = setTimeout(
      () => {
        if (!this.intervals.has(state.coinId)) return;
        run();
        this.intervals.set(state.coinId, setInterval(run, tickMs));
      },
      Math.floor(Math.random() * tickMs),
    );
    this.intervals.set(state.coinId, start);
  }

  private async fetchCoin(coinId: string): Promise<CoinState> {
    const r = await this.db.withConnection(async (c: PoolClient) => {
      return c.query<{
        coin_id: string;
        ticker: string;
        name: string;
        stage: 'new' | 'final' | 'graduated' | 'dead';
        price_micros: string;
        mcap_cents: string;
        vol_5m_cents: string;
        change_5m_bps: number;
        holders: number;
        launched_at: Date;
        hidden_arc: HiddenArc;
        seed: string;
      }>(
        `SELECT coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
                change_5m_bps, holders, launched_at, hidden_arc, seed
         FROM coins WHERE coin_id = $1`,
        [coinId],
      );
    });
    const row = r.rows[0];
    if (row === undefined) throw new Error(`coin not found: ${coinId}`);
    const seed = BigInt(row.seed);
    return {
      coinId: row.coin_id,
      ticker: row.ticker,
      name: row.name,
      stage: row.stage,
      priceMicros: BigInt(row.price_micros),
      mcapCents: BigInt(row.mcap_cents),
      vol5mCents: BigInt(row.vol_5m_cents),
      change5mBps: row.change_5m_bps,
      holders: row.holders,
      launchedAt: row.launched_at.getTime(),
      hiddenArc: row.hidden_arc,
      seed,
      rng: new SeededRng(Number(seed & 0x7fffffffn)),
      priceHistory: [{ at: this.clock.now(), priceMicros: BigInt(row.price_micros) }],
      raisedCents: 0n,
      peakMicros: BigInt(row.price_micros),
    };
  }

  private async acquireLock(coinId: string): Promise<boolean> {
    const res = await this.redis.set(makeLockKey(coinId), '1', 'PX', LOCK_TTL_MS, 'NX');
    return res === 'OK';
  }

  private async releaseLock(coinId: string): Promise<void> {
    await this.redis.del(makeLockKey(coinId));
  }

  /** One tick under the lock. @returns true when the coin died on this tick. */
  private async tickLocked(state: CoinState): Promise<boolean> {
    // Start from the stored row: trades move the price between ticks,
    // and an admin may have killed the coin.
    const stored = await this.db.withConnection((c: PoolClient) =>
      c.query<{ price_micros: string; stage: CoinState['stage'] }>(
        `SELECT price_micros, stage FROM coins WHERE coin_id = $1`,
        [state.coinId],
      ),
    );
    const row = stored.rows[0];
    if (row === undefined || row.stage === 'dead') {
      state.stage = 'dead';
      return true;
    }
    state.priceMicros = BigInt(row.price_micros);
    state.stage = row.stage;
    // Rows that ran past the ceiling before it existed come back under it (and keep a peak they can fall from).
    if (state.priceMicros > MAX_PRICE_MICROS) state.priceMicros = MAX_PRICE_MICROS;
    if (state.peakMicros > MAX_PRICE_MICROS) state.peakMicros = MAX_PRICE_MICROS;
    const noiseBps = (state.rng.float() * 2 - 1) * state.hiddenArc.noiseBps;
    const driftBps = state.hiddenArc.slopeBps + noiseBps;
    const newPriceMicros = this.applyDrift(state.priceMicros, driftBps);
    state.priceMicros = newPriceMicros < 1n ? 1n : newPriceMicros;
    if (state.priceMicros >= MAX_PRICE_MICROS) {
      state.priceMicros = MAX_PRICE_MICROS;
      if (state.hiddenArc.slopeBps > 0) {
        state.hiddenArc = { ...state.hiddenArc, slopeBps: -state.hiddenArc.slopeBps };
      }
    }
    state.mcapCents = (state.priceMicros * 1_000_000_000n) / 1_000_000n;
    state.priceHistory.push({ at: this.clock.now(), priceMicros: state.priceMicros });
    if (state.priceHistory.length > 60) state.priceHistory.shift();
    if (state.priceHistory.length >= 2) {
      const first = state.priceHistory[0]!.priceMicros;
      const last = state.priceMicros;
      state.change5mBps = Number(((last - first) * 10_000n) / (first === 0n ? 1n : first));
    }
    if (state.stage === 'new' && state.mcapCents >= BigInt(this.cfg.curve.graduateMcapCents)) {
      state.stage = 'final';
    }
    if (state.priceMicros > state.peakMicros) state.peakMicros = state.priceMicros;
    if (isDrawnDown(state.peakMicros, state.priceMicros, state.hiddenArc.drawdownBps)) {
      state.stage = 'dead';
    }
    await this.persist(state);
    await this.publishSnapshot(state);
    return state.stage === 'dead';
  }

  private applyDrift(price: bigint, bps: number): bigint {
    const b = BigInt(Math.round(bps));
    const num = price * b;
    const rem = num % 10_000n;
    const delta = num / 10_000n + (rem >= 5_000n ? (b >= 0n ? 1n : -1n) : 0n);
    return price + delta;
  }

  private async persist(state: CoinState): Promise<void> {
    await this.db.withConnection(async (c: PoolClient) => {
      await c.query(
        `UPDATE coins
         SET price_micros = $2, mcap_cents = $3, vol_5m_cents = $4,
             change_5m_bps = $5, holders = $6, stage = $7
         WHERE coin_id = $1`,
        [
          state.coinId,
          state.priceMicros.toString(),
          state.mcapCents.toString(),
          state.vol5mCents.toString(),
          state.change5mBps,
          state.holders,
          state.stage,
        ],
      );
    });
  }

  private async publishSnapshot(state: CoinState): Promise<void> {
    const snap = {
      coinId: state.coinId,
      ticker: state.ticker,
      stage: state.stage,
      priceMicros: state.priceMicros.toString(),
      mcapCents: state.mcapCents.toString(),
      change5mBps: state.change5mBps,
      holders: state.holders,
      // The candle strip `GET /market/coins/:id` and the Factory detail serve.
      priceHistory: state.priceHistory.map((p) => ({
        at: p.at,
        priceMicros: p.priceMicros.toString(),
      })),
      at: this.clock.now(),
    };
    await this.redis.set(
      makeSnapshotKey(state.coinId),
      JSON.stringify(snap),
      'EX',
      SNAPSHOT_TTL_SEC,
    );
  }
}
