/**
 * Starter quests and the first session: seeding once, phase gating of the trade quest, the
 * verbs firing from the real actions, server-set beats, skip and replay, and old accounts.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';

vi.mock('./realtime-bus.js', async (orig) => ({
  ...(await orig<typeof import('./realtime-bus.js')>()),
  publishToUser: vi.fn(async () => undefined),
}));

import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { claimQuest, listQuests } from './quests.js';
import {
  addBeat,
  applicableBeats,
  BEATS,
  getFirstSession,
  onCharacterCreated,
  onOriginRolled,
  recordOnboardingEvent,
  replayFirstSession,
  skipFirstSession,
} from './onboarding.js';
import { claimDaily } from './daily-streak.js';
import { openPerp } from './perp-pit.js';
import { executeTrade } from './terminal-cafe.js';
import { ShiftsService } from './shifts.js';
import { startShift } from './rekt-burger.js';
import { encodePos, POS_HASH } from '../realtime/movement.js';
import { _resetRewardCatalogForTests } from './rewards.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();
_resetRewardCatalogForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const base = buildContext();
/** The same context with the markets closed (phase 1) or open (phase 2 and up). */
const at = (phase: number): AppContext => ({
  ...base,
  config: { ...base.config, livePhase: phase },
});
const p1 = at(1);
const p2 = at(2);

afterAll(async () => {
  await pool.end();
});
beforeEach(() => undefined);

async function newUser(
  opts: { old?: boolean; cash?: number; debt?: number } = {},
): Promise<string> {
  const id = uuidv7();
  const created = opts.old
    ? "(SELECT epoch - interval '1 day' FROM onboarding_meta LIMIT 1)"
    : 'now()';
  await pool.query(`INSERT INTO users (id, wallet, created_at) VALUES ($1, $2, ${created})`, [
    id,
    `onb-${id}`,
  ]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, $3)`, [
    id,
    opts.cash ?? 100_000,
    opts.debt ?? 0,
  ]);
  return id;
}
const starterRows = async (u: string): Promise<string[]> =>
  (
    await pool.query<{ quest_id: string }>(
      `SELECT quest_id FROM starter_quests WHERE user_id = $1 ORDER BY quest_id`,
      [u],
    )
  ).rows.map((r) => r.quest_id);
const cash = async (u: string): Promise<number> =>
  Number(
    (await pool.query(`SELECT cash_cents AS c FROM balances WHERE user_id = $1`, [u])).rows[0].c,
  );
const ledger = async (u: string, reason: string): Promise<number[]> =>
  (
    await pool.query(
      `SELECT delta_cents FROM ledger_entries WHERE user_id = $1 AND reason = $2 ORDER BY id`,
      [u, reason],
    )
  ).rows.map((r) => Number(r.delta_cents));
const starterView = async (ctx: AppContext, u: string, id: string) =>
  (await listQuests(ctx, u)).starter.quests.find((q) => q.id === id)!;

describe('starter quests: seeding', () => {
  it('seeds a new account once and lists the starters before the dailies, pool "starter"', async () => {
    const u = await newUser();
    const first = await listQuests(p1, u);
    expect(Object.keys(first)[0]).toBe('starter');
    expect(first.starter.quests.map((q) => q.id)).toEqual(['q_starter_shift', 'q_starter_chest']);
    expect(first.starter.quests.every((q) => q.pool === 'starter')).toBe(true);
    expect(first.daily.quests.every((q) => q.pool === 'daily')).toBe(true);
    expect(first.starter.quests[0]).toMatchObject({
      title: 'First shift',
      verb: 'shift_start',
      target: 1,
      progress: 0,
      reward: { cashCents: 1000, seasonXp: 20 },
      deepLink: 'ctlife://jobs',
    });
    const seeded = (
      await pool.query(`SELECT starter_seeded_at FROM onboarding_state WHERE user_id = $1`, [u])
    ).rows[0].starter_seeded_at as Date;
    // Reading again, and the character hook, change nothing.
    await listQuests(p1, u);
    await onCharacterCreated(p1, u);
    expect(await starterRows(u)).toEqual(['q_starter_chest', 'q_starter_shift']);
    expect(
      (await pool.query(`SELECT starter_seeded_at FROM onboarding_state WHERE user_id = $1`, [u]))
        .rows[0].starter_seeded_at,
    ).toEqual(seeded);
  });

  it('seeds at character creation, before any GET /quests', async () => {
    const u = await newUser();
    await onCharacterCreated(p1, u);
    expect(await starterRows(u)).toEqual(['q_starter_chest', 'q_starter_shift']);
  });

  it('gates the trade quest on markets being live: omitted at phase 1, given at phase 2', async () => {
    const early = await newUser();
    expect((await listQuests(p1, early)).starter.quests.map((q) => q.verb)).not.toContain(
      'trade_open',
    );
    const live = await newUser();
    const list = await listQuests(p2, live);
    expect(list.starter.quests.map((q) => q.id)).toEqual([
      'q_starter_shift',
      'q_starter_trade',
      'q_starter_chest',
    ]);
    expect(list.starter.quests[1]).toMatchObject({
      reward: { cashCents: 500, seasonXp: 20 },
      deepLink: 'ctlife://pulse',
    });
    // Markets opening later adds it for a player seeded before (once; the others are not reseeded).
    const later = (await listQuests(p2, early)).starter.quests.map((q) => q.id);
    expect(later).toContain('q_starter_trade');
    expect(await starterRows(early)).toHaveLength(3);
  });

  it('an account from before the onboarding migration gets no starter quests and no row', async () => {
    const u = await newUser({ old: true });
    expect((await listQuests(p2, u)).starter.quests).toEqual([]);
    await onCharacterCreated(p2, u);
    expect(await starterRows(u)).toEqual([]);
    const row = await pool.query(`SELECT 1 FROM onboarding_state WHERE user_id = $1`, [u]);
    expect(row.rowCount).toBe(0);
    // An event for a verb it has no quest for is harmless.
    await recordOnboardingEvent(p2, u, 'shift_start', 'x');
    const none = await pool.query(`SELECT 1 FROM quest_progress WHERE user_id = $1`, [u]);
    expect(none.rowCount).toBe(0);
  });
});

describe('starter quests: the verbs fire from the real actions and pay via the ordinary claim', () => {
  it('a Rekt Burger clock-in completes First shift; the claim pays 1000 + 20 Season XP once', async () => {
    const u = await newUser({ cash: 0, debt: 72_000 });
    await listQuests(p1, u);
    const cfg = base.configCache.load<{ rektBurger: { counter: { x: number; z: number } } }>(
      'careers',
    ).rektBurger;
    const now = new Date();
    await base.redis.main.hset(
      POS_HASH,
      u,
      encodePos({ x: cfg.counter.x, z: cfg.counter.z, at: now.getTime() }),
    );
    await startShift(base, u, now);
    expect(await starterView(p1, u, 'q_starter_shift')).toMatchObject({
      progress: 1,
      completed: true,
      claimed: false,
    });
    expect((await getFirstSession(p1, u)).beats).toContain('shift');
    const claim = await claimQuest(p1, u, 'q_starter_shift');
    expect(claim).toMatchObject({
      alreadyClaimed: false,
      reward: { cashCents: 1000, seasonXp: 20 },
    });
    expect(await ledger(u, 'quest_reward')).toEqual([1000]);
    expect(await cash(u)).toBe(1000);
    const xp = await pool.query(`SELECT amount FROM season_xp WHERE user_id = $1`, [u]);
    expect(xp.rows.map((r) => r.amount)).toEqual([20]);
    expect((await claimQuest(p1, u, 'q_starter_shift')).alreadyClaimed).toBe(true);
    expect(await ledger(u, 'quest_reward')).toEqual([1000]);
    // Resuming the open shift (a second start) is not another clock-in.
    await startShift(base, u, new Date(now.getTime() + 1000));
    expect((await starterView(p1, u, 'q_starter_shift')).progress).toBe(1);
  });

  it('a career shift start (POST /shifts) completes it too', async () => {
    const u = await newUser();
    await listQuests(p1, u);
    const careerId = base.configCache.load<{ careers: Array<{ id: string }> }>('careers')
      .careers[0]!.id;
    await new ShiftsService(base).start(u, careerId);
    expect((await starterView(p1, u, 'q_starter_shift')).completed).toBe(true);
  });

  it('the daily chest claim completes GM, and a repeat claim the same day does not', async () => {
    const u = await newUser();
    await listQuests(p1, u);
    const first = await claimDaily(base, u);
    expect(first.alreadyClaimed).toBe(false);
    expect(await starterView(p1, u, 'q_starter_chest')).toMatchObject({
      progress: 1,
      completed: true,
    });
    expect((await getFirstSession(p1, u)).beats).toContain('chest');
    const claim = await claimQuest(p1, u, 'q_starter_chest');
    expect(claim.reward).toEqual({ cashCents: 500, seasonXp: 20 });
    expect((await claimDaily(base, u)).alreadyClaimed).toBe(true);
    expect((await starterView(p1, u, 'q_starter_chest')).progress).toBe(1);
  });

  async function coin(): Promise<string> {
    const coinId = uuidv7();
    await pool.query(
      `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
                          change_5m_bps, holders, launched_at, hidden_arc, seed)
       VALUES ($1, $2, 'Onb test', 'new', 1000000, 1000000, 0, 0, 0, now(), '{}', 1)`,
      [coinId, `O${coinId.slice(-6).toUpperCase()}`],
    );
    return coinId;
  }

  it('a market buy completes First trade (when markets are live)', async () => {
    const u = await newUser();
    await listQuests(p2, u);
    const coinId = await coin();
    await executeTrade(p2, {
      userId: u,
      coinId,
      side: 'buy',
      cashCents: 5000,
      maxSlippageBps: 5000,
    });
    expect(await starterView(p2, u, 'q_starter_trade')).toMatchObject({
      progress: 1,
      completed: true,
    });
    expect((await getFirstSession(p2, u)).beats).toContain('trade');
    const claim = await claimQuest(p2, u, 'q_starter_trade');
    expect(claim.reward).toEqual({ cashCents: 500, seasonXp: 20 });
  });

  it('a perp open completes First trade too', async () => {
    const u = await newUser();
    await listQuests(p2, u);
    await openPerp(p2, {
      userId: u,
      coinId: await coin(),
      side: 'long',
      leverage: 1,
      marginCents: 1000,
    });
    expect((await starterView(p2, u, 'q_starter_trade')).completed).toBe(true);
  });

  it('only the owner can claim a starter quest, and an unfinished one is refused', async () => {
    const a = await newUser();
    const b = await newUser();
    await listQuests(p1, a);
    await expect(claimQuest(p1, a, 'q_starter_shift')).rejects.toMatchObject({
      code: 'QUEST_NOT_COMPLETE',
    });
    // b is a new account that has never listed quests: it holds no starter quests yet.
    await expect(claimQuest(p1, b, 'q_starter_shift')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const old = await newUser({ old: true });
    await expect(claimQuest(p1, old, 'q_starter_shift')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('the first session', () => {
  it('a new account starts active with no beats; an old account reads as done', async () => {
    const u = await newUser();
    const s = await getFirstSession(p1, u);
    expect(s).toMatchObject({ state: 'active', completedAt: null, beats: [] });
    expect(s.startedAt).toBeTruthy();
    const old = await newUser({ old: true });
    expect(await getFirstSession(p1, old)).toEqual({
      state: 'done',
      startedAt: null,
      completedAt: null,
      beats: [],
    });
    // Beats on an old account change nothing and create nothing.
    expect((await addBeat(p1, old, 'home')).state).toBe('done');
    expect(
      (await pool.query(`SELECT 1 FROM onboarding_state WHERE user_id = $1`, [old])).rowCount,
    ).toBe(0);
  });

  it('the server sets origin and character; beats come back in order and are idempotent', async () => {
    const u = await newUser();
    await onCharacterCreated(p1, u);
    await onOriginRolled(p1, u);
    await addBeat(p1, u, 'home');
    await addBeat(p1, u, 'home');
    const s = await getFirstSession(p1, u);
    expect(s.beats).toEqual(['origin', 'character', 'home']);
    expect(s.state).toBe('active');
  });

  it('is done when every applicable beat is in; trade counts only while markets are live', async () => {
    expect(applicableBeats(p1)).toHaveLength(BEATS.length - 1);
    expect(applicableBeats(p2)).toHaveLength(BEATS.length);
    const u = await newUser();
    for (const b of BEATS.filter((x) => x !== 'trade' && x !== 'chest')) await addBeat(p1, u, b);
    expect((await getFirstSession(p1, u)).state).toBe('active');
    const done = await addBeat(p1, u, 'chest');
    expect(done.state).toBe('done');
    expect(done.completedAt).toBeTruthy();
    expect(done.beats).not.toContain('trade');
    // Markets live: the same beats are not enough.
    const v = await newUser();
    for (const b of BEATS.filter((x) => x !== 'trade')) await addBeat(p2, v, b);
    expect((await getFirstSession(p2, v)).state).toBe('active');
    expect((await addBeat(p2, v, 'trade')).state).toBe('done');
  });

  it('skip sets skipped (idempotent) and a later beat does not finish it', async () => {
    const u = await newUser();
    await addBeat(p1, u, 'origin');
    const s = await skipFirstSession(p1, u);
    expect(s).toMatchObject({ state: 'skipped', beats: ['origin'] });
    expect((await skipFirstSession(p1, u)).state).toBe('skipped');
    for (const b of BEATS) await addBeat(p2, u, b);
    expect((await getFirstSession(p2, u)).state).toBe('skipped');
  });

  it('replay is active again, clears the beats from "moved" on, restarts the clock, keeps the quests', async () => {
    const u = await newUser();
    await listQuests(p1, u);
    for (const b of BEATS.filter((x) => x !== 'trade')) await addBeat(p1, u, b);
    const done = await getFirstSession(p1, u);
    expect(done.state).toBe('done');
    const later = new Date(Date.now() + 60_000);
    const r = await replayFirstSession(p1, u, later);
    expect(r).toEqual({
      state: 'active',
      startedAt: later.toISOString(),
      completedAt: null,
      beats: ['origin', 'character', 'home'],
    });
    expect(await starterRows(u)).toHaveLength(2); // not reseeded
    // A skipped session can be replayed as well.
    await skipFirstSession(p1, u);
    expect((await replayFirstSession(p1, u)).state).toBe('active');
  });

  it('an old account that replays gets a first session but still no starter quests', async () => {
    const old = await newUser({ old: true });
    expect((await replayFirstSession(p1, old)).state).toBe('active');
    expect((await listQuests(p1, old)).starter.quests).toEqual([]);
    expect(await starterRows(old)).toEqual([]);
  });
});
