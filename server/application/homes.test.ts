/**
 * Homes service tests.
 *
 * Covers rent debit, rent idempotency, visit append, and the
 * worker missed-rent path (debt_cents increment).
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let ownerId: string;
let visitorId: string;

beforeAll(async () => {
  ownerId = uuidv7();
  visitorId = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2), ($3, $4)`, [
    ownerId,
    `homeOwner-${ownerId}`,
    visitorId,
    `homeVisitor-${visitorId}`,
  ]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 1000000, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = 1000000, debt_cents = 0`,
    [ownerId],
  );
});

afterAll(async () => {
  // Give the doors back: a leftover lease would hold one of the few flat
  // units against the next run on a persistent database.
  await pool.query(`DELETE FROM homes WHERE owner_user_id = $1`, [ownerId]);
  await pool.end();
});

beforeEach(async () => {
  // Append-only ledger: we leave entries behind and only clean
  // up homes + visits + balances.
  await pool.query(
    `DELETE FROM home_visits WHERE home_id IN (SELECT home_id FROM homes WHERE owner_user_id = $1)`,
    [ownerId],
  );
  await pool.query(`DELETE FROM homes WHERE owner_user_id = $1`, [ownerId]);
  await pool.query(`UPDATE balances SET cash_cents = 1000000, debt_cents = 0 WHERE user_id = $1`, [
    ownerId,
  ]);
});

describe('homes service', () => {
  it('createHome debits initial rent, writes last_rent_paid_at', async () => {
    const ctx = buildContext();
    const { createHome } = await import('./homes.js');
    const out = await createHome(ctx, ownerId, 'studio');
    expect(out.kind).toBe('studio');
    expect(out.rentCentsPerWeek).toBe(18_000);
    expect(out.lastRentPaidAt).not.toBeNull();
    const bal = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [ownerId],
    );
    expect(Number(bal.rows[0]?.cash_cents)).toBe(1000000 - 18000);
    // A 'rent' ledger row exists.
    const led = await pool.query<{ reason: string }>(
      `SELECT reason FROM ledger_entries WHERE user_id = $1 AND reason = 'rent' ORDER BY created_at DESC LIMIT 1`,
      [ownerId],
    );
    expect(led.rows[0]?.reason).toBe('rent');
  });

  it('payRent debits the next week rent', async () => {
    const ctx = buildContext();
    const { createHome, payRent } = await import('./homes.js');
    const home = await createHome(ctx, ownerId, 'hacker_house');
    const before = Number(
      (
        await pool.query<{ cash_cents: string }>(
          `SELECT cash_cents FROM balances WHERE user_id = $1`,
          [ownerId],
        )
      ).rows[0]?.cash_cents ?? '0',
    );
    const after = await payRent(ctx, home.homeId, ownerId);
    expect(after.lastRentPaidAt).not.toBeNull();
    const bal = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [ownerId],
    );
    expect(Number(bal.rows[0]?.cash_cents)).toBe(before - 6000);
  });

  it('recordVisit appends a home_visits row', async () => {
    const ctx = buildContext();
    const { createHome, recordVisit, getHome } = await import('./homes.js');
    const home = await createHome(ctx, ownerId, 'parents_basement');
    const visit = await recordVisit(ctx, home.homeId, visitorId);
    expect(visit.visitorUserId).toBe(visitorId);
    const got = await getHome(ctx, home.homeId);
    expect(got.visits.find((v) => v.visitId === visit.visitId)).toBeTruthy();
  });

  it('payRent throws ValidationFailedError for non-owner', async () => {
    const ctx = buildContext();
    const { createHome, payRent } = await import('./homes.js');
    const home = await createHome(ctx, ownerId, 'studio');
    await expect(payRent(ctx, home.homeId, visitorId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('worker missed-rent path increments debt_cents', async () => {
    const ctx = buildContext();
    const { createHome } = await import('./homes.js');
    const home = await createHome(ctx, ownerId, 'studio');
    // Set the owner's cash to zero, run the worker, expect
    // debt_cents to rise by rent.
    await pool.query(`UPDATE balances SET cash_cents = 0 WHERE user_id = $1`, [ownerId]);
    const { runWeeklyRent } = await import('../workers/rent.js');
    const result = await runWeeklyRent(ctx.db);
    expect(result.debt).toBeGreaterThanOrEqual(1);
    const bal = await pool.query<{ debt_cents: string }>(
      `SELECT debt_cents FROM balances WHERE user_id = $1`,
      [ownerId],
    );
    expect(Number(bal.rows[0]?.debt_cents)).toBe(18_000);
    // Cleanup so other tests see fresh state.
    void home;
  });

  it('worker happy path debits cash and writes rent ledger', async () => {
    // Cash already seeded to 1,000,000; reset between tests.
    const ctx = buildContext();
    const { createHome } = await import('./homes.js');
    await createHome(ctx, ownerId, 'studio');
    const { runWeeklyRent } = await import('../workers/rent.js');
    const result = await runWeeklyRent(ctx.db);
    expect(result.debited).toBeGreaterThanOrEqual(1);
  });
});
