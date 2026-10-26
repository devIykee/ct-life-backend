/**
 * Rekt Burger tests: who unlocks it (Trencher, broke, liquidated), the clock-in shift (pay
 * by server time, the maximum length and auto-close, the daily cap, the position gate,
 * double start, end without start, racing ends, restore), career XP, the Timeline posts and
 * the quest hook. The realtime push is stubbed and inspected.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';

vi.mock('./realtime-bus.js', async (orig) => ({
  ...(await orig<typeof import('./realtime-bus.js')>()),
  publishToUser: vi.fn(async () => undefined),
}));

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  CounterTooFarError,
  JobDailyCapError,
  JobLockedError,
  NotFoundError,
  PositionUnknownError,
} from '../shared/domain/errors.js';
import {
  clockPayCents,
  endShift,
  getCurrentShift,
  getRektBurger,
  leaveJob,
  maxShiftPayCents,
  onPlayerRekt,
  rektConfig,
  startShift,
  sweepRektShifts,
} from './rekt-burger.js';
import { encodePos, POS_HASH } from '../realtime/movement.js';
import { liquidatePerp, openPerp } from './perp-pit.js';
import { claimQuest, listQuests, pickQuests, loadQuestDefs } from './quests.js';
import { utcDate } from './daily-streak.js';
import { listFeed } from './social-graph.js';
import { publishToUser } from './realtime-bus.js';
import { _resetRewardCatalogForTests } from './rewards.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();
_resetRewardCatalogForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const cfg = rektConfig(ctx);
const T0 = new Date('2025-06-10T10:00:00Z');
const at = (base: Date, sec: number): Date => new Date(base.getTime() + sec * 1000);

async function newUser(o: { cash?: number; debt?: number; tribe?: string } = {}): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `rb-${id}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, $3)`, [
    id,
    o.cash ?? 500_000,
    o.debt ?? 0,
  ]);
  if (o.tribe) {
    await pool.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
       VALUES ($1, $2, $3, '{}', $4, '{}', 'dream_x', 'parents_basement')`,
      [uuidv7(), id, `b${id.slice(-12)}`, o.tribe],
    );
  }
  return id;
}

const cash = async (u: string): Promise<number> =>
  Number(
    (
      await pool.query<{ c: string }>(`SELECT cash_cents AS c FROM balances WHERE user_id = $1`, [
        u,
      ])
    ).rows[0]!.c,
  );
const ledger = async (u: string, reason: string) =>
  (
    await pool.query<{ delta_cents: string }>(
      `SELECT delta_cents FROM ledger_entries WHERE user_id = $1 AND reason = $2 ORDER BY id`,
      [u, reason],
    )
  ).rows.map((r) => Number(r.delta_cents));
const posts = async (u: string) =>
  (
    await pool.query<{ text: string; kind: string; meta: { event: string } }>(
      `SELECT text, kind, meta FROM feed_posts WHERE user_id = $1 ORDER BY created_at, post_id`,
      [u],
    )
  ).rows;
const pushes = (u: string, type: string) =>
  vi.mocked(publishToUser).mock.calls.filter((c) => c[1] === u && c[2] === type);

/** The server's own last position for the player (what the street room writes), `dx` m from the counter. */
async function stand(u: string, base: Date, dx = 0): Promise<void> {
  await ctx.redis.main.hset(
    POS_HASH,
    u,
    encodePos({ x: cfg.counter.x + dx, z: cfg.counter.z, at: base.getTime() }),
  );
}

/** Clock in at `base` (standing at the counter) and clock out `sec` seconds later. */
async function work(u: string, base: Date, sec = 600) {
  await stand(u, base);
  await startShift(ctx, u, base);
  return endShift(ctx, u, at(base, sec));
}

beforeEach(() => vi.mocked(publishToUser).mockClear());
afterAll(async () => {
  await pool.end();
});

describe('unlocking', () => {
  it('is locked for a solvent player, and starting is refused', async () => {
    const u = await newUser({ cash: 500_000 });
    const v = await getRektBurger(ctx, u, T0);
    expect(v).toMatchObject({ unlocked: false, reason: null, jobId: 'rekt-burger' });
    expect(v.lockedHint).toMatchObject({ cashCents: 500_000, debtCents: 0 });
    await expect(startShift(ctx, u, T0)).rejects.toBeInstanceOf(JobLockedError);
  });

  it('is pre-unlocked for a Trencher, even with cash', async () => {
    const u = await newUser({ cash: 500_000, tribe: 'trencher' });
    expect(await getRektBurger(ctx, u, T0)).toMatchObject({ unlocked: true, reason: 'trencher' });
    // No "just unlocked" toast for a safety net they always had.
    expect(pushes(u, 'job_unlocked')).toHaveLength(0);
    await stand(u, T0);
    expect((await startShift(ctx, u, T0)).shiftId).toBeTruthy();
  });

  it('unlocks for good when broke with debt, and tells the player once', async () => {
    const u = await newUser({ cash: 0, debt: 72_000 });
    expect(await getRektBurger(ctx, u, T0)).toMatchObject({ unlocked: true, reason: 'broke' });
    expect(pushes(u, 'job_unlocked')).toHaveLength(1);
    expect(pushes(u, 'job_unlocked')[0]![3]).toMatchObject({
      jobId: 'rekt-burger',
      reason: 'broke',
      venueId: 'the_trenches',
    });
    await getRektBurger(ctx, u, T0);
    expect(pushes(u, 'job_unlocked')).toHaveLength(1);
    // Cash comes back; the job stays.
    await pool.query(`UPDATE balances SET cash_cents = 900000 WHERE user_id = $1`, [u]);
    expect(await getRektBurger(ctx, u, T0)).toMatchObject({ unlocked: true, reason: 'broke' });
  });

  it('is not unlocked by zero Cash without debt, nor by a little Cash with debt', async () => {
    const a = await newUser({ cash: 0, debt: 0 });
    expect((await getRektBurger(ctx, a, T0)).unlocked).toBe(false);
    const b = await newUser({ cash: 50, debt: 72_000 });
    expect((await getRektBurger(ctx, b, T0)).unlocked).toBe(false);
  });

  it('unlocks when a liquidation leaves Cash under the floor, not above it', async () => {
    const low = await newUser({ cash: cfg.unlock.liquidationCashBelowCents - 1 });
    await onPlayerRekt(ctx, low, T0);
    expect(await getRektBurger(ctx, low, T0)).toMatchObject({
      unlocked: true,
      reason: 'liquidated',
    });
    expect(pushes(low, 'job_unlocked')[0]![3]).toMatchObject({ reason: 'liquidated' });
    const ok = await newUser({ cash: cfg.unlock.liquidationCashBelowCents });
    await onPlayerRekt(ctx, ok, T0);
    expect((await getRektBurger(ctx, ok, T0)).unlocked).toBe(false);
  });

  it('is wired to the real perp liquidation', async () => {
    const u = await newUser({ cash: 1000 });
    const coinId = uuidv7();
    await pool.query(
      `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
                          change_5m_bps, holders, launched_at, hidden_arc, seed)
       VALUES ($1, $2, 'RB test', 'new', 1000000, 1000000, 0, 0, 0, now(), '{}', 1)`,
      [coinId, `R${coinId.slice(-6).toUpperCase()}`],
    );
    const perp = await openPerp(ctx, {
      userId: u,
      coinId,
      side: 'short',
      leverage: 1,
      marginCents: 1000,
    });
    expect((await getRektBurger(ctx, u, T0)).unlocked).toBe(false);
    await pool.query(`UPDATE coins SET price_micros = 100000000 WHERE coin_id = $1`, [coinId]);
    expect(await liquidatePerp(ctx, perp.perpId)).toBe(true);
    const state = await pool.query(
      `SELECT unlock_reason FROM rekt_burger_state WHERE user_id = $1`,
      [u],
    );
    expect(state.rows[0]?.unlock_reason).toBe('liquidated');
  });
});

describe('the clock-in shift', () => {
  it('pays floor(seconds x rate / 60) by server time, writes the ledger row and grants the uniform', async () => {
    expect(cfg.pay.ratePerMinuteCents).toBe(50);
    const u = await newUser({ cash: 0, debt: 1 });
    const r = await work(u, T0, 600);
    expect(r).toMatchObject({
      paidCents: 500,
      minutes: 10,
      durationSec: 600,
      careerXp: 0, // not on a ladder
      cappedCents: 0,
      endReason: 'clock_out',
      uniformGranted: true,
    });
    expect(r.capRemainingCents).toBe(cfg.pay.dailyCapCents - 500);
    expect(await cash(u)).toBe(500);
    expect(await ledger(u, 'job_rekt_burger')).toEqual([500]);
    // A second shift pays too but grants no second uniform.
    const again = await work(u, at(T0, 1200), 100);
    expect(again).toMatchObject({
      paidCents: 83,
      durationSec: 100,
      minutes: 1,
      uniformGranted: false,
    });
    // 65 s: durationSec is the total, minutes the floor; they are not 1 m + 5 s fields.
    const odd = await work(await newUser({ cash: 0, debt: 1 }), T0, 65);
    expect(odd).toMatchObject({ durationSec: 65, minutes: 1 });
    expect(odd).not.toHaveProperty('seconds');
    expect(clockPayCents(cfg, 100)).toBe(83); // floor(100 * 50 / 60)
  });

  it('start returns the contract numbers; the client sends nothing that is trusted', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await stand(u, T0);
    const s = await startShift(ctx, u, T0);
    expect(s).toMatchObject({
      ratePerMinuteCents: 50,
      capRemainingCents: cfg.pay.dailyCapCents,
      startedAt: T0.toISOString(),
      maxEndsAt: at(T0, cfg.shift.maxDurationSec).toISOString(),
      resumed: false,
    });
  });

  it('a double start resumes the open shift: one shift, same id, no position needed', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await stand(u, T0);
    const a = await startShift(ctx, u, T0);
    // The player wandered off and the position went stale: resuming still works.
    const b = await startShift(ctx, u, at(T0, 300));
    expect(b).toMatchObject({ shiftId: a.shiftId, resumed: true, startedAt: a.startedAt });
    expect(b.accruedCents).toBe(250);
    const n = await pool.query(
      `SELECT count(*) AS n FROM rekt_burger_shifts WHERE user_id = $1 AND status = 'open'`,
      [u],
    );
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it('ending without a start, or twice, is a 404 and pays nothing', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await expect(endShift(ctx, u, T0)).rejects.toBeInstanceOf(NotFoundError);
    await work(u, T0, 300);
    await expect(endShift(ctx, u, at(T0, 400))).rejects.toBeInstanceOf(NotFoundError);
    expect(await ledger(u, 'job_rekt_burger')).toEqual([250]);
  });

  it('only the owner can end their shift: another player has none to end (no IDOR)', async () => {
    const a = await newUser({ cash: 0, debt: 1 });
    const b = await newUser({ cash: 0, debt: 1 });
    await stand(a, T0);
    await startShift(ctx, a, T0);
    await expect(endShift(ctx, b, at(T0, 300))).rejects.toBeInstanceOf(NotFoundError);
    expect(await cash(a)).toBe(0);
    expect((await endShift(ctx, a, at(T0, 300))).paidCents).toBe(250);
  });

  it('caps one shift at the maximum length and pays only up to it', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await stand(u, T0);
    await startShift(ctx, u, T0);
    const r = await endShift(ctx, u, at(T0, 5 * 3600)); // clocked out five hours later
    expect(r).toMatchObject({
      durationSec: cfg.shift.maxDurationSec,
      minutes: cfg.shift.maxDurationSec / 60,
      paidCents: maxShiftPayCents(cfg),
      endReason: 'auto',
    });
    expect(maxShiftPayCents(cfg)).toBe(3000);
    expect(await cash(u)).toBe(3000);
  });

  it('the sweep closes a shift left running and pays up to the maximum, on the day worked', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await stand(u, T0);
    await startShift(ctx, u, T0);
    expect(await sweepRektShifts(ctx, at(T0, 600))).toBe(0); // not due yet
    expect(await sweepRektShifts(ctx, at(T0, 30 * 3600))).toBeGreaterThanOrEqual(1);
    const row = await pool.query(
      `SELECT status, pay_cents, seconds, end_reason, finished_at FROM rekt_burger_shifts WHERE user_id = $1`,
      [u],
    );
    expect(row.rows[0]).toMatchObject({ status: 'done', pay_cents: '3000', end_reason: 'auto' });
    expect(row.rows[0].seconds).toBe(cfg.shift.maxDurationSec);
    expect(row.rows[0].finished_at.toISOString()).toBe(
      at(T0, cfg.shift.maxDurationSec).toISOString(),
    );
    expect(await cash(u)).toBe(3000);
    expect(await sweepRektShifts(ctx, at(T0, 31 * 3600))).toBe(0); // nothing left to close
    await expect(endShift(ctx, u, at(T0, 31 * 3600))).rejects.toBeInstanceOf(NotFoundError);
  });

  it('two ends racing pay once', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await stand(u, T0);
    await startShift(ctx, u, T0);
    const res = await Promise.allSettled([
      endShift(ctx, u, at(T0, 600)),
      endShift(ctx, u, at(T0, 600)),
      endShift(ctx, u, at(T0, 600)),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(res.filter((r) => r.status === 'rejected')).toHaveLength(2);
    expect(await ledger(u, 'job_rekt_burger')).toEqual([500]);
    expect(await cash(u)).toBe(500);
  });

  it('an end racing the sweep pays once', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await stand(u, T0);
    await startShift(ctx, u, T0);
    const late = at(T0, 3 * 3600);
    await Promise.allSettled([endShift(ctx, u, late), sweepRektShifts(ctx, late)]);
    expect(await ledger(u, 'job_rekt_burger')).toEqual([3000]);
  });

  it('restores after a relaunch: current shows the open shift, then the paid one', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    expect(await getCurrentShift(ctx, u, T0)).toEqual({ shift: null, lastShift: null });
    await stand(u, T0);
    const s = await startShift(ctx, u, T0);
    const mid = await getCurrentShift(ctx, u, at(T0, 240));
    expect(mid.shift).toMatchObject({
      shiftId: s.shiftId,
      startedAt: T0.toISOString(),
      accruedCents: 200,
      maxEndsAt: at(T0, 3600).toISOString(),
      serverNow: at(T0, 240).toISOString(),
    });
    expect(mid.lastShift).toBeNull();
    // The player closed the app and came back after the maximum: it was closed and paid.
    const later = await getCurrentShift(ctx, u, at(T0, 7200));
    expect(later.shift).toBeNull();
    expect(later.lastShift).toMatchObject({
      shiftId: s.shiftId,
      paidCents: 3000,
      durationSec: 3600,
      minutes: 60,
      endReason: 'auto',
    });
    expect(await cash(u)).toBe(3000);
    // GET /jobs/rekt-burger carries the open shift too.
    const v = await getRektBurger(ctx, u, at(T0, 7300));
    expect(v.shift).toBeNull();
    await stand(u, at(T0, 7300));
    await startShift(ctx, u, at(T0, 7300));
    expect((await getRektBurger(ctx, u, at(T0, 7400))).shift).toMatchObject({ accruedCents: 83 });
  });

  it('leaving the job clocks out and pays an open shift', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await stand(u, T0);
    await startShift(ctx, u, T0);
    const out = await leaveJob(ctx, u, at(T0, 600));
    expect(out.endedShift).toMatchObject({ paidCents: 500, endReason: 'left' });
    expect(await cash(u)).toBe(500);
    expect((await getCurrentShift(ctx, u, at(T0, 700))).shift).toBeNull();
  });
});

describe('the position gate', () => {
  it('needs a fresh server position near the counter to clock in', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    // No position at all.
    await ctx.redis.main.hdel(POS_HASH, u);
    await expect(startShift(ctx, u, T0)).rejects.toBeInstanceOf(PositionUnknownError);
    // A stale one (older than 30 s).
    await stand(u, T0);
    await expect(startShift(ctx, u, at(T0, 31))).rejects.toBeInstanceOf(PositionUnknownError);
    // Too far: the error says how far, nothing opens.
    await stand(u, T0, cfg.counter.radiusM + 60);
    const far = await startShift(ctx, u, T0).catch((e: unknown) => e);
    expect(far).toBeInstanceOf(CounterTooFarError);
    expect((far as CounterTooFarError).details).toMatchObject({ radiusM: cfg.counter.radiusM });
    expect((far as CounterTooFarError).details.distanceM).toBe(cfg.counter.radiusM + 60);
    const none = await pool.query(`SELECT 1 FROM rekt_burger_shifts WHERE user_id = $1`, [u]);
    expect(none.rowCount).toBe(0);
    // At the edge it works.
    await stand(u, T0, cfg.counter.radiusM - 0.5);
    expect((await startShift(ctx, u, T0)).shiftId).toBeTruthy();
  });

  it('clocking OUT needs no position: the player may have left the app', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await stand(u, T0);
    await startShift(ctx, u, T0);
    await ctx.redis.main.hdel(POS_HASH, u);
    expect((await endShift(ctx, u, at(T0, 600))).paidCents).toBe(500);
  });
});

describe('the daily cap', () => {
  it('trims the shift to the cap, refuses to start at the cap, resets at UTC midnight', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    // 4500 cap, 3000 per full shift: the second full shift is trimmed to 1500.
    const first = await work(u, T0, 3600);
    expect(first.paidCents).toBe(3000);
    const second = await work(u, at(T0, 4000), 3600);
    expect(second).toMatchObject({ paidCents: 1500, cappedCents: 1500, capRemainingCents: 0 });
    expect(first.paidCents + second.paidCents).toBe(cfg.pay.dailyCapCents);
    expect((await getRektBurger(ctx, u, at(T0, 9000))).pay).toMatchObject({
      earnedTodayCents: cfg.pay.dailyCapCents,
      remainingTodayCents: 0,
    });
    await stand(u, at(T0, 9000));
    await expect(startShift(ctx, u, at(T0, 9000))).rejects.toBeInstanceOf(JobDailyCapError);
    const tomorrow = new Date('2025-06-11T00:00:01Z');
    expect((await work(u, tomorrow, 600)).paidCents).toBe(500);
  });

  it('pays only what is left when a shift crosses the cap, and the open shift shows it', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await pool.query(
      `INSERT INTO rekt_burger_shifts (shift_id, user_id, status, started_at, finished_at, pay_cents)
       VALUES ($1, $2, 'done', $3, $3, $4)`,
      [uuidv7(), u, T0, cfg.pay.dailyCapCents - 100],
    );
    await stand(u, at(T0, 600));
    const s = await startShift(ctx, u, at(T0, 600));
    expect(s.capRemainingCents).toBe(100);
    expect((await getCurrentShift(ctx, u, at(T0, 600 + 1800))).shift!.accruedCents).toBe(100);
    const r = await endShift(ctx, u, at(T0, 600 + 1800));
    expect(r).toMatchObject({ paidCents: 100, cappedCents: 1400, capRemainingCents: 0 });
    expect(await cash(u)).toBe(100);
  });
});

describe('career XP and the quest hook', () => {
  async function joinLadder(u: string, ladder = 'farmer'): Promise<void> {
    await pool.query(`INSERT INTO ladder_membership (user_id, ladder_id) VALUES ($1, $2)`, [
      u,
      ladder,
    ]);
  }
  const xpRows = async (u: string) =>
    Number(
      (
        await pool.query(
          `SELECT COALESCE(SUM(amount),0) AS n FROM ladder_xp_events WHERE user_id = $1 AND source = 'action'`,
          [u],
        )
      ).rows[0].n,
    );

  it('time-based XP for a player on a ladder, none for one who is not enrolled', async () => {
    const on = await newUser({ cash: 0, debt: 1 });
    await joinLadder(on);
    const r = await work(on, T0, 600);
    expect(r.careerXp).toBe(10); // 1 per minute
    expect(await xpRows(on)).toBe(10);
    const off = await newUser({ cash: 0, debt: 1 });
    expect((await work(off, T0, 600)).careerXp).toBe(0);
  });

  it('is behind the shared daily action cap and a shift under the minimum earns none', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await joinLadder(u);
    await pool.query(
      `INSERT INTO ladder_xp_events (user_id, ladder_id, source, ref, amount, created_at)
       VALUES ($1, 'farmer', 'action', 'seed:1', 117, $2)`,
      [u, T0],
    );
    const r = await work(u, at(T0, 60), 600);
    expect(r.careerXp).toBe(3); // 10 earned, only 120 - 117 left today
    const short = await newUser({ cash: 0, debt: 1 });
    await joinLadder(short);
    const s = await work(short, T0, cfg.shift.minCountedSec - 1);
    expect(s).toMatchObject({ careerXp: 0, uniformGranted: false });
    expect(s.paidCents).toBeGreaterThan(0); // still paid by time
  });

  it('a shift under the minimum does not count for the shift_complete quest', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await work(u, T0, 30);
    const counted = await pool.query(
      `SELECT 1 FROM quest_events WHERE user_id = $1 AND verb = 'shift_complete'`,
      [u],
    );
    expect(counted.rowCount).toBe(0);
    await work(u, at(T0, 600), cfg.shift.minCountedSec);
    // (quest_events only records when the player has such a quest today; the hook itself
    // is covered by the Season XP test below.)
  });
});
describe('Timeline posts', () => {
  it('posts "Back to the trenches" once per stint on the first shift', async () => {
    const u = await newUser({ cash: 0, debt: 72_000 });
    await work(u, T0);
    await work(u, at(T0, 600));
    const p = await posts(u);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: 'career', meta: { event: 'back_to_trenches' } });
    expect(p[0]!.text).toMatch(/back to the trenches/i);
    expect(p[0]!.text).toMatch(/McDonald/);
    expect(p[0]!.text.length).toBeLessThanOrEqual(280);
    // Followers see it in their feed as a career post (the global page is shared, so
    // read it through a follow).
    const viewer = await newUser();
    await pool.query(`INSERT INTO follows (follower_user_id, followee_user_id) VALUES ($1, $2)`, [
      viewer,
      u,
    ]);
    const feed = (await listFeed(ctx, viewer, 'following')).find((f) => f.userId === u);
    expect(feed).toMatchObject({
      kind: 'career',
      meta: { event: 'back_to_trenches', jobId: 'rekt-burger' },
    });
  });

  it('posts a Glow-up when leaving after net worth recovered, and not when still under', async () => {
    const u = await newUser({ cash: 0, debt: 72_000 });
    await work(u, T0);
    // Still under the line: leaves quietly.
    const quiet = await leaveJob(ctx, u, at(T0, 700));
    expect(quiet).toMatchObject({ wasEmployed: true, glowUp: false, postId: null });
    expect((await posts(u)).map((x) => x.meta.event)).toEqual(['back_to_trenches']);

    // A new stint, then a windfall, then leaving posts the Glow-up.
    await work(u, at(T0, 3600 * 30)); // > 24 h later: a new "back to the trenches" too
    await pool.query(`UPDATE balances SET cash_cents = $2, debt_cents = 0 WHERE user_id = $1`, [
      u,
      cfg.glowUpNetWorthCents + 5000,
    ]);
    const out = await leaveJob(ctx, u, at(T0, 3600 * 31));
    expect(out).toMatchObject({ glowUp: true });
    const events = (await posts(u)).map((x) => x.meta.event);
    expect(events).toEqual(['back_to_trenches', 'back_to_trenches', 'glow_up']);
    expect((await posts(u)).at(-1)!.text).toMatch(/glow-up/i);
    expect((await posts(u)).at(-1)!.text).toMatch(/McDonald/);
  });

  it('does not repost within the cooldown, and a leave with no job is harmless', async () => {
    const u = await newUser({ cash: 0, debt: 72_000 });
    await work(u, T0);
    await leaveJob(ctx, u, at(T0, 700));
    await work(u, at(T0, 3600)); // 1 h later, same stint rules: new stint, cooldown holds
    expect((await posts(u)).filter((x) => x.meta.event === 'back_to_trenches')).toHaveLength(1);
    const nobody = await newUser();
    expect(await leaveJob(ctx, nobody, T0)).toMatchObject({ wasEmployed: false, glowUp: false });
  });

  it('a Trencher who was never down cannot farm Glow-up posts', async () => {
    const u = await newUser({ cash: cfg.glowUpNetWorthCents + 1, tribe: 'trencher' });
    await work(u, T0);
    expect(await leaveJob(ctx, u, at(T0, 700))).toMatchObject({ glowUp: false });
  });
});

describe('quests and Season XP', () => {
  it('counts for shift_complete quests, whose claim pays Season XP', async () => {
    const defs = loadQuestDefs(ctx);
    const dailyPool = defs.filter((d) => d.pool === 'daily');
    const today = utcDate(new Date());
    let u = '';
    for (let i = 0; i < 4000 && !u; i++) {
      const id = uuidv7();
      if (
        pickQuests(id, today, dailyPool, 3).some(
          (q) => q.verb === 'shift_complete' && q.target === 1,
        )
      ) {
        u = id;
      }
    }
    expect(u).not.toBe('');
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [u, `rb-q-${u}`]);
    await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 1)`, [
      u,
    ]);
    const now = new Date();
    await work(u, new Date(now.getTime() - 601_000));
    const q = (await listQuests(ctx, u, now)).daily.quests.find(
      (x) => x.verb === 'shift_complete' && x.target === 1,
    )!;
    expect(q.progress).toBe(1);
    expect(q.completed).toBe(true);
    const claim = await claimQuest(ctx, u, q.id, now);
    expect(claim.alreadyClaimed).toBe(false);
    const xp = await pool.query<{ amount: number; source: string }>(
      `SELECT amount, source FROM season_xp WHERE user_id = $1`,
      [u],
    );
    expect(xp.rows).toHaveLength(1);
    expect(xp.rows[0]).toMatchObject({ source: 'quest' });
    expect(pushes(u, 'quest_progress').length).toBeGreaterThanOrEqual(1);
  });
});
