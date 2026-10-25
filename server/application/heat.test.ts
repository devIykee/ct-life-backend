/**
 * Sleuth heat, police pursuit and CT Jail: raise and decay, levels, the pure
 * referee (escape radius and time, safe house, timer), a pursuit spawning at
 * wanted, caught -> jail + bail + the Sleuth's busted post (rate limited), the
 * client's catch report, bail, and the jail restrictions.
 *
 * The realtime publishers are stubbed; everything else hits the real DB and
 * Redis (the position hash the referee reads).
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  CatchNotVerifiedError,
  InsufficientCashError,
  JailedError,
  NoPursuitError,
  NotJailedError,
} from '../shared/domain/errors.js';
import { encodePos, POS_HASH } from '../realtime/movement.js';
import {
  assertNotJailed,
  bailFor,
  BAIL_MIN_CENTS,
  bustedPostText,
  BUSTED_POST_GLOBAL_MAX,
  BUSTED_POST_PLAYER_COOLDOWN_MS,
  CATCH_MIN_ELAPSED_MS,
  doorOfUnit,
  ESCAPE_AWAY_MS,
  ESCAPE_RADIUS_M,
  evaluatePursuits,
  getHeatMe,
  HEAT_AFTER_CAUGHT,
  HEAT_AFTER_ESCAPE,
  HEAT_DELTA,
  jailMsFor,
  judgePursuit,
  payBail,
  policeTick,
  PURSUIT_COOLDOWN_MS,
  PURSUIT_MS,
  pursuitUnits,
  raiseHeat,
  reportCaught,
  startPursuits,
} from './heat.js';
import { getHeat } from './player-heat.js';
import { getVenueAccess } from './venues-gating.js';
import { SLEUTH_USER_ID } from './factory-rug.js';
import { publishToUser } from './realtime-bus.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const RUN = Math.random().toString(36).slice(2, 7);

afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  vi.mocked(publishToUser).mockClear();
  // This is a private test database: start each test under the global busted-post cap.
  await pool.query(`DELETE FROM feed_posts WHERE kind = 'sleuth' AND meta ->> 'event' = 'busted'`);
});

async function newUser(cashCents = 0, alias?: string): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `heat-${id}`]);
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

async function setPos(userId: string, x: number, z: number, at: Date): Promise<void> {
  await ctx.redis.main.hset(POS_HASH, userId, encodePos({ x, z, at: at.getTime() }));
}

async function cashOf(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? '0');
}

async function bustedPosts(
  userId: string,
): Promise<{ text: string; meta: Record<string, unknown> }[]> {
  const r = await pool.query<{ text: string; meta: Record<string, unknown> }>(
    `SELECT text, meta FROM feed_posts
      WHERE kind = 'sleuth' AND meta ->> 'event' = 'busted' AND meta ->> 'subjectUserId' = $1
      ORDER BY created_at`,
    [userId],
  );
  return r.rows;
}

/** A wanted player, online at (x, z), with a pursuit running from `t0`. */
async function wantedAndChased(
  t0: Date,
  over: { heat?: number; x?: number; z?: number; cash?: number; alias?: string } = {},
): Promise<{ userId: string; pursuitId: string }> {
  const userId = await newUser(over.cash ?? 0, over.alias);
  await raiseHeat(ctx, userId, over.heat ?? 80, 'factory_rug', null, t0);
  await setPos(userId, over.x ?? 1_000_000, over.z ?? 1_000_000, t0);
  const started = await startPursuits(ctx, t0);
  expect(started).toContain(userId);
  const p = await pool.query<{ pursuit_id: string }>(
    `SELECT pursuit_id FROM heat_pursuits WHERE user_id = $1`,
    [userId],
  );
  return { userId, pursuitId: p.rows[0]!.pursuit_id };
}

describe('heat: raise, decay, levels', () => {
  it('adds heat per source and decays by half every 24 h', async () => {
    const t0 = new Date();
    const u = await newUser();
    const r1 = await raiseHeat(ctx, u, HEAT_DELTA.steal_npc, 'steal_npc', 'traffic_1', t0);
    expect(r1).toEqual({ heat: 8, level: 'cool' });
    const r2 = await raiseHeat(ctx, u, HEAT_DELTA.steal_player, 'steal_player', 'car', t0);
    expect(r2.heat).toBe(23);
    expect(r2.level).toBe('warm');
    const day = new Date(t0.getTime() + 24 * 60 * 60 * 1000);
    const later = await getHeat(ctx, u, day);
    expect(later.heat).toBeCloseTo(11.5, 1);
    const ev = await pool.query(
      `SELECT source, delta FROM player_heat_events WHERE user_id = $1 ORDER BY id`,
      [u],
    );
    expect(ev.rows.map((r) => r.source)).toEqual(['steal_npc', 'steal_player']);
  });

  it('caps at 100 and maps the four levels', async () => {
    const t0 = new Date();
    const u = await newUser();
    expect((await raiseHeat(ctx, u, 9, 'vehicle_hit', null, t0)).level).toBe('cool');
    expect((await raiseHeat(ctx, u, 2, 'vehicle_hit', null, t0)).level).toBe('warm');
    expect((await raiseHeat(ctx, u, 30, 'drainer_job', null, t0)).level).toBe('hot');
    expect((await raiseHeat(ctx, u, 30, 'drainer_job', null, t0)).level).toBe('wanted');
    expect((await raiseHeat(ctx, u, 500, 'drainer_job', null, t0)).heat).toBe(100);
  });

  it('GET /heat/me data: level, decayAt, wantedUntil', async () => {
    const t0 = new Date();
    const u = await newUser();
    expect(await getHeatMe(ctx, u, t0)).toMatchObject({
      heat: 0,
      level: 'cool',
      decayAt: null,
      wantedUntil: null,
      pursuit: null,
      jail: null,
    });
    await raiseHeat(ctx, u, 80, 'factory_rug', null, t0);
    const me = await getHeatMe(ctx, u, t0);
    expect(me.level).toBe('wanted');
    // 80 -> 70 takes log2(80/70) half-lives, about 4.6 h.
    const hrs = (new Date(me.decayAt!).getTime() - t0.getTime()) / 3_600_000;
    expect(hrs).toBeCloseTo(24 * Math.log2(80 / 70), 1);
    expect(me.wantedUntil).toBe(me.decayAt);
  });
});

describe('numbers', () => {
  it('units 1..4 by heat, bail and jail time scale with heat, in whole cents', () => {
    expect([70, 79, 80, 90, 99, 100].map(pursuitUnits)).toEqual([1, 1, 2, 3, 3, 4]);
    expect(bailFor(70)).toBe(3_500);
    expect(bailFor(100)).toBe(5_000);
    expect(bailFor(1)).toBe(BAIL_MIN_CENTS);
    expect(Number.isInteger(bailFor(73.4))).toBe(true);
    expect(jailMsFor(100)).toBeGreaterThan(jailMsFor(70));
  });

  it('reads a flat door from its unit id', () => {
    expect(doorOfUnit('flat:lgmf_n439_p68:0')).toEqual({ x: -439, z: 68 });
    expect(doorOfUnit('flat:lgmf_p10_n20:0')).toEqual({ x: 10, z: -20 });
    expect(doorOfUnit('villa:1')).toBeNull();
  });
});

describe('referee (pure)', () => {
  const base = {
    now: 100_000,
    expiresAt: 100_000 + PURSUIT_MS,
    anchor: { x: 0, z: 0 },
    door: null,
  };

  it('keeps going while inside the radius and resets the clock when you come back', () => {
    expect(judgePursuit({ ...base, awaySince: null, pos: { x: 10, z: 0 } })).toEqual({
      kind: 'continue',
      anchor: { x: 0, z: 0 },
      awaySince: null,
    });
    const out = judgePursuit({ ...base, awaySince: 90_000, pos: { x: 50, z: 0 } });
    expect(out).toMatchObject({ kind: 'continue', awaySince: null });
  });

  it('escapes only after 60 s continuously beyond 200 m', () => {
    const far = { x: ESCAPE_RADIUS_M + 1, z: 0 };
    const first = judgePursuit({ ...base, awaySince: null, pos: far });
    expect(first).toMatchObject({ kind: 'continue', awaySince: base.now });
    expect(judgePursuit({ ...base, awaySince: base.now - ESCAPE_AWAY_MS + 1, pos: far }).kind).toBe(
      'continue',
    );
    expect(judgePursuit({ ...base, awaySince: base.now - ESCAPE_AWAY_MS, pos: far })).toEqual({
      kind: 'escaped',
      reason: 'distance',
    });
    // Exactly at the radius does not count as away.
    expect(
      judgePursuit({
        ...base,
        awaySince: base.now - ESCAPE_AWAY_MS,
        pos: { x: ESCAPE_RADIUS_M, z: 0 },
      }).kind,
    ).toBe('continue');
  });

  it('going dark (no fresh position) gives no escape credit and the timer still catches', () => {
    const dark = judgePursuit({ ...base, awaySince: base.now - 120_000, pos: null });
    expect(dark).toMatchObject({ kind: 'continue', awaySince: null });
    expect(judgePursuit({ ...base, now: base.expiresAt, awaySince: null, pos: null })).toEqual({
      kind: 'caught',
      reason: 'timer',
    });
  });

  it('reaching your own door ends it, unless the chase started on your doorstep', () => {
    const door = { x: 500, z: 0 };
    expect(judgePursuit({ ...base, door, awaySince: null, pos: { x: 505, z: 0 } })).toEqual({
      kind: 'escaped',
      reason: 'safe_house',
    });
    expect(judgePursuit({ ...base, door, awaySince: null, pos: { x: 520, z: 0 } }).kind).toBe(
      'continue',
    );
    const near = { ...base, anchor: { x: 490, z: 0 }, door };
    expect(judgePursuit({ ...near, awaySince: null, pos: { x: 503, z: 0 } }).kind).toBe('continue');
  });
});

describe('pursuit spawns at wanted', () => {
  it('starts one pursuit with 1..4 units by heat, tells the player, and only one', async () => {
    const t0 = new Date();
    const u = await newUser();
    await raiseHeat(ctx, u, 85, 'factory_rug', null, t0);
    await setPos(u, 1_000_000, 1_000_000, t0);
    expect(await startPursuits(ctx, t0)).toContain(u);
    const sent = vi
      .mocked(publishToUser)
      .mock.calls.find((c) => c[1] === u && c[2] === 'police_pursuit');
    expect(sent?.[3]).toMatchObject({ targetUserId: u, units: 2, heat: 85 });
    // Already active: nothing new.
    expect(await startPursuits(ctx, new Date(t0.getTime() + 2_000))).not.toContain(u);
    const me = await getHeatMe(ctx, u, t0);
    expect(me.pursuit).toMatchObject({ units: 2, escapeRadiusM: 200, escapeSeconds: 60 });
  });

  it('stale high-stored-heat rows cannot starve a genuinely wanted player', async () => {
    const t0 = new Date();
    await pool.query(
      `INSERT INTO users (id, wallet)
       SELECT gen_random_uuid(), 'stale-' || gen_random_uuid() FROM generate_series(1, 250)`,
    );
    await pool.query(
      `INSERT INTO player_heat (user_id, heat, updated_at)
       SELECT id, 100, $1::timestamptz - interval '20 days' FROM users WHERE wallet LIKE 'stale-%'
       ON CONFLICT (user_id) DO UPDATE SET heat = 100, updated_at = $1::timestamptz - interval '20 days'`,
      [t0],
    );
    const wanted = await newUser();
    await raiseHeat(ctx, wanted, 85, 'factory_rug', null, t0);
    await setPos(wanted, 1_000_000, 1_000_000, t0);
    const started = await startPursuits(ctx, t0);
    expect(started).toContain(wanted);
    const stale = await pool.query(
      `SELECT count(*)::int AS n FROM heat_pursuits p JOIN users u ON u.id = p.user_id WHERE u.wallet LIKE 'stale-%'`,
    );
    expect(stale.rows[0].n).toBe(0);
  });

  it('does not start below wanted, without a fresh position, or on your own doorstep', async () => {
    const t0 = new Date();
    const hot = await newUser();
    await raiseHeat(ctx, hot, 60, 'factory_rug', null, t0);
    await setPos(hot, 1_000_000, 1_000_000, t0);
    const dark = await newUser();
    await raiseHeat(ctx, dark, 90, 'factory_rug', null, t0);
    const stale = await newUser();
    await raiseHeat(ctx, stale, 90, 'factory_rug', null, t0);
    await setPos(stale, 1_000_000, 1_000_000, new Date(t0.getTime() - 60_000));
    const home = await newUser();
    await raiseHeat(ctx, home, 90, 'factory_rug', null, t0);
    const unit = `flat:lgmf_p${700000 + Math.floor(Math.random() * 1000)}_p5:0`;
    await pool.query(
      `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents) VALUES ($1, 'residences', 'flat', 'flat', 100) ON CONFLICT DO NOTHING`,
      [unit],
    );
    await pool.query(
      `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, unit_id, status)
       VALUES ($1, $2, 'studio', 100, $3, 'active')`,
      [`home-${uuidv7()}`, home, unit],
    );
    const door = doorOfUnit(unit)!;
    await setPos(home, door.x + 3, door.z, t0);
    const started = await startPursuits(ctx, t0);
    for (const u of [hot, dark, stale, home]) expect(started).not.toContain(u);
    // Once they walk away from the door, the police move in.
    await setPos(home, door.x + 120, door.z, t0);
    expect(await startPursuits(ctx, t0)).toContain(home);
  });
});

describe('caught -> jail + bail + busted post', () => {
  it('the timer catches a player who ignores the police: jailed, bail by heat, heat cut', async () => {
    const t0 = new Date();
    const { userId, pursuitId } = await wantedAndChased(t0, {
      heat: 80,
      cash: 10_000,
      alias: 'Busty',
    });
    // Not yet.
    await evaluatePursuits(ctx, new Date(t0.getTime() + PURSUIT_MS - 1_000));
    expect((await getHeatMe(ctx, userId, t0)).jail).toBeNull();

    const end = new Date(t0.getTime() + PURSUIT_MS + 1_000);
    await setPos(userId, 1_000_000, 1_000_000, end);
    await evaluatePursuits(ctx, end);
    const me = await getHeatMe(ctx, userId, end);
    expect(me.pursuit).toBeNull();
    const heatAtArrest = 80 * Math.pow(0.5, (PURSUIT_MS + 1_000) / 86_400_000);
    expect(me.jail).toMatchObject({ venueId: 'ct_jail', bailCents: bailFor(heatAtArrest) });
    expect(new Date(me.jail!.until).getTime() - end.getTime()).toBe(jailMsFor(heatAtArrest));
    expect(me.heat).toBeCloseTo(heatAtArrest * HEAT_AFTER_CAUGHT, 0);

    const row = await pool.query(
      `SELECT status, end_reason FROM heat_pursuits WHERE user_id = $1`,
      [userId],
    );
    expect(row.rows[0]).toMatchObject({ status: 'caught', end_reason: 'timer' });
    const calls = vi.mocked(publishToUser).mock.calls.filter((c) => c[1] === userId);
    expect(calls.map((c) => c[2])).toEqual(
      expect.arrayContaining(['police_pursuit_end', 'jailed']),
    );
    const jailed = calls.find((c) => c[2] === 'jailed')![3];
    expect(jailed).toMatchObject({ venueId: 'ct_jail', bailCents: me.jail!.bailCents });
    expect(calls.find((c) => c[2] === 'police_pursuit_end')![3]).toMatchObject({
      pursuitId,
      outcome: 'caught',
    });

    // The Sleuth posted once, in its own voice.
    const posts = await bustedPosts(userId);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain(`Busty${RUN}`);
    expect(posts[0]!.meta).toMatchObject({
      event: 'busted',
      bailCents: me.jail!.bailCents,
      deepLink: 'venue:ct_jail',
    });
    const author = await pool.query(
      `SELECT user_id FROM feed_posts WHERE kind = 'sleuth' AND meta ->> 'subjectUserId' = $1`,
      [userId],
    );
    expect(author.rows[0].user_id).toBe(SLEUTH_USER_ID);
  });

  it('rate limits the busted post per player and still jails', async () => {
    const t0 = new Date();
    const first = await wantedAndChased(t0, { heat: 80 });
    await evaluatePursuits(ctx, new Date(t0.getTime() + PURSUIT_MS + 1_000));
    expect(await bustedPosts(first.userId)).toHaveLength(1);

    // Same player is wanted and caught again inside the window (their stay is over).
    const t1 = new Date(t0.getTime() + PURSUIT_MS + PURSUIT_COOLDOWN_MS + 10 * 60_000);
    await pool.query(
      `UPDATE player_jail SET released_at = $2, release_reason = 'timer' WHERE user_id = $1`,
      [first.userId, t1],
    );
    await raiseHeat(ctx, first.userId, 100, 'factory_rug', null, t1);
    await setPos(first.userId, 1_000_000, 1_000_000, t1);
    expect(await startPursuits(ctx, t1)).toContain(first.userId);
    await evaluatePursuits(ctx, new Date(t1.getTime() + PURSUIT_MS + 1_000));
    expect(
      (await getHeatMe(ctx, first.userId, new Date(t1.getTime() + PURSUIT_MS + 2_000))).jail,
    ).not.toBeNull();
    expect(await bustedPosts(first.userId)).toHaveLength(1);

    // After the cooldown a new arrest posts again.
    const t2 = new Date(t0.getTime() + BUSTED_POST_PLAYER_COOLDOWN_MS + PURSUIT_MS * 4);
    await pool.query(
      `UPDATE player_jail SET released_at = $2, release_reason = 'timer' WHERE user_id = $1`,
      [first.userId, t2],
    );
    await raiseHeat(ctx, first.userId, 100, 'factory_rug', null, t2);
    await setPos(first.userId, 1_000_000, 1_000_000, t2);
    expect(await startPursuits(ctx, t2)).toContain(first.userId);
    await evaluatePursuits(ctx, new Date(t2.getTime() + PURSUIT_MS + 1_000));
    expect(await bustedPosts(first.userId)).toHaveLength(2);
  });

  it('caps busted posts overall per 10 minutes so the Timeline is not flooded', async () => {
    const t0 = new Date();
    for (let i = 0; i < BUSTED_POST_GLOBAL_MAX; i++) {
      await pool.query(
        `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, meta)
         VALUES ($1, $2, 'x', $3, 'sleuth', $4)`,
        [
          uuidv7(),
          SLEUTH_USER_ID,
          t0,
          JSON.stringify({ event: 'busted', subjectUserId: uuidv7() }),
        ],
      );
    }
    const { userId } = await wantedAndChased(t0, { heat: 80 });
    await evaluatePursuits(ctx, new Date(t0.getTime() + PURSUIT_MS + 1_000));
    expect((await getHeatMe(ctx, userId, t0)).jail).not.toBeNull();
    expect(await bustedPosts(userId)).toHaveLength(0);
  });

  it('bustedPostText stays in our own voice (never a real person)', () => {
    const t = bustedPostText(uuidv7(), { alias: 'Moonboy', heat: 88, bailCents: 4_400 });
    expect(t).toContain('Moonboy');
    expect(t.toLowerCase()).not.toContain('zach');
  });
});

describe('escape', () => {
  it('60 s beyond 200 m from the last wanted position escapes: heat halves, no jail', async () => {
    const t0 = new Date();
    const { userId, pursuitId } = await wantedAndChased(t0, {
      heat: 90,
      x: 1_000_000,
      z: 1_000_000,
    });
    await setPos(userId, 1_000_300, 1_000_000, t0);
    await evaluatePursuits(ctx, t0); // starts the away clock
    const t1 = new Date(t0.getTime() + 30_000);
    await setPos(userId, 1_000_400, 1_000_000, t1);
    await evaluatePursuits(ctx, t1);
    expect((await getHeatMe(ctx, userId, t1)).pursuit).not.toBeNull();
    const t2 = new Date(t0.getTime() + ESCAPE_AWAY_MS);
    await setPos(userId, 1_000_450, 1_000_000, t2);
    await evaluatePursuits(ctx, t2);
    const me = await getHeatMe(ctx, userId, t2);
    expect(me.pursuit).toBeNull();
    expect(me.jail).toBeNull();
    expect(me.heat).toBeCloseTo(90 * HEAT_AFTER_ESCAPE, 0);
    const end = vi
      .mocked(publishToUser)
      .mock.calls.find((c) => c[1] === userId && c[2] === 'police_pursuit_end');
    expect(end?.[3]).toMatchObject({ pursuitId, outcome: 'escaped', reason: 'distance' });
    expect(await bustedPosts(userId)).toHaveLength(0);
  });

  it('returning inside the radius resets the clock; a stale position gives no credit', async () => {
    const t0 = new Date();
    const { userId } = await wantedAndChased(t0, { heat: 90, x: 1_000_000, z: 1_000_000 });
    await setPos(userId, 1_000_300, 1_000_000, t0);
    await evaluatePursuits(ctx, t0);
    const t1 = new Date(t0.getTime() + 40_000);
    await setPos(userId, 1_000_050, 1_000_000, t1); // back inside
    await evaluatePursuits(ctx, t1);
    const t2 = new Date(t0.getTime() + 70_000);
    await setPos(userId, 1_000_300, 1_000_000, t2);
    await evaluatePursuits(ctx, t2);
    expect((await getHeatMe(ctx, userId, t2)).pursuit).not.toBeNull();
    // Offline for ages: the position goes stale, nothing escapes.
    const t3 = new Date(t0.getTime() + 150_000);
    await evaluatePursuits(ctx, t3);
    expect((await getHeatMe(ctx, userId, t3)).pursuit).not.toBeNull();
  });

  it('reaching the safe house (own home door) escapes', async () => {
    const t0 = new Date();
    const userId = await newUser();
    const unit = `flat:lgmf_p${710000 + Math.floor(Math.random() * 1000)}_p9:0`;
    await pool.query(
      `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents) VALUES ($1, 'residences', 'flat', 'flat', 100) ON CONFLICT DO NOTHING`,
      [unit],
    );
    await pool.query(
      `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, unit_id, status)
       VALUES ($1, $2, 'studio', 100, $3, 'active')`,
      [`home-${uuidv7()}`, userId, unit],
    );
    const door = doorOfUnit(unit)!;
    await raiseHeat(ctx, userId, 80, 'factory_rug', null, t0);
    await setPos(userId, door.x + 150, door.z, t0);
    expect(await startPursuits(ctx, t0)).toContain(userId);
    const t1 = new Date(t0.getTime() + 20_000);
    await setPos(userId, door.x + 2, door.z, t1);
    await evaluatePursuits(ctx, t1);
    const me = await getHeatMe(ctx, userId, t1);
    expect(me.pursuit).toBeNull();
    expect(me.jail).toBeNull();
    const r = await pool.query(`SELECT status, end_reason FROM heat_pursuits WHERE user_id = $1`, [
      userId,
    ]);
    expect(r.rows[0]).toMatchObject({ status: 'escaped', end_reason: 'safe_house' });
  });
});

describe('the client catch report is verified', () => {
  it("rejects an early, unknown, mismatched or someone else's report; accepts a consistent one", async () => {
    const t0 = new Date();
    const { userId, pursuitId } = await wantedAndChased(t0, {
      heat: 75,
      x: 1_000_000,
      z: 1_000_000,
    });
    const other = await newUser();

    const early = new Date(t0.getTime() + CATCH_MIN_ELAPSED_MS - 1_000);
    await setPos(userId, 1_000_000, 1_000_000, early);
    await expect(
      reportCaught(ctx, userId, { pursuitId, x: 1_000_000, z: 1_000_000 }, early),
    ).rejects.toBeInstanceOf(CatchNotVerifiedError);

    const ok = new Date(t0.getTime() + CATCH_MIN_ELAPSED_MS + 1_000);
    await setPos(userId, 1_000_000, 1_000_000, ok);
    await expect(
      reportCaught(ctx, userId, { pursuitId: uuidv7(), x: 1_000_000, z: 1_000_000 }, ok),
    ).rejects.toBeInstanceOf(NoPursuitError);
    await expect(
      reportCaught(ctx, other, { pursuitId, x: 1_000_000, z: 1_000_000 }, ok),
    ).rejects.toBeInstanceOf(NoPursuitError);
    // The report says the player is 100 m from where the server has them.
    await expect(
      reportCaught(ctx, userId, { pursuitId, x: 1_000_100, z: 1_000_000 }, ok),
    ).rejects.toBeInstanceOf(CatchNotVerifiedError);
    // The server has no fresh position.
    const stale = new Date(ok.getTime() + 120_000);
    await expect(
      reportCaught(ctx, userId, { pursuitId, x: 1_000_000, z: 1_000_000 }, stale),
    ).rejects.toBeInstanceOf(CatchNotVerifiedError);
    expect((await getHeatMe(ctx, userId, ok)).jail).toBeNull();

    const me = await reportCaught(ctx, userId, { pursuitId, x: 1_000_004, z: 1_000_002 }, ok);
    expect(me.jail).not.toBeNull();
    expect(me.pursuit).toBeNull();
    // The same report again: the pursuit is over.
    await expect(
      reportCaught(ctx, userId, { pursuitId, x: 1_000_000, z: 1_000_000 }, ok),
    ).rejects.toBeInstanceOf(NoPursuitError);
  });
});

describe('bail and jail restrictions', () => {
  async function jailedPlayer(cash: number): Promise<{ userId: string; bail: number }> {
    const t0 = new Date(Date.now() - PURSUIT_MS - 10_000);
    const { userId } = await wantedAndChased(t0, { heat: 80, cash });
    const now = new Date();
    await evaluatePursuits(ctx, now);
    const me = await getHeatMe(ctx, userId, now);
    expect(me.jail).not.toBeNull();
    return { userId, bail: me.jail!.bailCents };
  }

  it('bail debits Cash once (ledger police_bail), frees the player, refuses without Cash', async () => {
    const poor = await jailedPlayer(10);
    await expect(payBail(ctx, poor.userId)).rejects.toBeInstanceOf(InsufficientCashError);
    expect(await cashOf(poor.userId)).toBe(10);

    const rich = await jailedPlayer(20_000);
    const out = await payBail(ctx, rich.userId);
    expect(out).toEqual({ released: true, bailCents: rich.bail, cashCents: 20_000 - rich.bail });
    expect(await cashOf(rich.userId)).toBe(20_000 - rich.bail);
    const led = await pool.query(
      `SELECT delta_cents FROM ledger_entries WHERE user_id = $1 AND reason = 'police_bail'`,
      [rich.userId],
    );
    expect(led.rows.map((r) => Number(r.delta_cents))).toEqual([-rich.bail]);
    expect(Number.isInteger(rich.bail)).toBe(true);
    await expect(payBail(ctx, rich.userId)).rejects.toBeInstanceOf(NotJailedError);
    expect(await cashOf(rich.userId)).toBe(20_000 - rich.bail);
    expect((await getHeatMe(ctx, rich.userId)).jail).toBeNull();
    await expect(assertNotJailed(ctx, rich.userId)).resolves.toBeUndefined();
  });

  it('a stay ends by itself when the timer runs out (sweep marks it released)', async () => {
    const j = await jailedPlayer(0);
    const later = new Date(Date.now() + jailMsFor(100) + 60_000);
    await expect(assertNotJailed(ctx, j.userId, new Date())).rejects.toBeInstanceOf(JailedError);
    await expect(assertNotJailed(ctx, j.userId, later)).resolves.toBeUndefined();
    const tick = await policeTick(ctx, later);
    expect(tick.released).toBeGreaterThanOrEqual(1);
    const r = await pool.query(`SELECT release_reason FROM player_jail WHERE user_id = $1`, [
      j.userId,
    ]);
    expect(r.rows[0].release_reason).toBe('timer');
    expect(
      vi.mocked(publishToUser).mock.calls.some((c) => c[1] === j.userId && c[2] === 'released'),
    ).toBe(true);
  });

  it('jail blocks other venues (access JAILED) but not CT Jail itself', async () => {
    const j = await jailedPlayer(0);
    expect(await getVenueAccess(ctx, j.userId, 'timeline_square')).toMatchObject({
      allowed: false,
      reasonCode: 'JAILED',
    });
    expect((await getVenueAccess(ctx, j.userId, 'ct_jail')).allowed).toBe(true);
    const free = await newUser();
    expect((await getVenueAccess(ctx, free, 'timeline_square')).allowed).toBe(true);
  });
});
