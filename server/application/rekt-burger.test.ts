/**
 * Rekt Burger tests: who unlocks it (Trencher, broke, liquidated), the server-validated
 * shift (plausibility rules, pay maths, the daily cap, replays, IDOR), the Timeline posts,
 * and the quest hook. The realtime push is stubbed and inspected.
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
  ConflictError,
  JobDailyCapError,
  JobLockedError,
  NotFoundError,
  ShiftNotFinishedError,
  ShiftResultImplausibleError,
} from '../shared/domain/errors.js';
import {
  finishShift,
  getRektBurger,
  leaveJob,
  maxShiftPayCents,
  onPlayerRekt,
  rektConfig,
  shiftPayCents,
  startShift,
  validateOrders,
  type OrderReport,
} from './rekt-burger.js';
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

/** A human-looking report: `n` tickets, a serve time of 3-6 s, 5-9 s apart; first `wrong` wrong. */
function orders(n: number, wrong = 0, fast = false): OrderReport[] {
  const out: OrderReport[] = [];
  let served = 4000;
  for (let i = 0; i < n; i++) {
    const serve = (fast ? 1500 : 3000) + ((i * 937) % (fast ? 1500 : 3000));
    served += (fast ? 1800 : 5000) + ((i * 611) % (fast ? 1400 : 4000));
    out.push({ i, startedMs: served - serve, servedMs: served, correct: i >= wrong });
  }
  return out;
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

/** Start a shift now and finish it 60 s later with `n` orders. */
async function work(u: string, base: Date, n = 8, wrong = 0) {
  const s = await startShift(ctx, u, base);
  const fast = n > 12; // a busy shift: more tickets, so it runs longer
  return finishShift(ctx, u, s.shiftId, orders(n, wrong, fast), at(base, fast ? 120 : 60));
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

describe('plausibility', () => {
  const rules = cfg.shift;
  const elapsed = 60_000;
  const bad = (o: readonly OrderReport[], ms = elapsed) => {
    const r = validateOrders(o, ms, rules);
    return r.ok ? 'ok' : r.reason;
  };

  it('accepts a human-looking shift and counts the correct orders', () => {
    expect(validateOrders(orders(6, 2), elapsed, rules)).toEqual({
      ok: true,
      count: 6,
      correct: 4,
    });
  });

  it('rejects too few and too many orders', () => {
    expect(bad(orders(rules.minOrders - 1))).toBe('order_count');
    expect(bad([])).toBe('order_count');
    expect(bad(orders(rules.maxOrders + 1), 10_000_000)).toBe('order_count');
  });

  it('rejects orders served faster than a person can, or crowding each other', () => {
    const o = orders(6);
    expect(bad(o.map((x, k) => (k === 2 ? { ...x, startedMs: x.servedMs - 300 } : x)))).toBe(
      'serve_time',
    );
    // Two serves 400 ms apart.
    const squeezed = o.map((x, k) =>
      k === 3
        ? { ...x, servedMs: o[2]!.servedMs + 400, startedMs: o[2]!.servedMs + 400 - 3000 }
        : x,
    );
    expect(bad(squeezed)).toBe('too_fast');
  });

  it('rejects a ticket that took absurdly long, times that run backwards, or bad numbering', () => {
    const o = orders(6);
    expect(
      bad(
        o.map((x, k) => (k === 1 ? { ...x, startedMs: x.servedMs - 90_000 } : x)),
        200_000,
      ),
    ).toBe('order_times');
    expect(bad(o.map((x, k) => (k === 1 ? { ...x, servedMs: x.startedMs - 1 } : x)))).toBe(
      'order_times',
    );
    expect(bad(o.map((x, k) => (k === 4 ? { ...x, i: 9 } : x)))).toBe('order_index');
  });

  it('rejects serves after the server saw the shift end, with a small network tolerance', () => {
    const o = orders(6);
    const last = o[5]!.servedMs;
    expect(bad(o, last - rules.toleranceMs - 1)).toBe('served_after_finish');
    expect(bad(o, last - rules.toleranceMs)).toBe('ok');
  });

  it('rejects machine-regular timing', () => {
    const robot = Array.from({ length: 8 }, (_, i) => ({
      i,
      startedMs: 2000 + i * 5000,
      servedMs: 5000 + i * 5000,
      correct: true,
    }));
    expect(bad(robot)).toBe('robotic_timing');
  });

  it('pays in integer cents with a per-shift ceiling', () => {
    expect(shiftPayCents(cfg, 0)).toBe(cfg.pay.baseCents);
    expect(shiftPayCents(cfg, 5)).toBe(cfg.pay.baseCents + 5 * cfg.pay.perCorrectOrderCents);
    expect(shiftPayCents(cfg, 10_000)).toBe(maxShiftPayCents(cfg));
    expect(Number.isInteger(maxShiftPayCents(cfg))).toBe(true);
  });
});

describe('the shift', () => {
  it('pays from the server maths, writes the job_rekt_burger ledger row, grants the uniform', async () => {
    const u = await newUser({ cash: 0, debt: 72_000 });
    const r = await work(u, T0, 8, 2); // 6 correct
    expect(r).toMatchObject({ orders: 8, correct: 6, cappedCents: 0, uniformGranted: true });
    const expected = cfg.pay.baseCents + 6 * cfg.pay.perCorrectOrderCents;
    expect(r.payCents).toBe(expected);
    expect(await cash(u)).toBe(expected);
    expect(await ledger(u, 'job_rekt_burger')).toEqual([expected]);
    const owned = await pool.query(
      `SELECT 1 FROM cosmetic_inventory ci JOIN cosmetic_items it ON it.item_id = ci.item_id
        WHERE ci.user_id = $1 AND it.item_key = 'reward_rekt_burger_uniform'`,
      [u],
    );
    expect(owned.rowCount).toBe(1);
    // The uniform is a one-off.
    const again = await work(u, at(T0, 3600));
    expect(again.uniformGranted).toBe(false);
  });

  it('keeps the shift open when finished too early, and the same shift can finish later', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    const s = await startShift(ctx, u, T0);
    await expect(finishShift(ctx, u, s.shiftId, orders(8), at(T0, 10))).rejects.toBeInstanceOf(
      ShiftNotFinishedError,
    );
    expect((await finishShift(ctx, u, s.shiftId, orders(8), at(T0, 60))).payCents).toBeGreaterThan(
      0,
    );
  });

  it('burns the shift on an implausible report, pays nothing, and cannot be retried', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    const s = await startShift(ctx, u, T0);
    const before = await cash(u);
    await expect(finishShift(ctx, u, s.shiftId, orders(2), at(T0, 60))).rejects.toBeInstanceOf(
      ShiftResultImplausibleError,
    );
    expect(await cash(u)).toBe(before);
    expect(await ledger(u, 'job_rekt_burger')).toEqual([]);
    await expect(finishShift(ctx, u, s.shiftId, orders(8), at(T0, 61))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('voids a shift left open past the maximum', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    const s = await startShift(ctx, u, T0);
    await expect(
      finishShift(ctx, u, s.shiftId, orders(8), at(T0, cfg.shift.maxDurationSec + 30)),
    ).rejects.toBeInstanceOf(ConflictError);
    // A fresh shift can start.
    const next = await startShift(ctx, u, at(T0, cfg.shift.maxDurationSec + 31));
    expect(next.shiftId).not.toBe(s.shiftId);
  });

  it('pays a shift once: a second finish is a conflict, a second start resumes the open shift', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    const s = await startShift(ctx, u, T0);
    const again = await startShift(ctx, u, at(T0, 5));
    expect(again).toMatchObject({ shiftId: s.shiftId, resumed: true });
    await finishShift(ctx, u, s.shiftId, orders(8), at(T0, 60));
    await expect(finishShift(ctx, u, s.shiftId, orders(8), at(T0, 61))).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await ledger(u, 'job_rekt_burger')).toHaveLength(1);
  });

  it('finishes the open shift when no id is given, and never another player shift (no IDOR)', async () => {
    const a = await newUser({ cash: 0, debt: 1 });
    const b = await newUser({ cash: 0, debt: 1 });
    const sa = await startShift(ctx, a, T0);
    await startShift(ctx, b, T0);
    await expect(finishShift(ctx, b, sa.shiftId, orders(8), at(T0, 60))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await finishShift(ctx, a, null, orders(8), at(T0, 60))).shiftId).toBe(sa.shiftId);
    expect(await ledger(b, 'job_rekt_burger')).toEqual([]);
  });

  it('reports shift state on GET and nothing once finished', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    const s = await startShift(ctx, u, T0);
    const v = await getRektBurger(ctx, u, at(T0, 5));
    expect(v.shift).toMatchObject({ shiftId: s.shiftId });
    expect(v.shift!.minFinishAt).toBe(at(T0, cfg.shift.minDurationSec).toISOString());
    await finishShift(ctx, u, s.shiftId, orders(8), at(T0, 60));
    expect((await getRektBurger(ctx, u, at(T0, 61))).shift).toBeNull();
  });
});

describe('the daily cap', () => {
  it('trims the last shift to the cap, then refuses to start, then resets at UTC midnight', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    // 4500 cap; a full shift pays 300 + 20*60 = 1500. Three full shifts fill it.
    let paid = 0;
    for (let k = 0; k < 3; k++) {
      const r = await work(u, at(T0, k * 600), 30);
      expect(r.payCents).toBe(maxShiftPayCents(cfg));
      paid += r.payCents;
    }
    expect(paid).toBe(cfg.pay.dailyCapCents);
    expect((await getRektBurger(ctx, u, at(T0, 2000))).pay).toMatchObject({
      earnedTodayCents: cfg.pay.dailyCapCents,
      remainingTodayCents: 0,
    });
    await expect(startShift(ctx, u, at(T0, 2000))).rejects.toBeInstanceOf(JobDailyCapError);
    const tomorrow = new Date('2025-06-11T00:00:01Z');
    expect((await work(u, tomorrow)).payCents).toBeGreaterThan(0);
  });

  it('pays only what is left when a shift crosses the cap', async () => {
    const u = await newUser({ cash: 0, debt: 1 });
    await pool.query(
      `INSERT INTO rekt_burger_shifts (shift_id, user_id, status, started_at, finished_at, orders, correct, pay_cents)
       VALUES ($1, $2, 'done', $3, $3, 10, 10, $4)`,
      [uuidv7(), u, T0, cfg.pay.dailyCapCents - 100],
    );
    const r = await work(u, at(T0, 600), 8);
    expect(r.payCents).toBe(100);
    expect(r.cappedCents).toBe(shiftPayCents(cfg, 8) - 100);
    expect(r.remainingTodayCents).toBe(0);
    expect(await cash(u)).toBe(100);
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
    expect(p[0]!.text).toMatch(/Rekt Burger/);
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
    const quiet = await leaveJob(ctx, u, at(T0, 100));
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
    expect((await posts(u)).at(-1)!.text).not.toMatch(/mcdonald/i);
  });

  it('does not repost within the cooldown, and a leave with no job is harmless', async () => {
    const u = await newUser({ cash: 0, debt: 72_000 });
    await work(u, T0);
    await leaveJob(ctx, u, at(T0, 100));
    await work(u, at(T0, 3600)); // 1 h later, same stint rules: new stint, cooldown holds
    expect((await posts(u)).filter((x) => x.meta.event === 'back_to_trenches')).toHaveLength(1);
    const nobody = await newUser();
    expect(await leaveJob(ctx, nobody, T0)).toMatchObject({ wasEmployed: false, glowUp: false });
  });

  it('a Trencher who was never down cannot farm Glow-up posts', async () => {
    const u = await newUser({ cash: cfg.glowUpNetWorthCents + 1, tribe: 'trencher' });
    await work(u, T0);
    expect(await leaveJob(ctx, u, at(T0, 100))).toMatchObject({ glowUp: false });
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
    await work(u, new Date(now.getTime() - 120_000));
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
