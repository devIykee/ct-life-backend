/**
 * Career ladder tests: config sanity, joining and the switch cooldown, XP to promotion and
 * the realtime event, perks applied to pay, action XP (idempotent and capped), the
 * cosmetic, the venue-area flag. The realtime push is stubbed and inspected.
 */
import { readFileSync } from 'node:fs';
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
import { CareerSwitchCooldownError, NotFoundError } from '../shared/domain/errors.js';
import {
  careerAreasAt,
  getLadders,
  joinLadder,
  laddersConfig,
  payBonusCents,
  rankForXp,
  recordCareerAction,
  venueAreasUpTo,
} from './ladders.js';
import { publishToUser } from './realtime-bus.js';
import { ShiftsService, _shifts } from './shifts.js';
import { recordQuestEvent } from './quests.js';
import { _resetRewardCatalogForTests } from './rewards.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();
_resetRewardCatalogForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const cfg = laddersConfig(ctx);
const NOW = new Date('2090-04-12T12:00:00Z');

async function newUser(tribeId?: string): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `ladder-${id}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, 1000000)`, [id]);
  if (tribeId) {
    await pool.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
       VALUES ($1, $2, $3, '{}', $4, '{}', 'dream_x', 'parents_basement')`,
      [uuidv7(), id, `a${id.slice(-12)}`, tribeId],
    );
  }
  return id;
}

async function setProgress(u: string, ladderId: string, xp: number, rank: number): Promise<void> {
  await pool.query(
    `INSERT INTO ladder_progress (user_id, ladder_id, xp, rank) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, ladder_id) DO UPDATE SET xp = $3, rank = $4`,
    [u, ladderId, xp, rank],
  );
}

/** Run one perfect shift on a job and return what the service reported. */
async function perfectShift(u: string, careerId: string) {
  const svc = new ShiftsService(ctx);
  const shift = await svc.start(u, careerId);
  const s = _shifts.get(shift.shiftId)!;
  _shifts.set(shift.shiftId, { ...s, endsAt: 0 });
  const games = JSON.parse(readFileSync('contract/ids/mini_games.json', 'utf8')) as {
    miniGames: Array<{ id: string; maxScore: number }>;
  };
  const max = games.miniGames.find((g) => g.id === s.miniGameId)!.maxScore;
  return svc.complete(u, shift.shiftId, [{ miniGameId: s.miniGameId, score: max }]);
}

const promotions = (u: string) =>
  vi.mocked(publishToUser).mock.calls.filter((c) => c[1] === u && c[2] === 'career_promoted');

beforeEach(() => vi.mocked(publishToUser).mockClear());
afterAll(async () => {
  await pool.end();
});

describe('ladder config', () => {
  it('has the five archetype ladders, 5-7 ranks from Intern to Legend', () => {
    expect(cfg.ladders.map((l) => l.id).sort()).toEqual([
      'builder',
      'caller',
      'farmer',
      'founder',
      'trader',
    ]);
    for (const l of cfg.ladders) {
      expect(l.ranks.length).toBeGreaterThanOrEqual(5);
      expect(l.ranks.length).toBeLessThanOrEqual(7);
      expect(l.ranks[0]!.id).toBe('intern');
      expect(l.ranks[0]!.xpRequired).toBe(0);
      expect(l.ranks[0]!.payBonusBps).toBe(0);
      expect(l.ranks.at(-1)!.id).toBe('legend');
      // Strictly rising XP and non-decreasing pay.
      for (let i = 1; i < l.ranks.length; i++) {
        expect(l.ranks[i]!.xpRequired).toBeGreaterThan(l.ranks[i - 1]!.xpRequired);
        expect(l.ranks[i]!.payBonusBps).toBeGreaterThanOrEqual(l.ranks[i - 1]!.payBonusBps);
      }
    }
  });

  it('maps onto existing jobs, tribes and venues, and cosmetics are all defined', () => {
    const careers = JSON.parse(readFileSync('contract/config/careers.json', 'utf8')) as {
      careers: Array<{ id: string; active: boolean }>;
      cosmetics: Array<{ cosmeticId: string }>;
    };
    const jobIds = new Set(careers.careers.map((c) => c.id));
    const active = new Set(careers.careers.filter((c) => c.active).map((c) => c.id));
    const tribes = new Set(
      (
        JSON.parse(readFileSync('contract/ids/tribes.json', 'utf8')) as {
          tribes: Array<{ id: string }>;
        }
      ).tribes.map((t) => t.id),
    );
    const venues = new Set(
      (
        JSON.parse(readFileSync('contract/ids/venues.json', 'utf8')) as {
          venues: Array<{ id: string }>;
        }
      ).venues.map((v) => v.id),
    );
    const cosmetics = new Set(careers.cosmetics.map((c) => c.cosmeticId));
    for (const l of cfg.ladders) {
      expect(l.jobIds.every((j) => jobIds.has(j))).toBe(true);
      expect(l.jobIds.some((j) => active.has(j))).toBe(true); // XP is earnable today
      expect(l.tribeIds.every((t) => tribes.has(t))).toBe(true);
      for (const r of l.ranks) {
        expect(r.venueAccess.every((a) => venues.has(a.split(':')[0]!))).toBe(true);
        if (r.cosmeticId) expect(cosmetics.has(r.cosmeticId)).toBe(true);
      }
    }
    expect(cosmetics.has('reward_rekt_burger_uniform')).toBe(true);
  });

  it('rank boundaries and integer bonus maths', () => {
    const r = cfg.ladders[0]!.ranks;
    expect(rankForXp(r, 0).rank).toBe(1);
    expect(rankForXp(r, r[1]!.xpRequired - 1).rank).toBe(1);
    expect(rankForXp(r, r[1]!.xpRequired).rank).toBe(2);
    expect(rankForXp(r, 10_000_000).rank).toBe(r.length);
    expect(payBonusCents(5000, 700)).toBe(350);
    expect(payBonusCents(333, 700)).toBe(23); // rounded down, never a fraction
  });
});

describe('joining and the cooldown', () => {
  it('shows the ladders, suggests one by tribe, and joins', async () => {
    const u = await newUser('builder');
    const before = await getLadders(ctx, u, NOW);
    expect(before.myLadderId).toBeNull();
    expect(before.suggestedLadderId).toBe('builder');
    expect(before.ladders).toHaveLength(5);
    expect(before.ladders.find((l) => l.id === 'builder')).toMatchObject({
      rank: 1,
      title: 'Builder Intern',
      xp: 0,
      xpToNext: 200,
      active: false,
    });
    const j = await joinLadder(ctx, u, 'builder', NOW);
    expect(j).toMatchObject({ ladderId: 'builder', alreadyMember: false, rank: 1 });
    const after = await getLadders(ctx, u, NOW);
    expect(after.myLadderId).toBe('builder');
    expect(after.ladders.find((l) => l.id === 'builder')!.ranks[0]!.status).toBe('current');
    expect(after.canSwitchAt).toBe(
      new Date(NOW.getTime() + cfg.ladderJoinCooldownHours * 3_600_000).toISOString(),
    );
  });

  it('refuses a switch inside the cooldown, allows it after, and keeps each ladder rank', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'builder', NOW);
    await setProgress(u, 'builder', 650, 3);
    const soon = new Date(NOW.getTime() + 3_600_000);
    await expect(joinLadder(ctx, u, 'trader', soon)).rejects.toBeInstanceOf(
      CareerSwitchCooldownError,
    );
    // Joining the ladder you are on is a no-op, not a switch.
    expect(await joinLadder(ctx, u, 'builder', soon)).toMatchObject({
      alreadyMember: true,
      rank: 3,
    });
    const later = new Date(NOW.getTime() + (cfg.ladderJoinCooldownHours + 1) * 3_600_000);
    expect(await joinLadder(ctx, u, 'trader', later)).toMatchObject({
      ladderId: 'trader',
      rank: 1,
      xp: 0,
    });
    // Back to builder later again: the rank was kept.
    const muchLater = new Date(later.getTime() + (cfg.ladderJoinCooldownHours + 1) * 3_600_000);
    expect(await joinLadder(ctx, u, 'builder', muchLater)).toMatchObject({ rank: 3, xp: 650 });
  });

  it('404s an unknown ladder', async () => {
    const u = await newUser();
    await expect(joinLadder(ctx, u, 'astronaut', NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('enrols a player on their first ladder-job shift without starting a cooldown', async () => {
    const u = await newUser('caller');
    expect((await getLadders(ctx, u)).myLadderId).toBeNull();
    const r = await perfectShift(u, 'kol_engagement');
    expect(r.ladder).toMatchObject({ ladderId: 'caller', rank: 1, xpAdded: 100 });
    const l = await getLadders(ctx, u);
    expect(l.myLadderId).toBe('caller');
    expect(l.canSwitchAt).toBeNull();
    // The first deliberate choice is free.
    expect((await joinLadder(ctx, u, 'founder')).ladderId).toBe('founder');
  });
});

describe('XP to promotion', () => {
  it('promotes at the threshold, grants the cosmetic, and tells the player', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'builder', NOW);
    await setProgress(u, 'builder', 100, 1); // rank 2 needs 200
    const first = await perfectShift(u, 'junior_analyst'); // +100 XP -> exactly 200
    expect(first.ladder).toMatchObject({ ladderId: 'builder', rank: 2, promoted: true });
    const ev = promotions(u);
    expect(ev).toHaveLength(1);
    expect(ev[0]![3]).toMatchObject({
      ladderId: 'builder',
      fromRank: 1,
      toRank: 2,
      title: 'Junior Dev',
      xp: 200,
    });
    // One XP short does not promote (99 + 100 = 199 < 200).
    const v = await newUser();
    await joinLadder(ctx, v, 'builder', NOW);
    await setProgress(v, 'builder', 99, 1);
    const second = await perfectShift(v, 'junior_analyst');
    expect(second.ladder).toMatchObject({ rank: 1, promoted: false });
    expect(promotions(v)).toHaveLength(0);
  });

  it('a rank with a cosmetic grants it once; later ranks keep the earlier ones', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'builder', NOW);
    await setProgress(u, 'builder', 550, 2); // rank 3 (cosmetic) needs 600
    const r = await perfectShift(u, 'junior_analyst');
    expect(r.ladder).toMatchObject({ rank: 3, promoted: true });
    const owned = await pool.query<{ item_key: string }>(
      `SELECT it.item_key FROM cosmetic_inventory ci JOIN cosmetic_items it ON it.item_id = ci.item_id
        WHERE ci.user_id = $1`,
      [u],
    );
    expect(owned.rows.map((x) => x.item_key)).toEqual(['reward_career_builder_mid']);
    expect(promotions(u)[0]![3]).toMatchObject({ cosmeticIds: ['reward_career_builder_mid'] });
  });

  it('a big XP jump crosses several ranks in one event', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'trader', NOW);
    await setProgress(u, 'trader', 1450, 3);
    await perfectShift(u, 'junior_analyst'); // 1550 -> rank 4 (1500)
    expect(promotions(u)).toHaveLength(1);
    await setProgress(u, 'trader', 11_950, 6);
    const r = await perfectShift(u, 'junior_analyst'); // 12050 -> legend
    expect(r.ladder).toMatchObject({ rank: 7, title: 'Trading Legend' });
  });

  it('does not give XP for a job outside the ladder, or when on no ladder', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'caller', NOW);
    const r = await perfectShift(u, 'discord_mod'); // not a caller job
    expect(r.ladder).toBeUndefined();
    const p = await pool.query(`SELECT xp FROM ladder_progress WHERE user_id = $1`, [u]);
    expect(p.rows[0]?.xp ?? 0).toBe(0);
  });
});

describe('perks applied to pay', () => {
  it('adds the rank bonus (whole cents) on the ladder jobs and not on others', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'builder', NOW);
    await setProgress(u, 'builder', 1500, 4); // senior: 1200 bps
    const onLadder = await perfectShift(u, 'junior_analyst'); // base 5000
    expect(onLadder.payCents).toBe(5000 + 600);
    expect(onLadder.ladder).toMatchObject({ bonusCents: 600 });
    const off = await perfectShift(u, 'discord_mod'); // base 4000, no bonus
    expect(off.payCents).toBe(4000);
    const ledger = await pool.query<{ delta_cents: string }>(
      `SELECT delta_cents FROM ledger_entries WHERE user_id = $1 AND reason = 'shift_pay' ORDER BY id`,
      [u],
    );
    expect(ledger.rows.map((x) => Number(x.delta_cents))).toEqual([5600, 4000]);
  });

  it('exposes cumulative venue-area flags, and the venue access lookup', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'trader', NOW);
    await setProgress(u, 'trader', 100, 1);
    expect(await careerAreasAt(ctx, u, 'perp_pit')).toEqual([]);
    await setProgress(u, 'trader', 1500, 4);
    expect(await careerAreasAt(ctx, u, 'perp_pit')).toEqual(['high_roller_floor']);
    expect(await careerAreasAt(ctx, u, 'prediction_pit')).toEqual([]);
    await setProgress(u, 'trader', 7000, 6);
    expect(await careerAreasAt(ctx, u, 'prediction_pit')).toEqual(['vip_booth']);
    expect((await getLadders(ctx, u)).venueAccess).toEqual(
      venueAreasUpTo(
        cfg.ladders.find((l) => l.id === 'trader')!,
        6,
      ),
    );
  });
});

describe('related-action XP', () => {
  it('counts an action once per ref, only for the ladder it belongs to', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'trader', NOW);
    await recordCareerAction(ctx, u, 'perp_open', 'p1', NOW);
    await recordCareerAction(ctx, u, 'perp_open', 'p1', NOW); // replay
    await recordCareerAction(ctx, u, 'alpha_call', 'c1', NOW); // a caller action
    const t = (await getLadders(ctx, u, NOW)).ladders.find((l) => l.id === 'trader')!;
    expect(t.xp).toBe(4);
  });

  it('is fed by the quest hooks, and a player on no ladder is ignored', async () => {
    const u = await newUser();
    await recordQuestEvent(ctx, u, 'perp_close', 'x1', NOW);
    expect(
      (await pool.query(`SELECT 1 FROM ladder_xp_events WHERE user_id = $1`, [u])).rowCount,
    ).toBe(0);
    await joinLadder(ctx, u, 'trader', NOW);
    await recordQuestEvent(ctx, u, 'perp_close', 'x1', NOW);
    expect((await getLadders(ctx, u, NOW)).ladders.find((l) => l.id === 'trader')!.xp).toBe(8);
  });

  it('stops at the daily cap and resumes the next UTC day', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'trader', NOW);
    for (let i = 0; i < 40; i++) await recordCareerAction(ctx, u, 'perp_close', `r${i}`, NOW);
    const xp = (await getLadders(ctx, u, NOW)).ladders.find((l) => l.id === 'trader')!.xp;
    expect(xp).toBe(cfg.ladderActionXpDailyCap);
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    await recordCareerAction(ctx, u, 'perp_close', 'next-day', tomorrow);
    expect((await getLadders(ctx, u, NOW)).ladders.find((l) => l.id === 'trader')!.xp).toBe(
      cfg.ladderActionXpDailyCap + 8,
    );
  });

  it('can promote on an action and tells the player', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'caller', NOW);
    await setProgress(u, 'caller', 190, 1);
    await recordCareerAction(ctx, u, 'alpha_call', 'big-call', NOW); // +15 -> 205
    expect(promotions(u)).toHaveLength(1);
    expect(promotions(u)[0]![3]).toMatchObject({
      ladderId: 'caller',
      toRank: 2,
      title: 'Reply Guy',
    });
  });
});

describe('social actions cannot be looped', () => {
  const ladderXp = async (u: string) =>
    (await getLadders(ctx, u, NOW)).ladders.find((l) => l.id === 'caller')!.xp;

  it('a valid paid call earns ladder XP; the same pair again inside the window earns none', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'caller', NOW);
    const rule = { key: 'pair:friend', cooldownDays: 7 };
    await recordQuestEvent(ctx, u, 'paid_call', 't1', NOW, rule);
    expect(await ladderXp(u)).toBe(12);
    // Alt-account ping-pong: new call id, same counterpart, still in the window.
    await recordQuestEvent(ctx, u, 'paid_call', 't2', new Date(NOW.getTime() + 3_600_000), rule);
    await recordQuestEvent(ctx, u, 'paid_call', 't3', new Date(NOW.getTime() + 86_400_000), rule);
    expect(await ladderXp(u)).toBe(12);
    // A different counterpart is a valid event.
    await recordQuestEvent(ctx, u, 'paid_call', 't4', NOW, { key: 'pair:other', cooldownDays: 7 });
    expect(await ladderXp(u)).toBe(24);
    // After the window the first counterpart counts again.
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    await recordQuestEvent(ctx, u, 'paid_call', 't5', later, rule);
    expect(await ladderXp(u)).toBe(36);
  });

  it('a replayed event ref earns none, with or without a counterpart rule', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'caller', NOW);
    const rule = { key: 'pair:x', cooldownDays: 7 };
    await recordQuestEvent(ctx, u, 'paid_call', 'call-1', NOW, rule);
    await recordQuestEvent(ctx, u, 'paid_call', 'call-1', NOW, rule);
    expect(await ladderXp(u)).toBe(12);
    await recordQuestEvent(ctx, u, 'alpha_call', 'a-1', NOW);
    await recordQuestEvent(ctx, u, 'alpha_call', 'a-1', NOW);
    expect(await ladderXp(u)).toBe(27);
  });

  it('shift_complete through the quest hook never earns ladder XP (shifts have their own path)', async () => {
    const u = await newUser();
    await joinLadder(ctx, u, 'builder', NOW);
    await recordQuestEvent(ctx, u, 'shift_complete', 'shift:x', NOW);
    const r = await pool.query(`SELECT 1 FROM ladder_xp_events WHERE user_id = $1`, [u]);
    expect(r.rowCount).toBe(0);
    // A real shift pays its XP exactly once.
    const s = await perfectShift(u, 'junior_analyst');
    expect(s.ladder!.xpAdded).toBe(100);
    const rows = await pool.query(`SELECT 1 FROM ladder_xp_events WHERE user_id = $1`, [u]);
    expect(rows.rowCount).toBe(1);
  });
});
