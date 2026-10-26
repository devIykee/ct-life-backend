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
import { SLEUTH_USER_ID, sleuthPostText } from './factory-rug.js';
import { decayHeat, getHeat, HEAT_HALF_LIFE_MS } from './player-heat.js';
import { sampleHiddenArc } from './hidden-arc.js';
import { executeTrade } from './terminal-cafe.js';
import { listFeed } from './social-graph.js';
import { listMarketCoins } from './world-pulse.js';
import { publishWorldEvent } from './realtime-bus.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const RUN = Math.random().toString(36).slice(2, 7);
const MIX = { rug: 25, slow_bleed: 40, sideways: 20, moon: 15 };

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

/** A seed whose server-side arc is the wanted outcome. */
function seedFor(outcome: 'rug' | 'moon' | 'sideways'): number {
  for (let s = 1; s < 10_000; s++) if (sampleHiddenArc(s, MIX).outcome === outcome) return s;
  throw new Error('no seed');
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
    const short = await launchFactoryCoin(ctx, poor, input(), uuidv7()).catch((e: unknown) => e);
    expect(short).toBeInstanceOf(InsufficientCashError);
    // The standard field is shortfallCents (a number); have and need stay for compatibility.
    expect((short as InsufficientCashError).details).toEqual({
      have: String(LAUNCH_FEE_CENTS + 5_000 - 1),
      need: String(LAUNCH_FEE_CENTS + 5_000),
      shortfallCents: 1,
    });
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
    // retryAfterMs counts to the OLDEST launch in the rolling 24 h (what /factory/me reports as
    // nextLaunchAt), not from the last launch.
    const hit = await launchFactoryCoin(
      ctx,
      u,
      input(),
      uuidv7(),
      at(step * DAILY_LAUNCH_CAP),
    ).catch((e: unknown) => e);
    const retry = (hit as LaunchLimitReachedError).details.retryAfterMs as number;
    expect(retry).toBe(24 * 3_600_000 - step * DAILY_LAUNCH_CAP);
    const me = await getFactoryMe(ctx, u, at(step * DAILY_LAUNCH_CAP));
    expect(at(step * DAILY_LAUNCH_CAP + retry).toISOString()).toBe(me.nextLaunchAt);
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

describe('trading a player coin', () => {
  it('lets another player buy and sell it with Cash and logs the trades', async () => {
    const creator = await newUser(100_000);
    const buyer = await newUser(10_000);
    const coin = await launch(creator);
    const b = await buy(buyer, coin.coinId, 2_000);
    expect(await cashOf(buyer)).toBe(10_000 - 2_000);
    expect(BigInt(b.units)).toBeGreaterThan(0n);
    const s = await sellAll(buyer, coin.coinId);
    expect(BigInt(s.newUnits)).toBe(0n);
    const trades = await pool.query(
      `SELECT side FROM factory_trades WHERE coin_id = $1 AND user_id = $2 ORDER BY id`,
      [coin.coinId, buyer],
    );
    expect(trades.rows.map((r) => r.side)).toEqual(['buy', 'sell']);
    const detail = await getFactoryCoin(ctx, buyer, coin.coinId);
    expect(detail.isMine).toBe(false);
    expect(detail.creatorFeesCents).toBeNull(); // only the creator sees earnings
    expect(Array.isArray(detail.candles1m)).toBe(true);
    expect((await getFactoryCoin(ctx, creator, coin.coinId)).creatorFeesCents).toBe('0');
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

describe('creator fee', () => {
  it('pays the creator half the trade fee once the coin has mooned, and not before', async () => {
    const creator = await newUser(100_000);
    const buyer = await newUser(100_000);
    const coin = await launch(creator, {}, seedFor('moon'));
    const arc = await pool.query(
      `SELECT hidden_arc->>'outcome' AS o FROM coins WHERE coin_id = $1`,
      [coin.coinId],
    );
    expect(arc.rows[0].o).toBe('moon');

    // Not mooned yet: no fee.
    await buy(buyer, coin.coinId, 1_000);
    expect(await ledger(creator, 'factory_creator_fee')).toEqual([]);

    // The engine moves the price; simulate a 4x moon.
    await pool.query(`UPDATE coins SET price_micros = 4000 WHERE coin_id = $1`, [coin.coinId]);
    const before = await cashOf(creator);
    await buy(buyer, coin.coinId, 10_000); // 1% fee = 100 cents, creator share 50
    expect(await ledger(creator, 'factory_creator_fee')).toEqual([50]);
    expect(await cashOf(creator)).toBe(before + 50);
    const detail = await getFactoryCoin(ctx, creator, coin.coinId);
    expect(detail.mooned).toBe(true);
    expect(detail.creatorFeesCents).toBe('50');

    // The creator's own trades earn no fee.
    await buy(creator, coin.coinId, 1_000);
    expect(await ledger(creator, 'factory_creator_fee')).toEqual([50]);
  });
});

describe('rug detection and the Sleuth', () => {
  it('flags a creator dump on holders: heat, one Sleuth post, one world event', async () => {
    const creator = await newUser(200_000, 'rugdevsam');
    const holder = await newUser(10_000);
    const coin = await launch(creator, { devAllocationBps: 5_000 }, seedFor('rug'));
    await buy(holder, coin.coinId, 2_000);
    vi.mocked(publishWorldEvent).mockClear();

    await sellAll(creator, coin.coinId);

    const flagged = await pool.query(
      `SELECT rug_flagged_at FROM factory_coins WHERE coin_id = $1`,
      [coin.coinId],
    );
    expect(flagged.rows[0].rug_flagged_at).not.toBeNull();
    const heat = await getHeat(ctx, creator);
    expect(heat.heat).toBeGreaterThanOrEqual(35);
    expect(heat.level).toBe('hot');
    const ev = await pool.query(
      `SELECT source, ref_id FROM player_heat_events WHERE user_id = $1`,
      [creator],
    );
    expect(ev.rows).toEqual([{ source: 'factory_rug', ref_id: coin.coinId }]);

    const posts = await pool.query(
      `SELECT user_id, text, meta FROM feed_posts WHERE kind = 'sleuth' AND meta->>'coinId' = $1`,
      [coin.coinId],
    );
    expect(posts.rows).toHaveLength(1);
    expect(posts.rows[0].user_id).toBe(SLEUTH_USER_ID);
    expect(posts.rows[0].text).toContain(`rugdevsam${RUN}`);
    expect(posts.rows[0].text).toContain(coin.ticker);
    expect(posts.rows[0].text.length).toBeLessThanOrEqual(280);
    expect(posts.rows[0].meta).toMatchObject({
      launcherUserId: creator,
      launcherAlias: `rugdevsam${RUN}`,
      ticker: coin.ticker,
      deepLink: 'venue:launchpad_tower',
    });
    expect(publishWorldEvent).toHaveBeenCalledWith(
      expect.anything(),
      'evt_rug',
      expect.objectContaining({
        coinId: coin.coinId,
        kind: 'creator_dump',
        launcherAlias: `rugdevsam${RUN}`,
      }),
    );

    // The Timeline serves it as the Sleuth.
    const feed = await listFeed(ctx, holder, 'global');
    const post = feed.find((p) => p.kind === 'sleuth' && p.meta?.['coinId'] === coin.coinId);
    expect(post).toMatchObject({ kind: 'sleuth', alias: 'The Sleuth', userId: SLEUTH_USER_ID });

    // Dumping more does not flag, heat or post again.
    await buy(creator, coin.coinId, 3_000);
    await sellAll(creator, coin.coinId);
    expect((await getHeat(ctx, creator)).heat).toBe(heat.heat);
    const again = await pool.query(
      `SELECT 1 FROM feed_posts WHERE kind = 'sleuth' AND meta->>'coinId' = $1`,
      [coin.coinId],
    );
    expect(again.rowCount).toBe(1);
  });

  it('adds heat for a second rug but rate-limits the Sleuth to one post per launcher', async () => {
    const creator = await newUser(500_000, 'serialrugger');
    const holder = await newUser(50_000);
    const t0 = new Date('2026-10-24T08:00:00.000Z');
    const c1 = (await launchFactoryCoin(ctx, creator, input(), uuidv7(), t0)).coin;
    const c2 = (
      await launchFactoryCoin(ctx, creator, input(), uuidv7(), new Date(t0.getTime() + 11 * 60_000))
    ).coin;
    for (const c of [c1, c2]) {
      await buy(holder, c.coinId, 2_000);
      await sellAll(creator, c.coinId);
    }
    const posts = await pool.query(
      `SELECT 1 FROM feed_posts WHERE kind = 'sleuth' AND meta->>'launcherUserId' = $1`,
      [creator],
    );
    expect(posts.rowCount).toBe(1);
    const flagged = await pool.query(
      `SELECT COUNT(*)::int AS n FROM factory_coins WHERE creator_id = $1 AND rug_flagged_at IS NOT NULL`,
      [creator],
    );
    expect(flagged.rows[0].n).toBe(2);
    const events = await pool.query(`SELECT 1 FROM player_heat_events WHERE user_id = $1`, [
      creator,
    ]);
    expect(events.rowCount).toBe(2);
    expect((await getHeat(ctx, creator)).heat).toBeGreaterThan(60);
  });

  it('does not flag selling with no holders, small sells, or a holder selling', async () => {
    const creator = await newUser(200_000);
    const holder = await newUser(20_000);
    // Creator sells everything but nobody bought: not a rug.
    const loner = await newUser(100_000);
    const solo = await launch(loner);
    await sellAll(loner, solo.coinId);
    // Holders bought, creator sells a sliver: below the threshold.
    const c = await launch(creator, { liquidityCents: 50_000 });
    await buy(holder, c.coinId, 1_000);
    await executeTrade(ctx, {
      userId: creator,
      coinId: c.coinId,
      side: 'sell',
      units: '1000',
      maxSlippageBps: 1_000,
    });
    // A holder dumping is no rug.
    await sellAll(holder, c.coinId);
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM factory_coins WHERE creator_id = $1 AND rug_flagged_at IS NOT NULL`,
      [creator],
    );
    expect(r.rows[0].n).toBe(0);
    expect((await getHeat(ctx, creator)).heat).toBe(0);
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
