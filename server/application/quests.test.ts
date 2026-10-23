/**
 * Quest tests: deterministic picks, progress from real server events (a shift, a perp, a
 * tip) and from controlled-clock events, the claim (Cash, ledger, Season XP, idempotency),
 * and the access rules. The realtime push is stubbed and inspected.
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
import { NotFoundError, QuestNotCompleteError } from '../shared/domain/errors.js';
import {
  claimQuest,
  listQuests,
  loadQuestDefs,
  pickQuests,
  recordQuestEvent,
  type QuestVerb,
} from './quests.js';
import { utcDate } from './daily-streak.js';
import { weekIso } from './season-clock.js';
import { publishToUser } from './realtime-bus.js';
import { ShiftsService, _shifts } from './shifts.js';
import { closePerp, openPerp } from './perp-pit.js';
import { sendCashTip } from './tips.js';
import { createHome, recordVisit } from './homes.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const defs = loadQuestDefs(ctx);
const dailyPool = defs.filter((d) => d.pool === 'daily');

const NOW = new Date('2090-04-12T12:00:00Z'); // a Wednesday
const TODAY = utcDate(NOW);

async function newUser(cashCents = 0): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `quest-${id}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)`, [id, cashCents]);
  return id;
}

/** A new user whose daily picks for the real today include `verb`. */
async function userWithDailyVerb(...verbs: QuestVerb[]): Promise<string> {
  const today = utcDate(new Date());
  for (let i = 0; i < 2000; i++) {
    const id = uuidv7();
    const picked = pickQuests(id, today, dailyPool, 3).map((q) => q.verb);
    if (verbs.every((v) => picked.includes(v))) {
      await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `quest-${id}`]);
      await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, 1000000)`, [id]);
      return id;
    }
  }
  throw new Error('no user found');
}

beforeEach(() => {
  vi.mocked(publishToUser).mockClear();
});

afterAll(async () => {
  await pool.end();
});

describe('quest picks', () => {
  it('are deterministic per user and date, three daily and five weekly, of the right pools', async () => {
    const u = await newUser();
    const a = await listQuests(ctx, u, NOW);
    const b = await listQuests(ctx, u, new Date('2090-04-12T23:59:00Z'));
    expect(a.daily.quests.map((q) => q.id)).toEqual(b.daily.quests.map((q) => q.id));
    expect(a.weekly.quests.map((q) => q.id)).toEqual(b.weekly.quests.map((q) => q.id));
    expect(a.daily.quests).toHaveLength(3);
    expect(a.weekly.quests).toHaveLength(5);
    expect(a.daily.quests.every((q) => q.id.startsWith('q_daily_'))).toBe(true);
    expect(a.weekly.quests.every((q) => q.id.startsWith('q_weekly_'))).toBe(true);
    expect(new Set(a.daily.quests.map((q) => q.verb)).size).toBe(3);
    expect(a.weekly.quests.map((q) => q.step)).toEqual([1, 2, 3, 4, 5]);
    expect(a.daily.date).toBe(TODAY);
    expect(a.daily.resetsAt).toBe('2090-04-13T00:00:00.000Z');
    expect(a.weekly.resetsAt).toBe('2090-04-17T00:00:00.000Z'); // the next Monday
    // Same week, other day: same weekly chain.
    const c = await listQuests(ctx, u, new Date('2090-04-15T09:00:00Z'));
    expect(c.weekly.quests.map((q) => q.id)).toEqual(a.weekly.quests.map((q) => q.id));
    // The pure function agrees, and a different user or day gives a different spread.
    expect(pickQuests(u, TODAY, dailyPool, 3).map((q) => q.id)).toEqual(
      a.daily.quests.map((q) => q.id),
    );
    const spread = new Set<string>();
    for (let i = 0; i < 20; i++) {
      spread.add(
        pickQuests(uuidv7(), TODAY, dailyPool, 3)
          .map((q) => q.id)
          .join(),
      );
    }
    expect(spread.size).toBeGreaterThan(1);
  });
});

describe('progress and claim (controlled clock)', () => {
  it('counts each source event once, caps at the target, and pushes quest_progress', async () => {
    const u = await newUser();
    const q = (await listQuests(ctx, u, NOW)).daily.quests[0]!;
    for (let i = 0; i < q.target + 2; i++) {
      await recordQuestEvent(ctx, u, q.verb, `ref-${i}`, NOW);
    }
    // A replay of an already-counted ref does nothing.
    await recordQuestEvent(ctx, u, q.verb, 'ref-0', NOW);
    const after = (await listQuests(ctx, u, NOW)).daily.quests.find((x) => x.id === q.id)!;
    expect(after.progress).toBe(q.target);
    expect(after.completed).toBe(true);
    expect(after.claimed).toBe(false);
    const pushes = vi
      .mocked(publishToUser)
      .mock.calls.filter((c) => c[1] === u && c[2] === 'quest_progress' && c[3].questId === q.id);
    expect(pushes.length).toBeGreaterThanOrEqual(q.target);
    const last = pushes[pushes.length - 1]![3];
    expect(last).toMatchObject({
      pool: 'daily',
      progress: q.target,
      target: q.target,
      completed: true,
    });
    expect(typeof last.at).toBe('number');
  });

  it('ignores a verb the player has no quest for', async () => {
    const u = await newUser();
    const verbs = new Set((await listQuests(ctx, u, NOW)).daily.quests.map((x) => x.verb));
    const weekly = new Set((await listQuests(ctx, u, NOW)).weekly.quests.map((x) => x.verb));
    const other = (
      [
        'shift_complete',
        'perp_open',
        'perp_close',
        'prediction_place',
        'alpha_call',
        'paid_call',
        'tip_send',
        'home_visit',
      ] as QuestVerb[]
    ).find((v) => !verbs.has(v) && !weekly.has(v));
    if (other) {
      await recordQuestEvent(ctx, u, other, 'x', NOW);
      const n = await pool.query(`SELECT count(*) AS n FROM quest_progress WHERE user_id = $1`, [
        u,
      ]);
      expect(Number(n.rows[0].n)).toBe(0);
    }
    expect(vi.mocked(publishToUser)).not.toHaveBeenCalledWith(
      expect.anything(),
      u,
      'quest_progress',
      expect.anything(),
    );
  });

  it('claims a finished quest: Cash, a quest_reward ledger row and Season XP, once', async () => {
    const u = await newUser();
    const q = (await listQuests(ctx, u, NOW)).daily.quests[1]!;
    await expect(claimQuest(ctx, u, q.id, NOW)).rejects.toBeInstanceOf(QuestNotCompleteError);
    for (let i = 0; i < q.target; i++) await recordQuestEvent(ctx, u, q.verb, `c-${i}`, NOW);

    const a = await claimQuest(ctx, u, q.id, NOW);
    expect(a.alreadyClaimed).toBe(false);
    expect(a.reward).toEqual(q.reward);
    const b = await claimQuest(ctx, u, q.id, NOW);
    expect(b.alreadyClaimed).toBe(true);

    const bal = await pool.query(`SELECT cash_cents FROM balances WHERE user_id = $1`, [u]);
    expect(Number(bal.rows[0].cash_cents)).toBe(q.reward.cashCents);
    const led = await pool.query(
      `SELECT reason, delta_cents FROM ledger_entries WHERE user_id = $1`,
      [u],
    );
    expect(led.rows.map((r) => [r.reason, Number(r.delta_cents)])).toEqual([
      ['quest_reward', q.reward.cashCents],
    ]);
    const xp = await pool.query(
      `SELECT amount, source, season_iso FROM season_xp WHERE user_id = $1`,
      [u],
    );
    expect(xp.rows).toEqual([
      { amount: q.reward.seasonXp, source: 'quest', season_iso: weekIso(NOW) },
    ]);
    expect((await listQuests(ctx, u, NOW)).daily.quests.find((x) => x.id === q.id)!.claimed).toBe(
      true,
    );
  });

  it('pays a weekly quest and rolls daily progress over at midnight UTC', async () => {
    const u = await newUser();
    const w = (await listQuests(ctx, u, NOW)).weekly.quests[0]!;
    for (let i = 0; i < w.target; i++) await recordQuestEvent(ctx, u, w.verb, `w-${i}`, NOW);
    // Still claimable later in the same week.
    const friday = new Date('2090-04-14T20:00:00Z');
    expect((await claimQuest(ctx, u, w.id, friday)).reward.cashCents).toBe(w.reward.cashCents);
    // Next week it is a fresh, unfinished chain.
    const nextWeek = await listQuests(ctx, u, new Date('2090-04-18T08:00:00Z'));
    expect(nextWeek.weekly.week).not.toBe((await listQuests(ctx, u, NOW)).weekly.week);
    expect(nextWeek.weekly.quests.every((x) => x.progress === 0)).toBe(true);
  });

  it('does not let a player claim a quest that is not theirs today (no IDOR, no free pick)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const mine = (await listQuests(ctx, owner, NOW)).daily.quests.map((x) => x.id);
    const theirs = (await listQuests(ctx, other, NOW)).daily.quests.map((x) => x.id);
    const foreign = dailyPool.find((d) => !theirs.includes(d.id))!;
    // Finish the owner's quest, then try it as someone else it was not assigned to.
    const q = (await listQuests(ctx, owner, NOW)).daily.quests.find((x) => !theirs.includes(x.id));
    if (q) {
      for (let i = 0; i < q.target; i++) await recordQuestEvent(ctx, owner, q.verb, `i-${i}`, NOW);
      await expect(claimQuest(ctx, other, q.id, NOW)).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(mine).toHaveLength(3);
    await expect(claimQuest(ctx, other, foreign.id, NOW)).rejects.toBeInstanceOf(NotFoundError);
    await expect(claimQuest(ctx, other, 'q_nope', NOW)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('progress from real server events', () => {
  async function progressOf(userId: string, verb: QuestVerb): Promise<number> {
    const l = await listQuests(ctx, userId);
    return l.daily.quests.filter((q) => q.verb === verb).reduce((n, q) => n + q.progress, 0);
  }

  it('a completed work shift advances shift_complete', async () => {
    const u = await userWithDailyVerb('shift_complete');
    const careerId = ctx.configCache.load<{ careers: Array<{ id: string }> }>('careers').careers[0]!
      .id;
    const svc = new ShiftsService(ctx);
    const shift = await svc.start(u, careerId);
    const s = _shifts.get(shift.shiftId)!;
    _shifts.set(shift.shiftId, { ...s, endsAt: 0 });
    expect(await progressOf(u, 'shift_complete')).toBe(0);
    await svc.complete(u, shift.shiftId, [{ miniGameId: s.miniGameId, score: 50 }]);
    expect(await progressOf(u, 'shift_complete')).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(publishToUser)).toHaveBeenCalledWith(
      expect.anything(),
      u,
      'quest_progress',
      expect.objectContaining({ progress: expect.any(Number) }),
    );
  });

  it('opening and closing a perp advance perp_open and perp_close', async () => {
    const o = await userWithDailyVerb('perp_open', 'perp_close');
    const coinId = uuidv7();
    await pool.query(
      `INSERT INTO coins (coin_id, ticker, name, stage, price_micros, mcap_cents, vol_5m_cents,
                          change_5m_bps, holders, launched_at, hidden_arc, seed)
       VALUES ($1, $2, 'Quest test', 'new', 1000000, 1000000, 0, 0, 0, now(), '{}', 1)`,
      [coinId, `Q${coinId.slice(-6).toUpperCase()}`],
    );
    const perp = await openPerp(ctx, {
      userId: o,
      coinId,
      side: 'long',
      leverage: 1,
      marginCents: 1000,
    });
    expect(await progressOf(o, 'perp_open')).toBe(1);
    expect(await progressOf(o, 'perp_close')).toBe(0);
    await closePerp(ctx, o, perp.perpId);
    expect(await progressOf(o, 'perp_close')).toBe(1);
    expect(await progressOf(o, 'perp_open')).toBe(1);
  });

  it('a tip of at least $1 advances tip_send; a smaller one does not', async () => {
    const t = await userWithDailyVerb('tip_send');
    const to = await newUser();
    await sendCashTip(ctx, t, to, 99, null);
    expect(await progressOf(t, 'tip_send')).toBe(0);
    await sendCashTip(ctx, t, to, 100, null);
    expect(await progressOf(t, 'tip_send')).toBeGreaterThanOrEqual(1);
  });

  it("visiting someone else's home advances home_visit; visiting your own does not", async () => {
    const v = await userWithDailyVerb('home_visit');
    const owner = await userWithDailyVerb('home_visit');
    await createHome(ctx, owner, 'parents_basement');
    // A basement has no door in the shipped units file, so it is open to visitors.
    await recordVisit(ctx, owner, owner);
    expect(await progressOf(owner, 'home_visit')).toBe(0);
    await recordVisit(ctx, owner, v);
    expect(await progressOf(v, 'home_visit')).toBeGreaterThanOrEqual(1);
    await pool.query(
      `DELETE FROM home_visits WHERE home_id IN (SELECT home_id FROM homes WHERE owner_user_id = $1)`,
      [owner],
    );
    await pool.query(`DELETE FROM homes WHERE owner_user_id = $1`, [owner]);
  });
});
