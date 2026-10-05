/**
 * Businesses service tests.
 *
 * Covers: create (rent debit + ledger row), getBusiness with
 * recent days, runBusiness with bad_day / normal / great_day
 * outcomes, idempotency on (business_id, day_date), insufficient
 * cash refusal, and the not-the-owner 403.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let ownerId: string;
let otherId: string;

beforeAll(async () => {
  ownerId = uuidv7();
  otherId = uuidv7();
  for (const id of [ownerId, otherId]) {
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `bizUser-${id}`]);
  }
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 1000000)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = 1000000`,
    [ownerId],
  );
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `DELETE FROM business_days WHERE business_id IN (SELECT business_id FROM businesses WHERE owner_user_id = $1)`,
    [ownerId],
  );
  await pool.query(`DELETE FROM businesses WHERE owner_user_id = $1`, [ownerId]);
  await pool.query(`UPDATE balances SET cash_cents = 1000000 WHERE user_id = $1`, [ownerId]);
});

describe('businesses service', () => {
  it('createBusiness debits first week rent and writes a businesses row', async () => {
    const ctx = buildContext();
    const { createBusiness } = await import('./businesses.js');
    const before = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [ownerId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    const out = await createBusiness(ctx, ownerId, 'lemonade_stand');
    expect(out.kind).toBe('lemonade_stand');
    expect(out.rentCentsPerWeek).toBe(2_000);
    const after = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [ownerId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    expect(after).toBe(before - 2_000);
    const led = await pool.query<{ reason: string }>(
      `SELECT reason FROM ledger_entries WHERE user_id = $1 AND reason = 'business_rent'`,
      [ownerId],
    );
    expect(led.rows.length).toBe(1);
  });

  it('insufficient cash refuses the create', async () => {
    const ctx = buildContext();
    const { createBusiness } = await import('./businesses.js');
    await pool.query(`UPDATE balances SET cash_cents = 100 WHERE user_id = $1`, [ownerId]);
    await expect(createBusiness(ctx, ownerId, 'cafe')).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('runBusiness bad_day pays 0 and writes the business_days row', async () => {
    const ctx = buildContext();
    const { createBusiness, runBusiness } = await import('./businesses.js');
    const out = await createBusiness(ctx, ownerId, 'lemonade_stand');
    const before = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [ownerId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    // Force r < badDayPct (30) so we always get bad_day.
    const r = await runBusiness(ctx, out.businessId, ownerId, () => 0.05);
    expect(r.kind).toBe('bad_day');
    expect(r.payCents).toBe(0);
    const after = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [ownerId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    expect(after).toBe(before);
  });

  it('runBusiness great_day pays income_max', async () => {
    const ctx = buildContext();
    const { createBusiness, runBusiness } = await import('./businesses.js');
    const out = await createBusiness(ctx, ownerId, 'lemonade_stand');
    // r = 0.35 -> falls in great_day (badDayPct=30, greatDayPct=10 -> 30..40).
    const r = await runBusiness(ctx, out.businessId, ownerId, () => 0.35);
    expect(r.kind).toBe('great_day');
    expect(r.payCents).toBe(out.incomeMaxCents);
  });

  it('runBusiness normal pays in [income_min, income_max]', async () => {
    const ctx = buildContext();
    const { createBusiness, runBusiness } = await import('./businesses.js');
    const out = await createBusiness(ctx, ownerId, 'lemonade_stand');
    // r = 0.5 -> falls in normal (>= badDayPct + greatDayPct = 40).
    const r = await runBusiness(ctx, out.businessId, ownerId, () => 0.5);
    expect(r.kind).toBe('normal');
    expect(r.payCents).toBeGreaterThanOrEqual(out.incomeMinCents);
    expect(r.payCents).toBeLessThanOrEqual(out.incomeMaxCents);
  });

  it('runBusiness is idempotent on (business_id, day_date)', async () => {
    const ctx = buildContext();
    const { createBusiness, runBusiness } = await import('./businesses.js');
    const out = await createBusiness(ctx, ownerId, 'lemonade_stand');
    const first = await runBusiness(ctx, out.businessId, ownerId, () => 0.35);
    const second = await runBusiness(ctx, out.businessId, ownerId, () => 0.35);
    expect(second.dayId).toBe(first.dayId);
    expect(second.payCents).toBe(first.payCents);
  });

  it('runBusiness refuses non-owner with ForbiddenError', async () => {
    const ctx = buildContext();
    const { createBusiness, runBusiness } = await import('./businesses.js');
    const out = await createBusiness(ctx, ownerId, 'lemonade_stand');
    await expect(runBusiness(ctx, out.businessId, otherId, () => 0.5)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('getBusiness returns the business + recent days', async () => {
    const ctx = buildContext();
    const { createBusiness, runBusiness, getBusiness } = await import('./businesses.js');
    const out = await createBusiness(ctx, ownerId, 'lemonade_stand');
    await runBusiness(ctx, out.businessId, ownerId, () => 0.35);
    const got = await getBusiness(ctx, out.businessId);
    expect(got.business.kind).toBe('lemonade_stand');
    expect(got.recentDays.length).toBeGreaterThanOrEqual(1);
  });

  it('getBusiness on unknown id throws NotFoundError', async () => {
    const ctx = buildContext();
    const { getBusiness } = await import('./businesses.js');
    await expect(getBusiness(ctx, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });
});
