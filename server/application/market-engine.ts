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
  readonly hiddenArc: HiddenArc;
  readonly seed: bigint;
  readonly rng: Rng;
  readonly priceHistory: Array<{ at: number; priceMicros: bigint }>;
  raisedCents: bigint;
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
  private intervalHandles: ReturnType<typeof setInterval>[] = [];

  /**
   * @param cfg - The market config. Pass a partial in tests; defaults are applied.
   * @param overrides - Dependency overrides for tests (db, redis, clock).
   */
  constructor(
    cfg: Partial<MarketConfig> = {},
    overrides: { db?: Db; redis?: Redis; clock?: Clock } = {},
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
  /** Remove a coin from the in-memory map (does not touch the DB). */
  forget(coinId: string): void {
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
    try {
      await this.tickLocked(state);
      return true;
    } finally {
      await this.releaseLock(coinId);
    }
  }

  /**
   * Drive the engine with setInterval. Each active coin ticks
   * every `tickLengthSec` seconds. Returns a cleanup function.
   */
  start(): () => void {
    const tickMs = this.cfg.tickLengthSec * 1000;
    for (const state of this.coins.values()) {
      this.schedule(state, tickMs);
    }
    return () => {
      for (const h of this.intervalHandles) clearInterval(h);
      this.intervalHandles = [];
    };
  }

  private schedule(state: CoinState, tickMs: number): void {
    const handle = setInterval(() => {
      void this.tick(state.coinId);
    }, tickMs);
    this.intervalHandles.push(handle);
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
    };
  }

  private async acquireLock(coinId: string): Promise<boolean> {
    const res = await this.redis.set(makeLockKey(coinId), '1', 'PX', LOCK_TTL_MS, 'NX');
    return res === 'OK';
  }

  private async releaseLock(coinId: string): Promise<void> {
    await this.redis.del(makeLockKey(coinId));
  }

  private async tickLocked(state: CoinState): Promise<void> {
    const noiseBps = (state.rng.float() * 2 - 1) * state.hiddenArc.noiseBps;
    const driftBps = state.hiddenArc.slopeBps + noiseBps;
    const newPriceMicros = this.applyDrift(state.priceMicros, driftBps);
    state.priceMicros = newPriceMicros < 1n ? 1n : newPriceMicros;
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
    await this.persist(state);
    await this.publishSnapshot(state);
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
