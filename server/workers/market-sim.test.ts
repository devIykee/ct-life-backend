/**
 * Market simulation (GitHub #5).
 *
 * The hosted market answered 200 with no coins: nothing ever launched
 * one and the workers never started the MarketEngine. Pins: a house
 * coin launches when there is room (one replica per interval, never
 * past maxActiveCoins), ticks start from the stored price, and a coin
 * that draws down past its arc dies, stops ticking and is announced.
 *
 * Uses the dev Postgres and Redis.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext } from '../application/context.js';
import {
  isDrawnDown,
  MarketEngine,
  MAX_PRICE_MICROS,
  type HiddenArc,
} from '../application/market-engine.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { houseCoinName, launchIfRoom } from './market-sim.js';

loadDotenv({ path: process.cwd() + '/.env' });

const ctx = buildContext();
const created: string[] = [];
const market = ctx.configCache.load<Parameters<typeof launchIfRoom>[1]>('market');

async function liveCount(): Promise<number> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ n: string }>(`SELECT count(*) AS n FROM coins WHERE stage <> 'dead'`),
  );
  return Number(r.rows[0]!.n);
}

async function insertCoin(arc: HiddenArc, priceMicros = 1_000_000): Promise<string> {
  const id = uuidv7();
  await ctx.db.withConnection((c) =>
    c.query(
      `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, launched_at, hidden_arc, seed)
       VALUES ($1, $2, 'Sim Test', 'new', $3, 0, now(), $4, 42)`,
      [id, `T${id.slice(-7)}`, priceMicros, JSON.stringify(arc)],
    ),
  );
  created.push(id);
  return id;
}

async function stage(id: string): Promise<{ stage: string; price: number }> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ stage: string; price_micros: string }>(
      `SELECT stage, price_micros FROM coins WHERE coin_id = $1`,
      [id],
    ),
  );
  return { stage: r.rows[0]!.stage, price: Number(r.rows[0]!.price_micros) };
}

beforeEach(async () => {
  await ctx.redis.main.del('market:launch:lock');
});

afterAll(async () => {
  await ctx.db.withConnection((c) =>
    c.query(`DELETE FROM coins WHERE coin_id = ANY($1::uuid[])`, [created]),
  );
  await ctx.redis.main.del('market:launch:lock');
});

describe('house coin launcher', () => {
  it('launches one coin per interval while under maxActiveCoins', async () => {
    const live = await liveCount();
    const cfg = { ...market, maxActiveCoins: live + 1 };
    const id = await launchIfRoom(ctx, cfg);
    expect(id).not.toBeNull();
    created.push(id!);
    expect((await stage(id!)).stage).toBe('new');

    // Same interval (lock held): no second launch.
    expect(await launchIfRoom(ctx, { ...cfg, maxActiveCoins: live + 5 })).toBeNull();
    // New interval but at the cap: no launch.
    await ctx.redis.main.del('market:launch:lock');
    expect(await launchIfRoom(ctx, cfg)).toBeNull();
  });

  it('names coins with a 2..8 char ticker', () => {
    for (let i = 0; i < 50; i++) {
      const { name, ticker } = houseCoinName();
      expect(name).toMatch(/^\w+ \w+$/);
      expect(ticker).toMatch(/^[A-Z]{2,8}$/);
    }
  });
});

describe('MarketEngine lifecycle', () => {
  it('detects a drawdown from the peak; 0 never trips', () => {
    expect(isDrawnDown(1_000n, 500n, 5_000)).toBe(true);
    expect(isDrawnDown(1_000n, 501n, 5_000)).toBe(false);
    expect(isDrawnDown(1_000n, 1n, 0)).toBe(false);
  });

  it('ticks from the stored price, so a trade between ticks is kept', async () => {
    const id = await insertCoin({ outcome: 'sideways', slopeBps: 0, noiseBps: 0, drawdownBps: 0 });
    const engine = new MarketEngine(market, { db: ctx.db, redis: ctx.redis.main });
    await engine.track(id);
    await ctx.db.withConnection((c) =>
      c.query(`UPDATE coins SET price_micros = 2500000 WHERE coin_id = $1`, [id]),
    );
    expect(await engine.tick(id)).toBe(true);
    expect((await stage(id)).price).toBe(2_500_000);
  });

  it('pulls a runaway coin back under the ceiling and turns its run (no bigint overflow)', async () => {
    // Production 2026-10-30: price ~9.3e15 micros, so mcap_cents ~9.3e18 overflowed bigint on every UPDATE.
    const id = await insertCoin(
      { outcome: 'moon', slopeBps: 300, noiseBps: 0, drawdownBps: 9_500 },
      9_300_000_000_000_000,
    );
    const engine = new MarketEngine(market, { db: ctx.db, redis: ctx.redis.main });
    await engine.track(id);
    await engine.tick(id);
    const top = await ctx.db.withConnection((c) =>
      c.query<{ price_micros: string; mcap_cents: string; stage: string }>(
        `SELECT price_micros, mcap_cents, stage FROM coins WHERE coin_id = $1`,
        [id],
      ),
    );
    expect(BigInt(top.rows[0]!.price_micros)).toBe(MAX_PRICE_MICROS);
    expect(BigInt(top.rows[0]!.mcap_cents)).toBe(MAX_PRICE_MICROS * 1_000n);
    expect(top.rows[0]!.stage).not.toBe('dead');
    await engine.tick(id);
    expect(BigInt((await stage(id)).price)).toBeLessThan(MAX_PRICE_MICROS);
  });

  it('kills a rugging coin once, stops ticking it and reports it', async () => {
    const id = await insertCoin({
      outcome: 'rug',
      slopeBps: -2_000,
      noiseBps: 0,
      drawdownBps: 9_500,
    });
    const onDead = vi.fn(async () => undefined);
    const engine = new MarketEngine(market, { db: ctx.db, redis: ctx.redis.main, onDead });
    await engine.track(id);
    let ticks = 0;
    while (engine.get(id) !== null && ticks < 100) {
      await engine.tick(id);
      ticks++;
    }
    expect(ticks).toBeLessThan(100);
    expect((await stage(id)).stage).toBe('dead');
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(await engine.tick(id)).toBe(false);
  });
});
