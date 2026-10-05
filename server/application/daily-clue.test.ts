/**
 * Daily clue + Sunday Unlock worker tests.
 *
 * Covers:
 *   - getToday() returns clue text + expiresAt, never the hash
 *   - answer() correct -> credits prize via 'daily_clue' ledger row
 *   - answer() wrong -> records attempt, no credit
 *   - answer() UNIQUE (user_id, clue_id) -> second attempt refused
 *   - runSundayUnlock credits 'weekly_perk' to season-pass holders
 *     who solved any clue in the prior week
 *   - runWeeklyMeta upserts the 'current' meta row
 *   - both workers are idempotent on (kind, week_iso)
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from '../application/context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ForbiddenError } from '../shared/domain/errors.js';
import {
  getCurrentMeta,
  runSundayUnlock,
  runWeeklyMeta,
  weekIso,
} from '../workers/sunday-unlock.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TEST_DATE = '2099-12-28'; // a Sunday far in the future; pool picks deterministically

beforeAll(async () => {
  // No global user; each test creates its own.
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM daily_clue_attempts`);
  await pool.query(`DELETE FROM daily_clue WHERE date = $1`, [TEST_DATE]);
  await pool.query(`DELETE FROM meta_jobs WHERE week_iso LIKE '2099-W%'`);
});

describe('daily clue service', () => {
  it('getToday returns clue text and expiresAt, never the hash', async () => {
    const ctx = buildContext();
    const { getToday, seedClue } = await import('../application/daily-clue.js');
    await seedClue(ctx, TEST_DATE);
    const out = await getToday(ctx);
    // The test uses real today (the only date getToday accepts),
    // so verify the schema only — text + expiresAt + prizeCents.
    expect(out.clueText.length).toBeGreaterThan(0);
    expect(out.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.prizeCents).toBeGreaterThan(0);
    expect((out as unknown as { answerHash?: string }).answerHash).toBeUndefined();
  });

  it('answer() correct credits the prize via daily_clue ledger row', async () => {
    const ctx = buildContext();
    const userId = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
      userId,
      `clueUser-${userId}`,
    ]);
    await pool.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    // Manually seed a clue we know the answer to.
    await pool.query(`DELETE FROM daily_clue WHERE date = $1`, [TEST_DATE]);
    const clueId = uuidv7();
    const { createHash } = await import('node:crypto');
    const answerHash = createHash('sha256').update('paris').digest('hex');
    await pool.query(
      `INSERT INTO daily_clue (clue_id, date, clue_text, answer_hash, prize_cents, expires_at)
       VALUES ($1, $2, 'Capital of France?', $3, 1234, now() + interval '1 day')`,
      [clueId, TEST_DATE, answerHash],
    );
    // Temporarily monkey-patch todayUtc by seeding via the route -
    // simpler: directly test the answer path with a controlled clue
    // row in the future date range. For 'today', we go through
    // the normal seedClue path; the actual correct answer is
    // pool-dependent. Simpler: insert today's clue and resolve
    // the answer from the pool.
    const today = new Date();
    const todayStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    await pool.query(`DELETE FROM daily_clue WHERE date = $1`, [todayStr]);
    const { seedClue, getToday, answer } = await import('../application/daily-clue.js');
    await seedClue(ctx, todayStr);
    const today_clue = await getToday(ctx);
    void today_clue;
    // Read the seeded answer_hash and find the matching pool answer.
    const pool_modules = await import('../application/daily-clue.js');
    void pool_modules;
    // Compute the answer by checking pool items.
    const items = (await import('../application/daily-clue.js')) as unknown as {
      __pool?: Array<{ text: string; answer: string; prizeCents: number }>;
    };
    void items;
    // Read pool from the module's source — easier: query the daily_clue
    // row for today's date and brute-force by hashing pool answers.
    const r = await pool.query<{ answer_hash: string }>(
      `SELECT answer_hash FROM daily_clue WHERE date = $1`,
      [todayStr],
    );
    const seeded = r.rows[0];
    expect(seeded).toBeDefined();
    // Try every pool answer.
    const POOL = ['q', '7', 'tokyo', '1989', '2', 'mars', '88', 'au'];
    const correct = POOL.find(
      (a) => createHash('sha256').update(a).digest('hex') === seeded!.answer_hash,
    );
    expect(correct).toBeDefined();
    const before = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [userId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    const out = await answer(ctx, userId, correct!);
    expect(out.correct).toBe(true);
    expect(out.prizeCents).toBeGreaterThan(0);
    const after = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [userId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    expect(after).toBe(before + out.prizeCents);
  });

  it('answer() wrong attempt is recorded but pays nothing', async () => {
    const ctx = buildContext();
    const userId = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
      userId,
      `clueWrong-${userId}`,
    ]);
    const { seedClue, answer } = await import('../application/daily-clue.js');
    await seedClue(ctx);
    const out = await answer(ctx, userId, 'definitely-not-the-answer');
    expect(out.correct).toBe(false);
    expect(out.prizeCents).toBe(0);
  });

  it('second answer for the same clue is refused (UNIQUE user_id+clue_id)', async () => {
    const ctx = buildContext();
    const userId = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
      userId,
      `clueDbl-${userId}`,
    ]);
    const { seedClue, answer } = await import('../application/daily-clue.js');
    await seedClue(ctx);
    await answer(ctx, userId, 'first-guess');
    await expect(answer(ctx, userId, 'second-guess')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('sunday-unlock + weekly-meta worker', () => {
  it('weekIso() returns a well-formed ISO week', () => {
    expect(weekIso(new Date('2026-10-05T00:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('runSundayUnlock credits weekly_perk to season-pass holders who solved last week', async () => {
    const ctx = buildContext();
    const db = ctx.db;
    const userId = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
      userId,
      `sunUser-${userId}`,
    ]);
    await pool.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    // Issue a season pass expiring in the future.
    const passId = uuidv7();
    await pool.query(
      `INSERT INTO season_pass (pass_id, user_id, tier, expires_at)
       VALUES ($1, $2, 'season', now() + interval '30 days')`,
      [passId, userId],
    );
    // Insert a 'correct' daily_clue_attempts row inside the prior
    // week window. The worker queries attempted_at between
    // (now - 7 days, now); a row 3 days old is in range.
    const clueId = uuidv7();
    const { createHash } = await import('node:crypto');
    const fakeHash = createHash('sha256').update('test').digest('hex');
    await pool.query(
      `INSERT INTO daily_clue (clue_id, date, clue_text, answer_hash, prize_cents, expires_at)
       VALUES ($1, '2099-09-01', 'test', $2, 100, now() + interval '1 day')`,
      [clueId, fakeHash],
    );
    await pool.query(
      `INSERT INTO daily_clue_attempts (attempt_id, user_id, clue_id, attempt_text, correct, attempted_at)
       VALUES ($1, $2, $3, 'yes', true, now() - interval '3 days')`,
      [uuidv7(), userId, clueId],
    );
    // Force a unique weekIso by nuking any existing meta_jobs row.
    const wk = weekIso(new Date());
    await pool.query(`DELETE FROM meta_jobs WHERE kind = 'sunday_unlock' AND week_iso = $1`, [wk]);
    const out = await runSundayUnlock(db);
    expect(out.skipped).toBe(false);
    expect(out.weekIso).toBe(wk);
    expect(out.credited).toBeGreaterThanOrEqual(0);
    // Verify the 'weekly_perk' ledger row exists for our user.
    const led = await pool.query<{ reason: string }>(
      `SELECT reason FROM ledger_entries WHERE user_id = $1 AND reason = 'weekly_perk' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    // The user is eligible (pass holder + solved a clue in window).
    expect(led.rows[0]?.reason).toBe('weekly_perk');
    // Re-run is a no-op.
    const second = await runSundayUnlock(db);
    expect(second.skipped).toBe(true);
  });

  it('runWeeklyMeta upserts the current meta row', async () => {
    const ctx = buildContext();
    const db = ctx.db;
    const wk = weekIso(new Date());
    await pool.query(`DELETE FROM meta_jobs WHERE kind = 'weekly_meta' AND week_iso = $1`, [wk]);
    await pool.query(`DELETE FROM meta WHERE key = 'current'`);
    const out = await runWeeklyMeta(db);
    expect(out.skipped).toBe(false);
    expect(out.weekIso).toBe(wk);
    const meta = await getCurrentMeta(db);
    expect(meta).not.toBeNull();
    expect(meta!.weekIso).toBe(wk);
    const second = await runWeeklyMeta(db);
    expect(second.skipped).toBe(true);
  });
});
