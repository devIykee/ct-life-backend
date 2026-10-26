/**
 * The Timeline world feed (migration 102): tabs, action cards, city event
 * cards, NPC callers, opt-in check-ins and the district rollover fix.
 *
 * Feed rows are written into a random far-future window and read with
 * `before` at the window's end, so other tests' posts never show up here.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { RateLimitedError, ValidationFailedError } from '../shared/domain/errors.js';
import { encodePos, getIslandGeometry, POS_HASH } from '../realtime/movement.js';
import {
  checkIn,
  CITY_USER_ID,
  createPlayerPost,
  insertSystemPost,
  interleave,
  listTimeline,
  turfAt,
} from './timeline.js';
import { cardCasinoWin, cardCoinLaunch, cardLiquidation, shortCash } from './city-cards.js';
import { CALLERS, runNpcCallers } from './npc-callers.js';
import { follow } from './social-graph.js';
import { rollDistrictRollover } from '../workers/district-rollover.js';
import { ensureDistricts } from './tribes.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();

afterAll(async () => {
  await pool.end();
});

async function newPlayer(alias?: string): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet, lottery_rolled_at) VALUES ($1, $2, now())`, [
    id,
    `tl-${id}`,
  ]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, age_confirmed_at, home_id)
     VALUES ($1, $2, $3, '{}', 'trencher', '{a,b}', 'make_10k', now(), 'studio')`,
    [uuidv7(), id, alias ?? `tl_${id.slice(-10)}`],
  );
  return id;
}

/** Old and tiny, so these coins never crowd the Pulse board other tests read. */
async function newCoin(opts: { house?: boolean; ticker?: string } = {}): Promise<{
  coinId: string;
  ticker: string;
}> {
  const coinId = uuidv7();
  const ticker = opts.ticker ?? `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await pool.query(
    `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, change_5m_bps, holders,
                        launched_at, hidden_arc, seed, player_launched)
     VALUES ($1, $2, 'Test Coin', 'new', 2100, 182, 1240, 7, '2000-01-01', '{}', 1, $3)`,
    [coinId, ticker, !opts.house],
  );
  return { coinId, ticker };
}

/**
 * A random 1-day window in the past (1900-1990). Past, so these rows are never
 * the newest posts other tests read; reads pass `before` at the window's end.
 */
function windowStart(): Date {
  return new Date(Date.UTC(1900, 0, 1) + Math.floor(Math.random() * 90 * 365) * 86_400_000);
}
const plus = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);
/** Only the rows this test wrote (the window), not older rows in the shared database. */
const since = <T extends { createdAt: string }>(posts: T[], w: Date): T[] =>
  posts.filter((p) => new Date(p.createdAt) >= w);

async function post(userId: string, text: string, at: Date, kind = 'player'): Promise<void> {
  await insertSystemPost(pool, { userId, kind: kind as 'player', text, meta: {}, at });
}

async function setPos(userId: string, x: number, z: number, at = Date.now()): Promise<void> {
  await ctx.redis.main.hset(POS_HASH, userId, encodePos({ x, z, at }));
}

describe('interleave (city cards at most 1 in 4 rows)', () => {
  it('needs 3 social rows before each city card and drops the ones that do not fit', () => {
    const t = (s: number) => ({ created_at: new Date(1_000_000 - s * 1000) });
    const social = Array.from({ length: 9 }, (_, i) => ({ ...t(i * 10), id: `s${i}` }));
    const city = [1, 2, 3, 35, 36, 75].map((s) => ({ ...t(s), id: `c${s}` }));
    const out = interleave(social, city).map((r) => r.id);
    expect(out).toEqual(['s0', 's1', 's2', 's3', 'c35', 's4', 's5', 's6', 's7', 'c75', 's8']);
    // never two city cards within 4 rows
    const idx = out.map((id, i) => (id.startsWith('c') ? i : -1)).filter((i) => i >= 0);
    for (let i = 1; i < idx.length; i++) expect(idx[i]! - idx[i - 1]!).toBeGreaterThanOrEqual(4);
  });
});

describe('tabs', () => {
  it('For you mixes people and spaced city cards; City has only cards; Following only followed authors', async () => {
    const w = windowStart();
    const me = await newPlayer();
    const friend = await newPlayer();
    const stranger = await newPlayer();
    await follow(ctx, me, friend);
    for (let i = 0; i < 8; i++)
      await post(i % 2 ? friend : stranger, `hello ${i}`, plus(w, 100 - i * 10));
    for (let i = 0; i < 4; i++) {
      await insertSystemPost(pool, {
        userId: CITY_USER_ID,
        kind: 'launch',
        text: `launch ${i}`,
        meta: {},
        at: plus(w, 99 - i * 10),
      });
    }
    const before = plus(w, 1000).toISOString();
    const foryou = await listTimeline(ctx, me, { tab: 'foryou', before });
    expect(since(foryou.posts, w).filter((p) => p.kind === 'player')).toHaveLength(8);
    const kinds = foryou.posts.map((p) => p.kind);
    const cityIdx = kinds.map((k, i) => (k === 'launch' ? i : -1)).filter((i) => i >= 0);
    expect(cityIdx.length).toBeGreaterThan(0);
    expect(cityIdx[0]).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < cityIdx.length; i++) {
      expect(cityIdx[i]! - cityIdx[i - 1]!).toBeGreaterThanOrEqual(4);
    }

    const city = since((await listTimeline(ctx, me, { tab: 'city', before })).posts, w);
    expect(city.map((p) => p.kind)).toEqual(['launch', 'launch', 'launch', 'launch']);
    expect(city[0]!.isNpc).toBe(true);
    expect(city[0]!.alias).toBe('CT City');
    expect(
      since((await listTimeline(ctx, me, { tab: 'city', type: 'rug', before })).posts, w),
    ).toHaveLength(0);

    const following = await listTimeline(ctx, me, { tab: 'following', before });
    expect(following.posts.map((p) => p.userId)).toEqual(Array(4).fill(friend));
  });

  it('hides authors the reader blocked', async () => {
    const w = windowStart();
    const me = await newPlayer();
    const troll = await newPlayer();
    await post(troll, 'buy my bags', plus(w, 10));
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      me,
      troll,
    ]);
    const page = await listTimeline(ctx, me, { tab: 'foryou', before: plus(w, 100).toISOString() });
    expect(page.posts.find((p) => p.userId === troll)).toBeUndefined();
  });

  it('pages with nextBefore', async () => {
    const w = windowStart();
    const me = await newPlayer();
    const a = await newPlayer();
    for (let i = 0; i < 45; i++) await post(a, `p${i}`, plus(w, 1000 - i));
    const first = await listTimeline(ctx, me, {
      tab: 'foryou',
      before: plus(w, 2000).toISOString(),
    });
    expect(first.posts).toHaveLength(40);
    expect(first.nextBefore).not.toBeNull();
    const second = await listTimeline(ctx, me, { tab: 'foryou', before: first.nextBefore });
    expect(second.posts.filter((p) => p.userId === a)).toHaveLength(5);
  });
});

describe('player posts and action cards', () => {
  it('a $TICKER of a real coin becomes a live coin card; the Sleuth verdict attaches once rugged', async () => {
    const me = await newPlayer();
    const coin = await newCoin();
    const p = await createPlayerPost(ctx, me, `$${coin.ticker} is sending. NFA`);
    expect(p.card).toMatchObject({
      type: 'coin',
      coinId: coin.coinId,
      ticker: coin.ticker,
      mcapCents: '182',
      change5mBps: 1240,
      rugged: false,
      deepLink: `ctlife://coin/${coin.coinId}`,
    });
    expect(p.verdict).toBeNull();
    // The Sleuth exposes the coin: the verdict box appears under the post.
    await insertSystemPost(pool, {
      userId: '00000000-0000-4000-8000-0000000051e7',
      kind: 'sleuth',
      text: 'DEV DUMPS',
      meta: { coinId: coin.coinId, sellSharePct: 62 },
      at: new Date(),
    });
    const page = await listTimeline(ctx, me, {
      tab: 'foryou',
      before: new Date(Date.now() + 60_000).toISOString(),
    });
    const again = page.posts.find((x) => x.postId === p.postId)!;
    expect(again.verdict).toMatchObject({ text: 'DEV DUMPS', sellSharePct: 62 });
  });

  it('a place card only when asked and the server finds the player at a venue; the district comes from the server', async () => {
    const me = await newPlayer();
    const door = getIslandGeometry().venues!.perp_pit!.door;
    const plain = await createPlayerPost(ctx, me, 'gm');
    expect(plain.card).toBeNull();
    expect(plain.district).toBeNull(); // no position known
    await setPos(me, door[0] + 3, door[1]);
    const noPlace = await createPlayerPost(ctx, me, 'gm again');
    expect(noPlace.card).toBeNull();
    expect(noPlace.district).toBe('perp_pit');
    const withPlace = await createPlayerPost(ctx, me, 'at the pit', { withPlace: true });
    expect(withPlace.card).toEqual({
      type: 'venue',
      venueId: 'perp_pit',
      name: 'Perp Pit',
      deepLink: 'ctlife://venue/perp_pit',
    });
  });

  it('turfAt maps island districts and turf venues to tribe districts', () => {
    const geo = getIslandGeometry();
    const pit = geo.venues!.perp_pit!.door;
    expect(turfAt(pit[0], pit[1])).toBe('perp_pit');
    const cafe = geo.venues!.terminal_cafe!.door; // trenches, not a turf venue
    expect(turfAt(cafe[0], cafe[1])).toBe('the_trenches');
  });
});

describe('opt-in check-ins', () => {
  it('only at the venue door, at most once per 15 minutes', async () => {
    const me = await newPlayer();
    await expect(checkIn(ctx, me, 'terminal_cafe')).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(checkIn(ctx, me, 'nowhere')).rejects.toBeInstanceOf(ValidationFailedError);
    const door = getIslandGeometry().venues!.terminal_cafe!.door;
    await setPos(me, door[0], door[1] + 2);
    const p = await checkIn(ctx, me, 'terminal_cafe');
    expect(p.kind).toBe('checkin');
    expect(p.text).toBe('is at Terminal Café');
    expect(p.card).toMatchObject({ type: 'venue', venueId: 'terminal_cafe' });
    await expect(checkIn(ctx, me, 'terminal_cafe')).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('city cards', () => {
  beforeEach(async () => {
    await ctx.redis.main.del('tl:city:casino_win');
  });

  it('one launch card per coin, with the launcher and followed buyers', async () => {
    const tag = Math.random().toString(36).slice(2, 7);
    const dev = await newPlayer(`smooth_${tag}`);
    const me = await newPlayer();
    const buddy = await newPlayer(`buddy_${tag}`);
    await follow(ctx, me, buddy);
    const coin = await newCoin();
    await pool.query(
      `INSERT INTO positions (position_id, user_id, coin_id, units, cost_basis_cents) VALUES ($1, $2, $3, 10, 100)`,
      [uuidv7(), buddy, coin.coinId],
    );
    const at = windowStart();
    await cardCoinLaunch(ctx, { ...coin, launcherUserId: dev }, at);
    await cardCoinLaunch(ctx, { ...coin, launcherUserId: dev }, at);
    const city = since(
      (await listTimeline(ctx, me, { tab: 'city', before: plus(at, 10).toISOString() })).posts,
      at,
    );
    expect(city).toHaveLength(1);
    expect(city[0]!.text).toBe(`smooth_${tag} launched $${coin.ticker}`);
    expect(city[0]!.social).toEqual({
      holders: 7,
      followed: [{ userId: buddy, alias: `buddy_${tag}` }],
    });
  });

  it('house coins launch without a name', async () => {
    const me = await newPlayer();
    const coin = await newCoin({ house: true });
    const at = windowStart();
    await cardCoinLaunch(ctx, { ...coin, launcherUserId: 'house' }, at);
    const city = await listTimeline(ctx, me, { tab: 'city', before: plus(at, 10).toISOString() });
    expect(since(city.posts, at)[0]!.text).toBe(`$${coin.ticker} just launched`);
  });

  it('liquidations fold into one card per 10 minutes', async () => {
    const me = await newPlayer();
    const at = windowStart();
    await cardLiquidation(ctx, { side: 'long', notionalCents: 10_000_000n }, at);
    await cardLiquidation(ctx, { side: 'long', notionalCents: 2_000_000n }, plus(at, 60));
    const page = await listTimeline(ctx, me, {
      tab: 'city',
      type: 'liquidation',
      before: plus(at, 3600).toISOString(),
    });
    const city = since(page.posts, at);
    expect(city).toHaveLength(1);
    expect(city[0]!.text).toBe('$120k of longs liquidated in the Perp Pit');
    expect(city[0]!.meta).toMatchObject({ count: 2, longCents: '12000000' });
    expect(city[0]!.card).toMatchObject({ type: 'venue', venueId: 'perp_pit' });
  });

  it('only big casino wins, at most one per 2 minutes', async () => {
    const me = await newPlayer();
    const tag = Math.random().toString(36).slice(2, 7);
    const lucky = await newPlayer(`lucky_${tag}`);
    const at = windowStart();
    const small = { game: 'slots', stakeCents: 100, payoutCents: 500, status: 'settled' };
    await cardCasinoWin(ctx, lucky, small, at);
    const big = { game: 'crash', stakeCents: 500, payoutCents: 20_000, status: 'settled' };
    await cardCasinoWin(ctx, lucky, big, at);
    await cardCasinoWin(ctx, lucky, big, plus(at, 5));
    const page = await listTimeline(ctx, me, {
      tab: 'city',
      type: 'casino_win',
      before: plus(at, 60).toISOString(),
    });
    const city = since(page.posts, at);
    expect(city.map((p) => p.text)).toEqual([`lucky_${tag} hit 40x on crash in the Rug Room`]);
    expect(city[0]!.card).toMatchObject({ type: 'venue', venueId: 'rug_room' });
  });

  it('formats short cash', () => {
    expect(shortCash(12_000_000)).toBe('$120k');
    expect(shortCash(420_000)).toBe('$4.2k');
    expect(shortCash(8_500)).toBe('$85');
  });
});

describe('NPC callers', () => {
  it('post calls on house coins when their turn comes, never all at once on first run', async () => {
    const coin = await newCoin({ house: true });
    for (const c of CALLERS) await ctx.redis.main.del(`tl:caller:${c.slug}:next`);
    const at = new Date(); // the schedule is wall-clock time
    expect(await runNpcCallers(ctx, at, () => 0.5)).toBe(0); // schedules only
    for (const c of CALLERS) await ctx.redis.main.set(`tl:caller:${c.slug}:next`, '1');
    expect(await runNpcCallers(ctx, at, () => 0.5)).toBe(CALLERS.length);
    const me = await newPlayer();
    await follow(ctx, me, CALLERS[0]!.userId);
    const following = await listTimeline(ctx, me, {
      tab: 'following',
      before: plus(at, 10).toISOString(),
    });
    const call = following.posts[0]!;
    expect(call.kind).toBe('caller');
    expect(call.isNpc).toBe(true);
    expect(call.alias).toBe('Candle Carla');
    expect(call.card?.type).toBe('coin');
    expect(call.meta).toMatchObject({
      persona: 'candle_carla',
      call: { targetX: 2.3, stopPct: 20 },
    });
    expect(call.text).toMatch(/\$[A-Z0-9]+/);
    void coin;
  });
});

describe('district rollover', () => {
  it('counts player posts by their district without failing', async () => {
    await ensureDistricts(ctx);
    const u = await newPlayer();
    const day = windowStart();
    await pool.query(
      `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, district_slug)
       VALUES ($1, $2, 'gm', $3, 'player', 'the_trenches')`,
      [uuidv7(), u, plus(day, 3600)],
    );
    await expect(
      rollDistrictRollover(ctx, day.toISOString().slice(0, 10), plus(day, 86_400)),
    ).resolves.toBeDefined();
  });
});
