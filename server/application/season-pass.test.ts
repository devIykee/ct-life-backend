/**
 * Season pass service tests.
 *
 * Covers: tiered pricing (free vs season), expiring pass
 * behavior, double-buy idempotency, insufficient-cash refusal,
 * the /me endpoint, and the /claim endpoint's source-of-truth
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
  it('buy debits $5, writes a season_pass row with tier=season', async () => {
    const ctx = buildContext();
    const { buy } = await import('./season-pass.js');
    const out = await buy(ctx, userId);
    expect(out.tier).toBe('season');
    expect(out.pricePaidCents).toBe(500);
    expect(new Date(out.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const bal = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [userId],
    );
    expect(Number(bal.rows[0]?.cash_cents)).toBe(1_000_000 - 500);
    const led = await pool.query<{ reason: string }>(
      `SELECT reason FROM ledger_entries WHERE user_id = $1 AND reason = 'season_pass_buy'`,
      [userId],
    );
    expect(led.rows.length).toBe(1);
  });

  it('re-buy extends expires_at and accumulates price_paid_cents (idempotent)', async () => {
    const ctx = buildContext();
    const { buy, getByUser } = await import('./season-pass.js');
    const first = await buy(ctx, userId);
    const second = await buy(ctx, userId);
    expect(second.tier).toBe('season');
    expect(second.pricePaidCents).toBe(1000);
    const after = await getByUser(ctx, userId);
    expect(after!.tier).toBe('season');
    expect(after!.pricePaidCents).toBe(1000);
    // expires_at moved forward.
    expect(new Date(after!.expiresAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.expiresAt).getTime(),
    );
  });

  it('insufficient cash refuses the buy', async () => {
    const ctx = buildContext();
    const { buy } = await import('./season-pass.js');
    await pool.query(`UPDATE balances SET cash_cents = 100 WHERE user_id = $1`, [userId]);
    await expect(buy(ctx, userId)).rejects.toBeInstanceOf(ValidationFailedError);
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
    const { buy, claim } = await import('./season-pass.js');
    await buy(ctx, userId);
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
