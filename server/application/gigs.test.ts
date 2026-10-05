/**
 * Gigs service tests.
 *
 * Covers: listGigs returns the 5 definitions; each gig's
 * formula at boundary inputs (min, mid, max); negative
 * inputs refused; unknown gig refused; the gig writes a
 * gig_runs row + 'gig_pay' ledger row.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let userId: string;

beforeAll(async () => {
  userId = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [userId, `gigUser-${userId}`]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = 0`,
    [userId],
  );
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM gig_runs WHERE user_id = $1`, [userId]);
  await pool.query(`UPDATE balances SET cash_cents = 0 WHERE user_id = $1`, [userId]);
});

describe('gigs service', () => {
  it('listGigs returns the five gig definitions', async () => {
    const { listGigs } = await import('./gigs.js');
    const gigs = listGigs();
    expect(gigs.length).toBe(5);
    const ids = gigs.map((g) => g.gigId).sort();
    expect(ids).toEqual([
      'ad_clicks',
      'data_entry',
      'dog_walking',
      'food_delivery',
      'social_moderation',
    ]);
  });

  it('food_delivery formula: distance 0 -> 300, distance 20 -> 800', async () => {
    const ctx = buildContext();
    const { runGig } = await import('./gigs.js');
    const min = await runGig(ctx, userId, 'food_delivery', { distanceKm: 0 });
    expect(min.payCents).toBe(300);
    const mid = await runGig(ctx, userId, 'food_delivery', { distanceKm: 10 });
    expect(mid.payCents).toBe(550);
    const max = await runGig(ctx, userId, 'food_delivery', { distanceKm: 50 });
    expect(max.payCents).toBe(1550);
  });

  it('data_entry formula: correctRows 0..10 -> 200..700', async () => {
    const ctx = buildContext();
    const { runGig } = await import('./gigs.js');
    const min = await runGig(ctx, userId, 'data_entry', { correctRows: 0 });
    expect(min.payCents).toBe(200);
    const max = await runGig(ctx, userId, 'data_entry', { correctRows: 10 });
    expect(max.payCents).toBe(700);
  });

  it('dog_walking formula: blocks 0..5 -> 500..1500', async () => {
    const ctx = buildContext();
    const { runGig } = await import('./gigs.js');
    const min = await runGig(ctx, userId, 'dog_walking', { blocks30min: 0 });
    expect(min.payCents).toBe(500);
    const max = await runGig(ctx, userId, 'dog_walking', { blocks30min: 5 });
    expect(max.payCents).toBe(1500);
  });

  it('ad_clicks formula: clicks 0..50 -> 100..350', async () => {
    const ctx = buildContext();
    const { runGig } = await import('./gigs.js');
    const min = await runGig(ctx, userId, 'ad_clicks', { clicks: 0 });
    expect(min.payCents).toBe(100);
    const max = await runGig(ctx, userId, 'ad_clicks', { clicks: 50 });
    expect(max.payCents).toBe(350);
  });

  it('social_moderation formula: hours 0..5 -> 800..1300', async () => {
    const ctx = buildContext();
    const { runGig } = await import('./gigs.js');
    const min = await runGig(ctx, userId, 'social_moderation', { hoursOnline: 0 });
    expect(min.payCents).toBe(800);
    const max = await runGig(ctx, userId, 'social_moderation', { hoursOnline: 5 });
    expect(max.payCents).toBe(1300);
  });

  it('runGig writes a gig_runs row and a gig_pay ledger row', async () => {
    const ctx = buildContext();
    const { runGig } = await import('./gigs.js');
    const out = await runGig(ctx, userId, 'food_delivery', { distanceKm: 5 });
    const r = await pool.query<{ pay_cents: string; outcome_id: string }>(
      `SELECT pay_cents, outcome_id FROM gig_runs WHERE run_id = $1`,
      [out.runId],
    );
    expect(Number(r.rows[0]?.pay_cents)).toBe(out.payCents);
    expect(r.rows[0]?.outcome_id).toBe(out.outcomeId);
    const led = await pool.query<{ reason: string }>(
      `SELECT reason FROM ledger_entries WHERE user_id = $1 AND reason = 'gig_pay' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(led.rows[0]?.reason).toBe('gig_pay');
  });

  it('negative input is refused with ValidationFailedError', async () => {
    const ctx = buildContext();
    const { runGig } = await import('./gigs.js');
    await expect(runGig(ctx, userId, 'food_delivery', { distanceKm: -3 })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('unknown gig is refused with NotFoundError', async () => {
    const ctx = buildContext();
    const { runGig } = await import('./gigs.js');
    // @ts-expect-error: testing runtime refusal of an unknown gig id
    await expect(runGig(ctx, userId, 'unknown_xyz')).rejects.toBeInstanceOf(NotFoundError);
  });
});
