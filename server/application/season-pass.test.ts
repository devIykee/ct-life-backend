/**
 * Season pass service tests.
 *
 * Covers: the pass grant a verified payment intent makes (no
 * Cash), a repeat grant, the /me endpoint, and the /claim endpoint's source-of-truth
 * (the Sunday Unlock worker writes the ledger row; claim
 * reads it).
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { runSundayUnlock } from '../workers/sunday-unlock.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let userId: string;

beforeAll(async () => {
  userId = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
    userId,
    `passUser-${userId}`,
  ]);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // The ledger is append-only; we leave season_pass_buy and
  // weekly_perk entries behind. Reset the state that we own.
  await pool.query(`DELETE FROM season_pass WHERE user_id = $1`, [userId]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 1000000)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = 1000000, debt_cents = 0`,
    [userId],
  );
});

describe('season pass service', () => {
  it('grantSeasonPass writes tier=season until the season end, and never touches Cash', async () => {
    const ctx = buildContext();
    const { grantSeasonPass, SEASON_PASS_PRICE_CENTS } = await import('./season-pass.js');
    const endsAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const out = await grantSeasonPass(pool, userId, { endsAt });
    expect(out.tier).toBe('season');
    expect(out.pricePaidCents).toBe(SEASON_PASS_PRICE_CENTS);
    expect(out.expiresAt).toBe(endsAt);
    const bal = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [userId],
    );
    expect(Number(bal.rows[0]?.cash_cents)).toBe(1_000_000);
    const { getByUser } = await import('./season-pass.js');
    expect((await getByUser(ctx, userId))?.tier).toBe('season');
  });

  it('a second grant keeps the later expiry and adds the price', async () => {
    const { grantSeasonPass } = await import('./season-pass.js');
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString();
    const sooner = new Date(Date.now() + 10 * 86_400_000).toISOString();
    await grantSeasonPass(pool, userId, { endsAt: later });
    const second = await grantSeasonPass(pool, userId, { endsAt: sooner });
    expect(second.expiresAt).toBe(later);
    expect(second.pricePaidCents).toBe(1000);
  });

  it('getByUser returns null for a user with no pass', async () => {
    const ctx = buildContext();
    const { getByUser } = await import('./season-pass.js');
    const fresh = uuidv7();
    const out = await getByUser(ctx, fresh);
    expect(out).toBeNull();
  });

  it('claim refuses when no pass exists', async () => {
    const ctx = buildContext();
    const { claim } = await import('./season-pass.js');
    const fresh = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
      fresh,
      `claimUser-${fresh}`,
    ]);
    await expect(claim(ctx, fresh)).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('claim surfaces the weekly_perk ledger row written by the Sunday Unlock worker', async () => {
    const ctx = buildContext();
    const { grantSeasonPass, claim } = await import('./season-pass.js');
    await grantSeasonPass(pool, userId, {
      endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    // Insert a winning daily_clue_attempts inside the prior week window.
    const clueId = uuidv7();
    const { createHash } = await import('node:crypto');
    const fakeHash = createHash('sha256').update('test').digest('hex');
    await pool.query(
      `INSERT INTO daily_clue (clue_id, date, clue_text, answer_hash, prize_cents, expires_at)
       VALUES ($1, '2099-09-02', 'test', $2, 100, now() + interval '1 day')
       ON CONFLICT (date) DO NOTHING`,
      [clueId, fakeHash],
    );
    const clueR = await pool.query<{ clue_id: string }>(
      `SELECT clue_id FROM daily_clue WHERE date = '2099-09-02'`,
    );
    const realClueId = clueR.rows[0]?.clue_id ?? clueId;
    await pool.query(
      `INSERT INTO daily_clue_attempts (attempt_id, user_id, clue_id, attempt_text, correct, attempted_at)
       VALUES ($1, $2, $3, 'yes', true, now() - interval '3 days')`,
      [uuidv7(), userId, realClueId],
    );
    // Clear any prior sunday-unlock for this week.
    const { weekIso } = await import('../workers/sunday-unlock.js');
    const wk = weekIso(new Date());
    await pool.query(`DELETE FROM meta_jobs WHERE kind = 'sunday_unlock' AND week_iso = $1`, [wk]);
    await runSundayUnlock(ctx.db);
    const out = await claim(ctx, userId);
    expect(out.credited).toBe(true);
    expect(out.perkCents).toBe(500);
    expect(out.weekIso).toBe(wk);
  });
});
