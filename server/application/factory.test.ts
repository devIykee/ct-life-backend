/**
 * Rugpull Factory tests: launch (debit, coin row, Pulse broadcast), the name
 * filter, daily cap and cooldown, trading a player coin, the creator fee on a
 * moon, rug detection (heat, exactly one Sleuth post, rate limit) and an
 * idempotent launch replay.
 *
 * The world-event publisher is stubbed; everything else hits the real DB.
 */
import { Pool } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';

vi.mock('./realtime-bus.js', async (orig) => ({
  ...(await orig<typeof import('./realtime-bus.js')>()),
  publishWorldEvent: vi.fn(async () => undefined),
  publishToUser: vi.fn(async () => undefined),
}));

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  InsufficientCashError,
  LaunchCooldownError,
  LaunchLimitReachedError,
  NameNotAllowedError,
  NotFoundError,
  TickerTakenError,
  ValidationFailedError,
  FactoryCashRetiredError,
} from '../shared/domain/errors.js';
import {
  DAILY_LAUNCH_CAP,
  getFactoryCoin,
  getFactoryMe,
  LAUNCH_COOLDOWN_MS,
  LAUNCH_FEE_CENTS,
  launchFactoryCoin,
  listFactoryCoins,
  type LaunchInput,
} from './factory.js';
import { cleanCoinText, isBlockedText } from './factory-filter.js';
import { sleuthPostText } from './factory-rug.js';
import { decayHeat, HEAT_HALF_LIFE_MS } from './player-heat.js';
import { executeTrade } from './terminal-cafe.js';
import { listMarketCoins } from './world-pulse.js';
import { publishWorldEvent } from './realtime-bus.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const RUN = Math.random().toString(36).slice(2, 7);

afterAll(async () => {
  await pool.end();
});

let tickerN = Math.floor(Math.random() * 9000);
function ticker(): string {
  tickerN = (tickerN + 1) % 10000;
  return `ZX${String(tickerN).padStart(4, '0')}`;
}

async function newUser(cashCents: number, alias?: string): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `fac-${id}`]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = 0`,
    [id, cashCents],
  );
  if (alias) {
    await pool.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
       VALUES ($1, $2, $3, '{}', 'degen', '{}', 'whale', 'parents_basement')`,
      [uuidv7(), id, `${alias}${RUN}`],
    );
  }
  return id;
}

async function cashOf(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? '0');
}

async function ledger(userId: string, reason: string): Promise<number[]> {
  const r = await pool.query<{ delta_cents: string }>(
    `SELECT delta_cents FROM ledger_entries WHERE user_id = $1 AND reason = $2 ORDER BY id`,
    [userId, reason],
  );
  return r.rows.map((x) => Number(x.delta_cents));
}

function input(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    name: 'Moon Frog',
    ticker: ticker(),
    templateId: 'rf_frog',
    liquidityCents: 5_000,
    devAllocationBps: 5_000,
    ...over,
  };
}

async function launch(userId: string, over: Partial<LaunchInput> = {}, seed?: number) {
  const { coin } = await launchFactoryCoin(ctx, userId, input(over), uuidv7(), new Date(), seed);
  return coin;
}

async function buy(userId: string, coinId: string, cashCents: number) {
  return executeTrade(ctx, { userId, coinId, side: 'buy', cashCents, maxSlippageBps: 1_000 });
}

async function sellAll(userId: string, coinId: string) {
  const p = await pool.query<{ units: string }>(
    `SELECT units FROM positions WHERE user_id = $1 AND coin_id = $2`,
    [userId, coinId],
  );
  return executeTrade(ctx, {
    userId,
    coinId,
    side: 'sell',
    units: p.rows[0]!.units,
    maxSlippageBps: 1_000,
  });
}

describe('launch', () => {
  it('debits fee and liquidity, creates a flagged coin with the creator position', async () => {
    const u = await newUser(100_000, 'frogdev');
    const input1 = input();
    const { coin, fresh } = await launchFactoryCoin(ctx, u, input1, uuidv7());
    expect(fresh).toBe(true);
    expect(coin).toMatchObject({
      ticker: input1.ticker,
      name: 'Moon Frog',
      templateId: 'rf_frog',
      stage: 'new',
      isMine: true,
      mooned: false,
      rugFlagged: false,
      liquidityCents: '5000',
      devAllocationBps: 5000,
      creator: { userId: u, alias: `frogdev${RUN}` },
    });
    expect(JSON.stringify(coin)).not.toContain('hiddenArc');
    expect(await cashOf(u)).toBe(100_000 - LAUNCH_FEE_CENTS - 5_000);
    expect(await ledger(u, 'factory_launch_fee')).toEqual([-LAUNCH_FEE_CENTS]);
    expect(await ledger(u, 'factory_liquidity')).toEqual([-5_000]);

    const row = await pool.query(
      `SELECT player_launched, creator_id, hidden_arc FROM coins WHERE coin_id = $1`,
      [coin.coinId],
    );
    expect(row.rows[0].player_launched).toBe(true);
    expect(row.rows[0].creator_id).toBe(u);
    expect(['rug', 'slow_bleed', 'sideways', 'moon']).toContain(row.rows[0].hidden_arc.outcome);
    // 5000 cents buys 50,000 units at the launch price; 50% to the dev.
    const pos = await pool.query(`SELECT units FROM positions WHERE user_id = $1`, [u]);
    expect(pos.rows[0].units).toBe('25000');
  });

  it('announces on the city and shows on the Pulse board and in the lists', async () => {
    const u = await newUser(50_000);
    const coin = await launch(u);
    expect(publishWorldEvent).toHaveBeenCalledWith(
      expect.anything(),
      'evt_coin_launch',
      expect.objectContaining({ coinId: coin.coinId, playerLaunched: '1', templateId: 'rf_frog' }),
    );
    const pulse = await listMarketCoins(ctx, 50);
    const onBoard = pulse.find((c) => c.coinId === coin.coinId);
    expect(onBoard).toMatchObject({ playerLaunched: true, templateId: 'rf_frog' });
    const mine = await listFactoryCoins(ctx, u, 'mine', 10);
    expect(mine.map((c) => c.coinId)).toContain(coin.coinId);
    const fresh = await listFactoryCoins(ctx, u, 'new', 50);
    expect(fresh.map((c) => c.coinId)).toContain(coin.coinId);
    const trending = await listFactoryCoins(ctx, u, 'trending', 50);
    expect(trending.every((c) => c.stage !== 'dead')).toBe(true);
  });

  it('replays an idempotent launch without charging twice', async () => {
    const u = await newUser(50_000);
    const body = input();
    const key = uuidv7();
    const a = await launchFactoryCoin(ctx, u, body, key);
    const b = await launchFactoryCoin(ctx, u, body, key);
    expect(a.fresh).toBe(true);
    expect(b.fresh).toBe(false);
    expect(b.coin.coinId).toBe(a.coin.coinId);
    expect(await cashOf(u)).toBe(50_000 - LAUNCH_FEE_CENTS - 5_000);
    expect(await ledger(u, 'factory_launch_fee')).toHaveLength(1);
  });

  it('refuses without enough Cash, a taken ticker, bad numbers and an unknown template', async () => {
    const poor = await newUser(LAUNCH_FEE_CENTS + 5_000 - 1);
    await expect(launchFactoryCoin(ctx, poor, input(), uuidv7())).rejects.toBeInstanceOf(
      InsufficientCashError,
    );
    expect(await cashOf(poor)).toBe(LAUNCH_FEE_CENTS + 5_000 - 1);

    const u = await newUser(100_000);
    const t = ticker();
    await launch(u, { ticker: t });
    const other = await newUser(100_000);
    await expect(
      launchFactoryCoin(ctx, other, input({ ticker: t.toLowerCase() }), uuidv7()),
    ).rejects.toBeInstanceOf(TickerTakenError);
    expect(await cashOf(other)).toBe(100_000);

    for (const bad of [
      { liquidityCents: 10 },
      { liquidityCents: 9_999_999 },
      { liquidityCents: 1500.5 },
      { devAllocationBps: 9_000 },
      { devAllocationBps: -1 },
      { templateId: 'rf_nope' },
    ]) {
      await expect(launchFactoryCoin(ctx, other, input(bad), uuidv7())).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
    }
  });

  it('enforces the cooldown and the daily cap', async () => {
    const u = await newUser(1_000_000);
    const t0 = new Date('2026-10-24T10:00:00.000Z');
    const at = (ms: number): Date => new Date(t0.getTime() + ms);
    await launchFactoryCoin(ctx, u, input(), uuidv7(), t0);
    await expect(launchFactoryCoin(ctx, u, input(), uuidv7(), at(60_000))).rejects.toBeInstanceOf(
      LaunchCooldownError,
    );
    const step = LAUNCH_COOLDOWN_MS + 1_000;
    for (let i = 1; i < DAILY_LAUNCH_CAP; i++) {
      await launchFactoryCoin(ctx, u, input(), uuidv7(), at(step * i));
    }
    await expect(
      launchFactoryCoin(ctx, u, input(), uuidv7(), at(step * DAILY_LAUNCH_CAP)),
    ).rejects.toBeInstanceOf(LaunchLimitReachedError);
    const me = await getFactoryMe(ctx, u, at(step * DAILY_LAUNCH_CAP));
    expect(me.launchesToday).toBe(DAILY_LAUNCH_CAP);
    expect(me.nextLaunchAt).toBe(at(24 * 3_600_000).toISOString());
    // A day after the first launch a slot is free again.
    await launchFactoryCoin(ctx, u, input(), uuidv7(), at(24 * 3_600_000 + 1_000));
  });
});

describe('name and ticker filter', () => {
  it('rejects slurs, profanity, disguised words, links and impersonation', async () => {
    const u = await newUser(100_000);
    const bad: Array<[string, string]> = [
      ['Fuck Coin', 'FCK1'],
      ['f.u.c.k Inu', 'FINU'],
      ['FUUUCK Pepe', 'FPEP'],
      ['Sh1t Doge', 'SHD'],
      ['Nice Coin', 'SHIT'],
      ['N1gg Coin', 'NGC'],
      ['Buy pump.fun', 'BPF'],
      ['Visit www.scam.xyz', 'WWW'],
      ['Pumpfun Official', 'PFO'],
      ['Nice Coin', 'ADMIN'],
      ['mail me@x.io', 'MAIL'],
      ['<script>', 'XSS'],
      ['A', 'AA'],
      ['Ok Coin', 'A'],
      ['Ok Coin', 'TOOLONGX'],
      ['x'.repeat(25), 'LONG'],
      ['Ok Coin', 'A B'],
    ];
    for (const [name, t] of bad) {
      await expect(
        launchFactoryCoin(ctx, u, input({ name, ticker: t }), uuidv7()),
      ).rejects.toBeInstanceOf(NameNotAllowedError);
    }
    expect(await cashOf(u)).toBe(100_000);
  });

  it('accepts ordinary names, including ones with short bad-looking runs', () => {
    for (const [n, t] of [
      ['Moon Frog', 'MFROG'],
      ['Grape Coin', 'GRAPE'],
      ['Bacon Inu', 'BACON'],
      ['Assist Labs', 'ASSIST'],
      ['Classic Cat', 'CLASS'],
    ] as const) {
      expect(cleanCoinText(n, t)).not.toBeNull();
    }
    expect(isBlockedText('Totally fine')).toBe(false);
    expect(cleanCoinText('  Moon   Frog ', 'mfrog')).toEqual({
      name: 'Moon Frog',
      ticker: 'MFROG',
    });
  });
});

describe('trading a player coin (Cash Factory retired)', () => {
  it('refuses new Cash buys with 410 but lets an old position be sold', async () => {
    const creator = await newUser(100_000);
    const coin = await launch(creator);
    const other = await newUser(100_000);
    await expect(buy(other, coin.coinId, 1_000)).rejects.toBeInstanceOf(FactoryCashRetiredError);
    // The creator's launch position (an old Cash position) can still be sold.
    await expect(sellAll(creator, coin.coinId)).resolves.toBeDefined();
  });

  it('404s a house coin and an unknown id on the factory detail', async () => {
    const u = await newUser(1_000);
    const house = uuidv7();
    await pool.query(
      `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, launched_at, hidden_arc, seed)
       VALUES ($1, $2, 'House', 'new', 1000, 1000000, now(), '{"outcome":"sideways","slopeBps":0,"noiseBps":80,"drawdownBps":1500}', 1)`,
      [house, ticker()],
    );
    await expect(getFactoryCoin(ctx, u, house)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getFactoryCoin(ctx, u, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('heat and Sleuth text', () => {
  it('decays heat by half every 24 hours', () => {
    expect(decayHeat(80, 0, HEAT_HALF_LIFE_MS)).toBeCloseTo(40, 6);
    expect(decayHeat(80, 0, 0)).toBe(80);
    expect(decayHeat(80, 1000, 0)).toBe(80);
  });

  it('writes varied text under 280 chars and never repeats a blocked alias', () => {
    const facts = { alias: 'devman', ticker: 'ZXAA', pct: 55, buyers: 3, heat: 42 };
    const variants = new Set<string>();
    for (let i = 0; i < 40; i++)
      variants.add(sleuthPostText(uuidv7(), facts).replace(/devman/g, ''));
    expect(variants.size).toBeGreaterThan(3);
    for (const v of variants) expect(v.length).toBeLessThanOrEqual(280);
    expect(sleuthPostText('seed', { ...facts, alias: 'fuck' })).not.toContain('fuck');
    expect(sleuthPostText('seed', facts)).toBe(sleuthPostText('seed', facts));
  });
});
