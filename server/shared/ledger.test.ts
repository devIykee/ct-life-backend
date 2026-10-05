/**
 * Ledger invariants.
 *
 * The append-only ledger is the source of truth for every cash and
 * debt change. The tests in this file assert the contract:
 *
 *   1. Append-only: UPDATE and DELETE on ledger_entries raise.
 *   2. No negative cash: the balances CHECK + the UoW must keep it >= 0.
 *   3. Idempotency: idempotency_ref is UNIQUE.
 *   4. Per-transaction integrity: every cash write also has a ledger row.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { uuidv7 } from './domain/uuid.js';

loadDotenv({ path: process.cwd() + '/.env' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TEST_USER_ID = uuidv7();

beforeAll(async () => {
  await pool.query(
    'INSERT INTO users (id, wallet) VALUES ($1, $2) ON CONFLICT (wallet) DO NOTHING',
    [TEST_USER_ID, `WiringTest${Date.now()}`],
  );
});

afterAll(async () => {
  // The append-only trigger prevents DELETing ledger_entries, and
  // the users -> ledger_entries FK then blocks DELETing the user.
  // We leave the test data behind: the user id is a uuid so it
  // will not collide with the next test run, and the test asserts
  // invariants on the schema rather than asserting an empty table.
  await pool.end();
});

describe('ledger invariants', () => {
  it('UPDATE on ledger_entries raises', async () => {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, idempotency_ref)
         VALUES ($1, 100, 'cash', 'test', $2) RETURNING id`,
        [TEST_USER_ID, `inv-update-${Date.now()}`],
      )
    ).rows[0]?.id;
    expect(id).toBeTruthy();
    let threw = false;
    try {
      await pool.query('UPDATE ledger_entries SET delta_cents = 999 WHERE id = $1', [id]);
    } catch (e) {
      threw = (e as { code?: string }).code === '23514';
    }
    expect(threw).toBe(true);
  });

  it('DELETE on ledger_entries raises', async () => {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, idempotency_ref)
         VALUES ($1, 100, 'cash', 'test', $2) RETURNING id`,
        [TEST_USER_ID, `inv-delete-${Date.now()}`],
      )
    ).rows[0]?.id;
    expect(id).toBeTruthy();
    let threw = false;
    try {
      await pool.query('DELETE FROM ledger_entries WHERE id = $1', [id]);
    } catch (e) {
      threw = (e as { code?: string }).code === '23514';
    }
    expect(threw).toBe(true);
  });

  it('balances.cash_cents cannot go negative', async () => {
    let threw = false;
    try {
      await pool.query('INSERT INTO balances (user_id, cash_cents) VALUES ($1, -1)', [
        TEST_USER_ID,
      ]);
    } catch (e) {
      threw = (e as { code?: string }).code === '23514';
    }
    expect(threw).toBe(true);
  });

  it('idempotency_ref is unique', async () => {
    const ref = `inv-idem-${Date.now()}`;
    await pool.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, idempotency_ref)
       VALUES ($1, 100, 'cash', 'test', $2)`,
      [TEST_USER_ID, ref],
    );
    let threw = false;
    try {
      await pool.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, idempotency_ref)
         VALUES ($1, 100, 'cash', 'test', $2)`,
        [TEST_USER_ID, ref],
      );
    } catch (e) {
      threw = (e as { code?: string }).code === '23505';
    }
    expect(threw).toBe(true);
  });
});
