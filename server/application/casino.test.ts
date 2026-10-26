/**
 * The Rug Room service against Postgres: the age gate, stake and loss caps,
 * self-exclusion, ledger rows, crash cashout before and after the crash on a
 * controlled clock, double cashout, the head-to-head flow (accept, expire
 * with a refund, the house cut), no IDOR, and the rich-list weighting.
 *
 * The caps are lowered through env before the context loads so the tests do
 * not have to grind through 50,000 cents of play.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: process.cwd() + '/.env' });
process.env.CASINO_DAILY_STAKE_CAP_CENTS = '3000';
process.env.CASINO_DAILY_LOSS_CAP_CENTS = '2500';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  AgeRequiredError,
  BlockedError,
  ChallengeExpiredError,
  ChallengeNotOpenError,
  ForbiddenError,
  InsufficientCashError,
  LossCapReachedError,
  NotFoundError,
  RoundInProgressError,
  RoundSettledError,
  SelfExcludedError,
  StakeCapReachedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import {
  acceptChallenge,
  cashoutCrash,
  closeChallenge,
  createChallenge,
  getCasinoState,
  getMyRound,
  listChallenges,
  listMyRounds,
  placeCrashBet,
  playCoinflip,
  playSlots,
  selfExclude,
  sweepCasino,
} from './casino.js';
import {
  crashMultiplierX100At,
  crashPointX100,
  crashTimeMs,
  drawStream,
  hashSeed,
  payoutFor,
  readCasinoConfigFile,
} from './casino-math.js';
import { BoardsService } from './boards.js';

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const cfg = readCasinoConfigFile();
const T0 = new Date('2026-10-24T12:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

afterAll(async () => {
  await pool.end();
});

beforeAll(() => {
  expect(ctx.config.casino).toEqual({ dailyStakeCapCents: 3000, dailyNetLossCapCents: 2500 });
});

async function newUser(opts: { cash?: number; adult?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `casino-${id}`]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id, age_confirmed_at)
     VALUES ($1, $2, $3, '{}'::jsonb, 'degen', ARRAY[]::text[], 'be_rich', 'studio', $4)`,
    [uuidv7(), id, `rr-${id.slice(-12)}`, opts.adult === false ? null : T0],
  );
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2`,
    [id, opts.cash ?? 100_000],
  );
  return id;
}

async function cash(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]!.cash_cents);
}

async function ledger(userId: string): Promise<Array<{ reason: string; delta: number }>> {
  const r = await pool.query<{ reason: string; delta_cents: string }>(
    `SELECT reason, delta_cents FROM ledger_entries
      WHERE user_id = $1 AND reason LIKE 'casino_%' ORDER BY id`,
    [userId],
  );
  return r.rows.map((x) => ({ reason: x.reason, delta: Number(x.delta_cents) }));
}

/** Put casino ledger history on a player without playing (caps and rich list). */
async function seedLedger(userId: string, reason: string, delta: number, when = T0): Promise<void> {
  await pool.query(
    `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref, created_at)
     VALUES ($1, $2, 'cash', $3, 'test', $4, $5, $6)`,
    [userId, delta, reason, uuidv7(), uuidv7(), when],
  );
}

/** Reconciliation: the ledger must always add up to the balance we set up. */
async function ledgerSum(userId: string): Promise<number> {
  const r = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(delta_cents), 0) AS s FROM ledger_entries WHERE user_id = $1 AND account = 'cash'`,
    [userId],
  );
  return Number(r.rows[0]!.s);
}

async function crashPointOf(roundId: string): Promise<number> {
  const r = await pool.query<{ seed: string }>(
    `SELECT seed FROM casino_rounds WHERE round_id = $1`,
    [roundId],
  );
  return crashPointX100(drawStream(r.rows[0]!.seed, `crash:${roundId}`)(), cfg);
}

/**
 * Open manual crash rounds on fresh players until one has a crash point of
 * at least `minX100` (the crash point is the server's secret; the test reads
 * it from the database).
 */
async function openCrashWith(
  minX100: number,
  now: Date,
): Promise<{ userId: string; roundId: string; crash: number; stake: number }> {
  for (let i = 0; i < 80; i++) {
    const userId = await newUser();
    const res = await placeCrashBet(ctx, userId, 1_000, null, now);
    const crash = await crashPointOf(res.round.roundId);
    if (crash >= minX100) return { userId, roundId: res.round.roundId, crash, stake: 1_000 };
  }
  throw new Error('no suitable crash point in 80 tries');
}

describe('gates', () => {
  it('refuses a player without a confirmed 18+ flag, and takes nothing', async () => {
    const u = await newUser({ adult: false });
    await expect(playSlots(ctx, u, 500, T0)).rejects.toBeInstanceOf(AgeRequiredError);
    await expect(playCoinflip(ctx, u, 500, 'heads', T0)).rejects.toBeInstanceOf(AgeRequiredError);
    await expect(placeCrashBet(ctx, u, 500, 2, T0)).rejects.toBeInstanceOf(AgeRequiredError);
    expect(await cash(u)).toBe(100_000);
    expect(await ledger(u)).toEqual([]);
    const state = await getCasinoState(ctx, u, T0);
    expect(state.ageConfirmed).toBe(false);
    expect(state.disclaimer).toBe('Play money. No cash value. 18+');
  });

  it('refuses a player with no character at all', async () => {
    const id = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `casino-nochar-${id}`]);
    await expect(playSlots(ctx, id, 500, T0)).rejects.toBeInstanceOf(AgeRequiredError);
  });

  it('checks the stake range and integer cents', async () => {
    const u = await newUser();
    for (const bad of [0, 99, -500, 10_001, 150.5, Number.NaN]) {
      await expect(playSlots(ctx, u, bad, T0)).rejects.toBeInstanceOf(ValidationFailedError);
    }
    expect(await cash(u)).toBe(100_000);
  });

  it('refuses a stake the player cannot cover', async () => {
    const u = await newUser({ cash: 400 });
    await expect(playSlots(ctx, u, 500, T0)).rejects.toBeInstanceOf(InsufficientCashError);
    expect(await cash(u)).toBe(400);
    expect(await ledger(u)).toEqual([]);
  });

  it('enforces the daily stake cap, counting the UTC day only and ignoring refunded stakes', async () => {
    const u = await newUser();
    await seedLedger(u, 'casino_stake', -2_500);
    await seedLedger(u, 'casino_win', 2_000); // net loss 500, so only the stake cap can bind
    await expect(playSlots(ctx, u, 600, at(1000))).rejects.toBeInstanceOf(StakeCapReachedError);
    // exactly up to the cap is fine
    await expect(playSlots(ctx, u, 500, at(1000))).resolves.toBeDefined();
    await expect(playSlots(ctx, u, 100, at(2000))).rejects.toBeInstanceOf(StakeCapReachedError);
    // the next UTC day starts fresh
    await expect(playSlots(ctx, u, 500, at(24 * 3600_000))).resolves.toBeDefined();
    // a refunded stake does not count
    const v = await newUser();
    await seedLedger(v, 'casino_stake', -2_500);
    await seedLedger(v, 'casino_refund', 2_500);
    await expect(playSlots(ctx, v, 1_000, at(1000))).resolves.toBeDefined();
  });

  it('concurrent spins never pass the stake cap (the player lock serializes them at READ COMMITTED)', async () => {
    const u = await newUser();
    await seedLedger(u, 'casino_stake', -2_000);
    await seedLedger(u, 'casino_win', 2_000); // room left under the 3,000 stake cap: 1,000
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => playSlots(ctx, u, 500, at(1000))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(StakeCapReachedError);
    }
    const staked = (await ledger(u))
      .filter((r) => r.reason === 'casino_stake')
      .reduce((n, r) => n - r.delta, 0);
    expect(staked).toBe(3_000);
  });

  it('enforces the daily net-loss cap', async () => {
    const u = await newUser();
    // 2,000 lost so far: a 600 stake could take the net loss past 2,500, the stake cap is not hit
    await seedLedger(u, 'casino_stake', -2_000);
    await expect(playSlots(ctx, u, 600, at(1000))).rejects.toBeInstanceOf(LossCapReachedError);
    // winnings earlier today widen the room
    await seedLedger(u, 'casino_win', 1_000);
    // staked 2,000 + 600 = 2,600 <= 3,000 stake cap; net loss 1,000 + 600 <= 2,500
    await expect(playSlots(ctx, u, 600, at(1000))).resolves.toBeDefined();
  });

  it('exposes the cap room in the state', async () => {
    const u = await newUser();
    await seedLedger(u, 'casino_stake', -1_200);
    const s = await getCasinoState(ctx, u, at(1000));
    expect(s.limits.dailyStakeCapCents).toBe(3000);
    expect(s.limits.dailyNetLossCapCents).toBe(2500);
    expect(s.today).toMatchObject({
      stakedCents: 1_200,
      netLossCents: 1_200,
      stakeRemainingCents: 1_800,
      lossRemainingCents: 1_300,
    });
    expect(s.games.slots.rtp).toBeGreaterThan(0.94);
  });
});

describe('self-exclusion', () => {
  it('refuses every new stake until the date, then lets the player back in', async () => {
    const u = await newUser();
    const r = await selfExclude(ctx, u, 3, T0);
    expect(r.selfExcludedUntil).toBe(at(3 * 86_400_000).toISOString());
    expect(r.disclaimer).toBe('Play money. No cash value. 18+');
    const calls = [
      () => playSlots(ctx, u, 500, at(1000)),
      () => playCoinflip(ctx, u, 500, 'tails', at(1000)),
      () => placeCrashBet(ctx, u, 500, null, at(1000)),
      () => createChallenge(ctx, u, uuidv7(), 'heads', at(1000)),
    ];
    for (const c of calls) await expect(c()).rejects.toBeInstanceOf(SelfExcludedError);
    expect(await cash(u)).toBe(100_000);
    expect((await getCasinoState(ctx, u, at(1000))).selfExcludedUntil).toBe(r.selfExcludedUntil);
    // after the date
    await expect(playSlots(ctx, u, 500, at(3 * 86_400_000 + 1))).resolves.toBeDefined();
    expect((await getCasinoState(ctx, u, at(3 * 86_400_000 + 1))).selfExcludedUntil).toBeNull();
  });

  it('can be extended but never shortened', async () => {
    const u = await newUser();
    await selfExclude(ctx, u, 30, T0);
    const shorter = await selfExclude(ctx, u, 2, at(1000));
    expect(shorter.selfExcludedUntil).toBe(at(30 * 86_400_000).toISOString());
    const longer = await selfExclude(ctx, u, 60, at(1000));
    expect(longer.selfExcludedUntil).toBe(at(1000 + 60 * 86_400_000).toISOString());
  });

  it('validates the number of days', async () => {
    const u = await newUser();
    for (const d of [0, -1, 1.5, 366]) {
      await expect(selfExclude(ctx, u, d, T0)).rejects.toBeInstanceOf(ValidationFailedError);
    }
  });

  it('an excluded player can still cash out a crash round they already hold', async () => {
    const { userId, roundId } = await openCrashWith(300, T0);
    await selfExclude(ctx, userId, 1, at(500));
    const out = await cashoutCrash(ctx, userId, roundId, at(1_000));
    expect(out.round.status).toBe('settled');
  });
});

describe('slots and coinflip: ledger, rounds and commit-reveal', () => {
  it('writes casino_stake and (on a win) casino_win in one go and reconciles to the balance', async () => {
    const u = await newUser({ cash: 100_000 });
    await seedLedger(u, 'topup', 100_000); // so the ledger sum matches the starting balance
    let wins = 0;
    for (let i = 0; i < 12; i++) {
      const res = await playSlots(ctx, u, 100, at(i * 1000));
      expect(res.round.status).toBe('settled');
      expect(res.round.game).toBe('slots');
      expect(res.round.stakeCents).toBe(100);
      expect(res.round.payoutCents).toBe(
        payoutFor(100, Math.round((res.round.outcome!.multiplier as number) * 100)),
      );
      expect(res.disclaimer).toBe('Play money. No cash value. 18+');
      // commit-reveal: the hash published with the round is the hash of the revealed seed
      expect(res.round.seed).toMatch(/^[0-9a-f]{64}$/);
      expect(hashSeed(res.round.seed!)).toBe(res.round.seedHash);
      if ((res.round.payoutCents ?? 0) > 0) wins++;
    }
    const rows = await ledger(u);
    expect(rows.filter((r) => r.reason === 'casino_stake')).toHaveLength(12);
    expect(rows.filter((r) => r.reason === 'casino_win')).toHaveLength(wins);
    expect(await cash(u)).toBe(await ledgerSum(u));
    const rounds = await pool.query(`SELECT 1 FROM casino_rounds WHERE user_id = $1`, [u]);
    expect(rounds.rowCount).toBe(12);
  });

  it('the revealed seed reproduces the outcome', async () => {
    const u = await newUser();
    const res = await playCoinflip(ctx, u, 200, 'heads', T0);
    const next = drawStream(res.round.seed!, `coinflip:${res.round.roundId}`);
    const result = next() < 0.5 ? 'heads' : 'tails';
    expect(res.round.outcome).toMatchObject({ side: 'heads', result, won: result === 'heads' });
    expect(res.round.payoutCents).toBe(result === 'heads' ? 380 : 0);
  });

  it('a coinflip win pays 1.9x and a loss pays nothing', async () => {
    const u = await newUser();
    let sawWin = false;
    let sawLoss = false;
    for (let i = 0; i < 30 && !(sawWin && sawLoss); i++) {
      const res = await playCoinflip(ctx, u, 100, 'heads', at(i));
      const won = res.round.outcome!.won as boolean;
      expect(res.round.payoutCents).toBe(won ? 190 : 0);
      sawWin ||= won;
      sawLoss ||= !won;
      if (i === 25) break;
    }
    expect(sawWin).toBe(true);
    expect(sawLoss).toBe(true);
  });

  it('reports continuous play: the reminder flag appears after 30 minutes', async () => {
    const u = await newUser();
    let last = await playSlots(ctx, u, 100, T0);
    expect(last.sessionMinutes).toBe(0);
    expect(last.sessionReminder).toBe(false);
    // a spin every 5 minutes for 35 minutes: each gap is under the 10 minute break
    for (let m = 5; m <= 35; m += 5) last = await playSlots(ctx, u, 100, at(m * 60_000));
    expect(last.sessionMinutes).toBe(35);
    expect(last.sessionReminder).toBe(true);
    // a 15 minute break ends the session
    const after = await playSlots(ctx, u, 100, at(50 * 60_000));
    expect(after.sessionMinutes).toBe(0);
    expect(after.sessionReminder).toBe(false);
  });
});

describe('crash', () => {
  it('an auto-cashout settles at once and the stake and win land in the ledger', async () => {
    const u = await newUser();
    await seedLedger(u, 'topup', 100_000);
    let won = 0;
    let lost = 0;
    for (let i = 0; i < 20; i++) {
      const res = await placeCrashBet(ctx, u, 100, 1.5, at(i * 1000));
      expect(res.round.status).toBe('settled');
      expect(hashSeed(res.round.seed!)).toBe(res.round.seedHash);
      const crash = (res.round.outcome!.crashPoint as number) * 100;
      const cashed = res.round.outcome!.cashedOutAt;
      if (crash >= 150) {
        expect(cashed).toBe(1.5);
        expect(res.round.payoutCents).toBe(150);
        won++;
      } else {
        expect(cashed).toBeNull();
        expect(res.round.payoutCents).toBe(0);
        lost++;
      }
    }
    expect(won + lost).toBe(20);
    const rows = await ledger(u);
    expect(rows.filter((r) => r.reason === 'casino_stake')).toHaveLength(20);
    expect(rows.filter((r) => r.reason === 'casino_win')).toHaveLength(won);
    expect(await cash(u)).toBe(await ledgerSum(u));
  });

  it('rejects a bad auto-cashout', async () => {
    const u = await newUser();
    for (const a of [1, 1.0, 0.5, 1.005, 101, Number.NaN]) {
      await expect(placeCrashBet(ctx, u, 100, a, T0)).rejects.toBeInstanceOf(ValidationFailedError);
    }
  });

  it('an open round hides its seed and the crash point', async () => {
    // Not an instant bust (about 6% of rounds): listing settles a round whose crash time has
    // passed, which would reveal its seed legitimately.
    const open = await openCrashWith(200, T0);
    const u = open.userId;
    const res = await getMyRound(ctx, u, open.roundId, T0);
    expect(res.round.status).toBe('open');
    expect(res.round.seed).toBeNull();
    expect(res.round.outcome).toBeNull();
    expect(res.round.payoutCents).toBeNull();
    expect(res.round.params).toMatchObject({ startedAtMs: T0.getTime(), growthPerSecond: 0.07 });
    expect(JSON.stringify(res)).not.toContain('crashPoint');
    // listing it does not leak the seed either
    const list = await listMyRounds(ctx, u, { limit: 10, before: null }, at(1));
    expect(list.rounds[0]!.seed).toBeNull();
    const stored = await pool.query<{ seed: string }>(
      `SELECT seed FROM casino_rounds WHERE round_id = $1`,
      [res.round.roundId],
    );
    expect(JSON.stringify(list)).not.toContain(stored.rows[0]!.seed);
    expect(JSON.stringify(res)).not.toContain(stored.rows[0]!.seed);
    // only the stake has moved
    expect(await ledger(u)).toEqual([{ reason: 'casino_stake', delta: -open.stake }]);
  });

  it('a cashout BEFORE the crash pays the server multiplier at that instant', async () => {
    const { userId, roundId, crash, stake } = await openCrashWith(300, T0);
    const tCrash = crashTimeMs(crash, cfg);
    const t = Math.floor(tCrash / 2);
    const out = await cashoutCrash(ctx, userId, roundId, at(t));
    const x = crashMultiplierX100At(t, cfg);
    expect(out.round.status).toBe('settled');
    expect(out.round.outcome).toMatchObject({ crashed: false, cashedOutAt: x / 100 });
    expect(out.round.payoutCents).toBe(payoutFor(stake, x));
    expect(out.round.seed).not.toBeNull();
    expect(hashSeed(out.round.seed!)).toBe(out.round.seedHash);
    const rows = await ledger(userId);
    expect(rows).toEqual([
      { reason: 'casino_stake', delta: -stake },
      { reason: 'casino_win', delta: payoutFor(stake, x) },
    ]);
  });

  it('a cashout AFTER the crash pays nothing, whatever the client thought', async () => {
    const { userId, roundId, crash } = await openCrashWith(150, T0);
    const tCrash = crashTimeMs(crash, cfg);
    const out = await cashoutCrash(ctx, userId, roundId, at(tCrash + 1));
    expect(out.round.payoutCents).toBe(0);
    expect(out.round.outcome).toMatchObject({ crashed: true, cashedOutAt: null });
    expect(out.round.outcome!.crashPoint).toBe(crash / 100);
    expect(await ledger(userId)).toEqual([{ reason: 'casino_stake', delta: -1000 }]);
  });

  it('a cashout one millisecond before the crash still pays; at the crash it does not', async () => {
    const a = await openCrashWith(200, T0);
    const tA = crashTimeMs(a.crash, cfg);
    const okOut = await cashoutCrash(ctx, a.userId, a.roundId, at(tA - 1));
    expect(okOut.round.payoutCents).toBeGreaterThan(0);
    const b = await openCrashWith(200, T0);
    const tB = crashTimeMs(b.crash, cfg);
    const lateOut = await cashoutCrash(ctx, b.userId, b.roundId, at(tB));
    expect(lateOut.round.payoutCents).toBe(0);
  });

  it('a second cashout is refused (ROUND_SETTLED) and pays nothing more', async () => {
    const { userId, roundId, stake } = await openCrashWith(300, T0);
    const first = await cashoutCrash(ctx, userId, roundId, at(2_000));
    expect(first.round.payoutCents).toBeGreaterThan(0);
    const cashAfter = await cash(userId);
    await expect(cashoutCrash(ctx, userId, roundId, at(2_001))).rejects.toBeInstanceOf(
      RoundSettledError,
    );
    await expect(cashoutCrash(ctx, userId, roundId, at(9_000))).rejects.toBeInstanceOf(
      RoundSettledError,
    );
    expect(await cash(userId)).toBe(cashAfter);
    expect((await ledger(userId)).filter((r) => r.reason === 'casino_win')).toHaveLength(1);
    expect(stake).toBe(1000);
  });

  it('two cashouts racing: exactly one settles', async () => {
    const { userId, roundId } = await openCrashWith(300, T0);
    const results = await Promise.allSettled([
      cashoutCrash(ctx, userId, roundId, at(1_500)),
      cashoutCrash(ctx, userId, roundId, at(1_500)),
      cashoutCrash(ctx, userId, roundId, at(1_500)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await ledger(userId)).filter((r) => r.reason === 'casino_win')).toHaveLength(1);
  });

  it("nobody else can cash out, or even see, a player's round (404)", async () => {
    const { userId, roundId } = await openCrashWith(300, T0);
    const thief = await newUser();
    await expect(cashoutCrash(ctx, thief, roundId, at(1_000))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getMyRound(ctx, thief, roundId, at(1_000))).rejects.toBeInstanceOf(NotFoundError);
    expect((await listMyRounds(ctx, thief, { limit: 50, before: null }, at(1_000))).rounds).toEqual(
      [],
    );
    // the owner is unaffected
    await expect(cashoutCrash(ctx, userId, roundId, at(1_000))).resolves.toBeDefined();
  });

  it('one round at a time; a round that already crashed is closed as a loss by the next bet', async () => {
    const { userId, crash } = await openCrashWith(150, T0);
    await expect(placeCrashBet(ctx, userId, 500, null, at(10))).rejects.toBeInstanceOf(
      RoundInProgressError,
    );
    const later = at(crashTimeMs(crash, cfg) + 5_000);
    const next = await placeCrashBet(ctx, userId, 500, 1.5, later);
    expect(next.round.status).toBe('settled');
    const old = await pool.query(
      `SELECT status, payout_cents FROM casino_rounds WHERE user_id = $1 AND status = 'settled' AND stake_cents = 1000`,
      [userId],
    );
    expect(old.rows).toEqual([{ status: 'settled', payout_cents: '0' }]);
  });

  it('reading a round past its crash point settles it as a crash, exactly once', async () => {
    const { userId, roundId, crash, stake } = await openCrashWith(150, T0);
    const tCrash = crashTimeMs(crash, cfg);
    const before = await getMyRound(ctx, userId, roundId, at(Math.max(0, tCrash - 1)));
    expect(before.round.status).toBe('open');
    expect(before.round.seed).toBeNull();
    const [r1, r2] = await Promise.all([
      getMyRound(ctx, userId, roundId, at(tCrash + 1)),
      listMyRounds(ctx, userId, { limit: 10, before: null }, at(tCrash + 1)),
    ]);
    expect(r1.round.status).toBe('settled');
    expect(r1.round.payoutCents).toBe(0);
    expect(r1.round.outcome).toMatchObject({ crashed: true, cashedOutAt: null });
    expect(r1.round.outcome!.crashPoint).toBe(crash / 100);
    expect(r1.round.seed).not.toBeNull();
    expect(r2.rounds.find((x) => x.roundId === roundId)!.status).toBe('settled');
    // a late cashout cannot pay, and nothing is double-settled
    const again = await getMyRound(ctx, userId, roundId, at(tCrash + 5_000));
    expect(again.round.settledAt).toBe(r1.round.settledAt);
    await expect(cashoutCrash(ctx, userId, roundId, at(tCrash + 6_000))).rejects.toBeInstanceOf(
      RoundSettledError,
    );
    expect(await ledger(userId)).toEqual([{ reason: 'casino_stake', delta: -stake }]);
  });

  it('the sweep closes abandoned crash rounds and reveals their seed', async () => {
    const { userId, roundId } = await openCrashWith(150, T0);
    const out = await sweepCasino(ctx, at(10 * 60_000), userId);
    expect(out.crashRounds).toBe(1);
    const r = await getMyRound(ctx, userId, roundId, at(10 * 60_000));
    expect(r.round.status).toBe('settled');
    expect(r.round.payoutCents).toBe(0);
    expect(r.round.seed).not.toBeNull();
  });
});

describe('head-to-head coinflip: bragging rights, no Cash moves', () => {
  const snapshot = async (...ids: string[]) =>
    Promise.all(ids.map(async (i) => [await cash(i), (await ledger(i)).length] as const));

  it('creates and settles a challenge without moving any Cash or writing a ledger or round row', async () => {
    const a = await newUser({ cash: 10_000 });
    const b = await newUser({ cash: 10_000 });
    const before = await snapshot(a, b);
    const created = await createChallenge(ctx, a, b, 'heads', T0);
    expect(created.challenge).toMatchObject({ role: 'challenger', status: 'open', seed: null });
    expect(created.challenge).not.toHaveProperty('stakeCents');
    expect(created.challenge.expiresAt).toBe(at(120_000).toISOString());
    expect(created.disclaimer).toBe('Play money. No cash value. 18+');
    expect(await snapshot(a, b)).toEqual(before);

    const id = created.challenge.challengeId;
    const accepted = await acceptChallenge(ctx, b, id, at(30_000));
    const c = accepted.challenge;
    expect(c.status).toBe('settled');
    expect(hashSeed(c.seed!)).toBe(c.seedHash);
    const result = drawStream(c.seed!, `coinflip_h2h:${id}`)() < 0.5 ? 'heads' : 'tails';
    expect(c.result).toBe(result);
    expect(c.winnerId).toBe(result === 'heads' ? a : b);
    for (const k of ['stakeCents', 'potCents', 'houseCutCents', 'payoutCents']) {
      expect(c).not.toHaveProperty(k);
    }
    expect(accepted).not.toHaveProperty('round');
    expect(await snapshot(a, b)).toEqual(before);
    const rows = await pool.query(`SELECT 1 FROM casino_rounds WHERE challenge_id = $1`, [id]);
    expect(rows.rowCount).toBe(0);
    const stored = await pool.query(
      `SELECT stake_cents, pot_cents, payout_cents FROM casino_challenges WHERE challenge_id = $1`,
      [id],
    );
    expect(stored.rows[0]).toEqual({ stake_cents: '0', pot_cents: null, payout_cents: null });
  });

  it('works for a player with no Cash at all (nothing is staked)', async () => {
    const a = await newUser({ cash: 0 });
    const b = await newUser({ cash: 0 });
    const { challenge } = await createChallenge(ctx, a, b, 'tails', T0);
    expect((await acceptChallenge(ctx, b, challenge.challengeId, at(1000))).challenge.status).toBe(
      'settled',
    );
  });

  it('expires after 2 minutes: accept is refused CHALLENGE_EXPIRED, with no Cash involved', async () => {
    const a = await newUser({ cash: 5_000 });
    const b = await newUser({ cash: 5_000 });
    const before = await snapshot(a, b);
    const { challenge } = await createChallenge(ctx, a, b, 'tails', T0);
    await expect(
      acceptChallenge(ctx, b, challenge.challengeId, at(120_001)),
    ).rejects.toBeInstanceOf(ChallengeExpiredError);
    expect(await snapshot(a, b)).toEqual(before);
    await expect(
      acceptChallenge(ctx, b, challenge.challengeId, at(121_000)),
    ).rejects.toBeInstanceOf(ChallengeExpiredError);
  });

  it('the sweep and a listing expire an unanswered challenge once', async () => {
    const a = await newUser();
    const b = await newUser();
    const { challenge } = await createChallenge(ctx, a, b, 'heads', T0);
    expect((await sweepCasino(ctx, at(60_000), a)).challenges).toBe(0);
    expect((await sweepCasino(ctx, at(121_000), a)).challenges).toBe(1);
    expect((await sweepCasino(ctx, at(122_000), a)).challenges).toBe(0);
    const list = await listChallenges(ctx, a, at(130_000));
    expect(list.challenges[0]).toMatchObject({
      challengeId: challenge.challengeId,
      status: 'expired',
    });
    const c = await createChallenge(ctx, a, b, 'heads', at(200_000));
    expect((await listChallenges(ctx, a, at(400_000))).challenges[0]!.status).toBe('expired');
    expect(c.challenge.status).toBe('open');
  });

  it('cancel and decline close it; only the right side may use each', async () => {
    const a = await newUser();
    const b = await newUser();
    const c1 = (await createChallenge(ctx, a, b, 'heads', T0)).challenge;
    await expect(closeChallenge(ctx, b, c1.challengeId, 'cancel', at(1))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(closeChallenge(ctx, a, c1.challengeId, 'decline', at(1))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await closeChallenge(ctx, a, c1.challengeId, 'cancel', at(2))).challenge.status).toBe(
      'cancelled',
    );
    await expect(closeChallenge(ctx, a, c1.challengeId, 'cancel', at(3))).rejects.toBeInstanceOf(
      ChallengeNotOpenError,
    );
    await expect(acceptChallenge(ctx, b, c1.challengeId, at(4))).rejects.toBeInstanceOf(
      ChallengeNotOpenError,
    );
    const c2 = (await createChallenge(ctx, a, b, 'heads', T0)).challenge;
    expect((await closeChallenge(ctx, b, c2.challengeId, 'decline', at(2))).challenge.status).toBe(
      'declined',
    );
  });

  it('a stranger gets 404, the challenger cannot accept their own challenge, and it settles once', async () => {
    const a = await newUser();
    const b = await newUser();
    const stranger = await newUser();
    const id = (await createChallenge(ctx, a, b, 'heads', T0)).challenge.challengeId;
    await expect(acceptChallenge(ctx, stranger, id, at(1))).rejects.toBeInstanceOf(NotFoundError);
    await expect(closeChallenge(ctx, stranger, id, 'cancel', at(1))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(acceptChallenge(ctx, a, id, at(1))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listChallenges(ctx, stranger, at(1))).challenges).toEqual([]);
    const results = await Promise.allSettled([
      acceptChallenge(ctx, b, id, at(2)),
      acceptChallenge(ctx, b, id, at(2)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  describe('a legacy staked challenge (made before Cash became non-transferable)', () => {
    /** An open challenge whose creator's stake was already debited, as the old code left it. */
    async function legacy(stake: number, expiresInMs = 120_000) {
      const a = await newUser({ cash: 10_000 });
      const b = await newUser({ cash: 10_000 });
      const id = uuidv7();
      await pool.query(`UPDATE balances SET cash_cents = cash_cents - $2 WHERE user_id = $1`, [
        a,
        stake,
      ]);
      await pool.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref, created_at)
         VALUES ($1, $2, 'cash', 'casino_stake', 'casino_challenge', $3, $4, $5)`,
        [a, -stake, id, `casino-stake:${a}:${id}`, T0],
      );
      await pool.query(
        `INSERT INTO casino_challenges (challenge_id, challenger_id, opponent_id, stake_cents,
           challenger_side, seed, seed_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'heads', 's', 'h', $5, $6)`,
        [id, a, b, stake, T0, at(expiresInMs)],
      );
      return { a, b, id };
    }

    it('accepting it is refused and refunds the creator exactly once; no second refund', async () => {
      const { a, b, id } = await legacy(1_000);
      expect(await cash(a)).toBe(9_000);
      await expect(acceptChallenge(ctx, b, id, at(1_000))).rejects.toBeInstanceOf(
        ChallengeNotOpenError,
      );
      expect(await cash(a)).toBe(10_000);
      expect(await ledger(a)).toEqual([
        { reason: 'casino_stake', delta: -1_000 },
        { reason: 'casino_refund', delta: 1_000 },
      ]);
      expect(await cash(b)).toBe(10_000);
      expect(await ledger(b)).toEqual([]);
      // Again, and the other ways out: nothing is refunded twice.
      await expect(acceptChallenge(ctx, b, id, at(2_000))).rejects.toBeInstanceOf(
        ChallengeNotOpenError,
      );
      await expect(closeChallenge(ctx, a, id, 'cancel', at(3_000))).rejects.toBeInstanceOf(
        ChallengeNotOpenError,
      );
      await sweepCasino(ctx, at(500_000));
      expect(await cash(a)).toBe(10_000);
      const row = await pool.query(`SELECT status FROM casino_challenges WHERE challenge_id = $1`, [
        id,
      ]);
      expect(row.rows[0].status).toBe('cancelled');
    });

    it('two racing accepts refund once', async () => {
      const { a, b, id } = await legacy(700);
      await Promise.allSettled([
        acceptChallenge(ctx, b, id, at(1)),
        acceptChallenge(ctx, b, id, at(1)),
      ]);
      expect(await cash(a)).toBe(10_000);
      expect((await ledger(a)).filter((r) => r.reason === 'casino_refund')).toHaveLength(1);
    });

    it('the creator cancelling, or the sweep expiring it, also returns the stake once', async () => {
      const c1 = await legacy(500);
      await closeChallenge(ctx, c1.a, c1.id, 'cancel', at(1_000));
      expect(await cash(c1.a)).toBe(10_000);
      const c2 = await legacy(600, 1_000);
      await sweepCasino(ctx, at(5_000), c2.a);
      await sweepCasino(ctx, at(6_000), c2.a);
      expect(await cash(c2.a)).toBe(10_000);
      expect((await ledger(c2.a)).filter((r) => r.reason === 'casino_refund')).toHaveLength(1);
    });

    it('the sweep refunds a staked challenge even before it expires', async () => {
      const { a, id } = await legacy(800);
      expect((await sweepCasino(ctx, at(10_000), a)).challenges).toBe(1);
      expect(await cash(a)).toBe(10_000);
      const row = await pool.query(`SELECT status FROM casino_challenges WHERE challenge_id = $1`, [
        id,
      ]);
      expect(row.rows[0].status).toBe('cancelled');
      expect((await sweepCasino(ctx, at(20_000), a)).challenges).toBe(0);
    });

    it('new stake-free challenges still work next to it', async () => {
      const { b, id } = await legacy(1_000);
      await expect(acceptChallenge(ctx, b, id, at(1_000))).rejects.toBeDefined();
      const a2 = await newUser();
      const fresh = await createChallenge(ctx, a2, b, 'tails', at(5_000));
      expect(
        (await acceptChallenge(ctx, b, fresh.challenge.challengeId, at(6_000))).challenge.status,
      ).toBe('settled');
    });
  });

  it('keeps the 18+ and self-exclusion gates (but no stake caps)', async () => {
    const a = await newUser();
    const minor = await newUser({ adult: false });
    await expect(createChallenge(ctx, a, a, 'heads', T0)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    await expect(createChallenge(ctx, a, uuidv7(), 'heads', T0)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(createChallenge(ctx, minor, a, 'heads', T0)).rejects.toBeInstanceOf(
      AgeRequiredError,
    );
    const c1 = (await createChallenge(ctx, a, minor, 'heads', T0)).challenge;
    await expect(acceptChallenge(ctx, minor, c1.challengeId, at(1))).rejects.toBeInstanceOf(
      AgeRequiredError,
    );
    const ex = await newUser();
    const c3 = (await createChallenge(ctx, a, ex, 'heads', T0)).challenge;
    await selfExclude(ctx, ex, 1, at(1));
    await expect(acceptChallenge(ctx, ex, c3.challengeId, at(2))).rejects.toBeInstanceOf(
      SelfExcludedError,
    );
    // Daily stake caps do not apply to a challenge that stakes nothing.
    const capped = await newUser();
    await seedLedger(capped, 'casino_stake', -3_000);
    await expect(createChallenge(ctx, capped, a, 'heads', at(1))).resolves.toBeDefined();
  });

  it('refuses a challenge between players who blocked each other', async () => {
    const a = await newUser();
    const b = await newUser();
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      b,
      a,
    ]);
    await expect(createChallenge(ctx, a, b, 'heads', T0)).rejects.toBeInstanceOf(BlockedError);
  });

  it('caps open challenges per player', async () => {
    const a = await newUser();
    const b = await newUser();
    for (let i = 0; i < 5; i++) await createChallenge(ctx, a, b, 'heads', at(i));
    await expect(createChallenge(ctx, a, b, 'heads', at(10))).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});

describe('rounds log (mine only)', () => {
  it('lists the caller newest first with pagination and no seed for open rounds', async () => {
    const u = await newUser();
    const other = await newUser();
    await playSlots(ctx, u, 100, at(1000));
    await playCoinflip(ctx, u, 100, 'tails', at(2000));
    await playSlots(ctx, other, 100, at(2500));
    const all = await listMyRounds(ctx, u, { limit: 10, before: null }, at(3000));
    expect(all.rounds.map((r) => r.game)).toEqual(['coinflip', 'slots']);
    expect(all.rounds.every((r) => r.seed !== null)).toBe(true);
    const page = await listMyRounds(
      ctx,
      u,
      { limit: 10, before: new Date(all.rounds[0]!.createdAt) },
      at(3000),
    );
    expect(page.rounds.map((r) => r.game)).toEqual(['slots']);
  });
});

describe('rich-list weighting (anti-grinding)', () => {
  const boards = new BoardsService(ctx);
  const nowIso = (): Date => new Date();

  async function setCash(userId: string, cents: number): Promise<void> {
    await pool.query(`UPDATE balances SET cash_cents = $2 WHERE user_id = $1`, [userId, cents]);
  }

  it('net worth counts casino profit at 25% and casino losses in full', async () => {
    const winner = await newUser({ cash: 140_000 });
    await seedLedger(winner, 'casino_stake', -10_000, nowIso());
    await seedLedger(winner, 'casino_win', 50_000, nowIso());
    // cash 140,000 includes a casino net of +40,000 -> 100,000 + 40,000 * 25% = 110,000
    expect((await boards.mine('net_worth', 'global', winner))!.value).toBe(110_000);

    const loser = await newUser({ cash: 95_000 });
    await seedLedger(loser, 'casino_stake', -5_000, nowIso());
    expect((await boards.mine('net_worth', 'global', loser))!.value).toBe(95_000);

    const plain = await newUser({ cash: 140_000 });
    expect((await boards.mine('net_worth', 'global', plain))!.value).toBe(140_000);
    await setCash(plain, 140_000);
  });

  it('weekly P&L counts casino profit at 25% and casino losses in full', async () => {
    const winner = await newUser();
    await seedLedger(winner, 'shift_pay', 10_000, nowIso());
    await seedLedger(winner, 'casino_stake', -10_000, nowIso());
    await seedLedger(winner, 'casino_win', 50_000, nowIso());
    // 10,000 + (+40,000 * 25%) = 20,000
    expect((await boards.mine('weekly_pnl', 'global', winner))!.value).toBe(20_000);

    const loser = await newUser();
    await seedLedger(loser, 'shift_pay', 10_000, nowIso());
    await seedLedger(loser, 'casino_stake', -4_000, nowIso());
    expect((await boards.mine('weekly_pnl', 'global', loser))!.value).toBe(6_000);

    // casino rows older than 7 days are outside the window altogether
    const old = await newUser();
    await seedLedger(old, 'casino_win', 90_000, new Date(Date.now() - 9 * 86_400_000));
    expect((await boards.mine('weekly_pnl', 'global', old))!.value).toBe(0);
  });
});
