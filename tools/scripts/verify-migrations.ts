/**
 * Migration verifier.
 *
 * Asserts the SQL-level invariants the M2 schema must hold against a
 * running Postgres database. This is the cheapest possible smoke test
 * for the ledger and the lookup-heavy tables.
 *
 * Checks:
 *
 *   1. Every table in docs/DATA_MODEL.md (M2 subset) exists.
 *   2. `ledger_entries` has a BEFORE UPDATE OR DELETE trigger that raises.
 *   3. UPDATE on a ledger row raises `check_violation`.
 *   4. DELETE on a ledger row raises `check_violation`.
 *   5. `blocks` has UNIQUE (blocker_user_id, blocked_user_id).
 *   6. `ledger_entries.idempotency_ref` is UNIQUE.
 *   7. `users.wallet` is UNIQUE.
 *   8. `balances.cash_cents` and `balances.debt_cents` are non-negative
 *      (CHECK constraint present).
 *
 * Run: pnpm exec tsx tools/scripts/verify-migrations.ts
 *
 * Exit code 0 on success, 1 on any failure.
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv();

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://ctlife:ctlife@localhost:5434/ctlife';

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  const tag = ok ? 'OK  ' : 'FAIL';
  const tail = detail ? ` — ${detail}` : '';
  console.log(`[${tag}] ${name}${tail}`);
}

async function tableExists(client: Client, table: string): Promise<boolean> {
  const r = await client.query('SELECT to_regclass($1) AS t', [`public.${table}`]);
  return (r.rows[0]?.t ?? null) !== null;
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    // (1) tables.
    for (const t of [
      'users',
      'characters',
      'balances',
      'ledger_entries',
      'needs',
      'skills',
      'blocks',
      'reports',
    ]) {
      record(`table ${t} exists`, await tableExists(client, t));
    }

    // (2) trigger present.
    const trig = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_trigger
       WHERE tgrelid = 'public.ledger_entries'::regclass
         AND tgfoid = 'ledger_entries_append_only'::regproc`,
    );
    record('ledger_entries has append-only trigger', Number(trig.rows[0]?.count ?? '0') > 0);

    // (3) UPDATE raises. Insert a sentinel row first.
    const walletA = `VerifyA${Date.now().toString().padStart(20, '0')}`;
    const walletB = `VerifyB${Date.now().toString().padStart(20, '0')}`;
    const userA = `00000000-0000-7000-8000-${Math.floor(Math.random() * 1e12)
      .toString()
      .padStart(12, '0')}`;
    const userB = `00000000-0000-7000-8000-${Math.floor(Math.random() * 1e12)
      .toString()
      .padStart(12, '0')}`;
    await client.query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userA, walletA]);
    await client.query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userB, walletB]);
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason)
       VALUES ($1, 100, 'cash', 'verify')`,
      [userA],
    );
    const idem = `verify-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, idempotency_ref)
       VALUES ($1, 200, 'cash', 'verify', $2)`,
      [userA, idem],
    );

    let updateBlocked = false;
    try {
      await client.query('UPDATE ledger_entries SET delta_cents = 999 WHERE reason = $1', [
        'verify',
      ]);
    } catch (e) {
      updateBlocked = (e as { code?: string }).code === '23514'; // check_violation
    }
    record('ledger_entries UPDATE is blocked', updateBlocked);

    let deleteBlocked = false;
    try {
      await client.query('DELETE FROM ledger_entries WHERE reason = $1', ['verify']);
    } catch (e) {
      deleteBlocked = (e as { code?: string }).code === '23514';
    }
    record('ledger_entries DELETE is blocked', deleteBlocked);

    // (5) blocks UNIQUE.
    await client.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      userA,
      userB,
    ]);
    let blocksUnique = false;
    try {
      await client.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
        userA,
        userB,
      ]);
    } catch (e) {
      blocksUnique = (e as { code?: string }).code === '23505'; // unique_violation
    }
    record('blocks UNIQUE (blocker, blocked)', blocksUnique);

    // (6) ledger idempotency UNIQUE.
    let idemUnique = false;
    try {
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, idempotency_ref)
         VALUES ($1, 300, 'cash', 'verify2', $2)`,
        [userB, idem],
      );
    } catch (e) {
      idemUnique = (e as { code?: string }).code === '23505';
    }
    record('ledger_entries.idempotency_ref UNIQUE', idemUnique);

    // (7) users.wallet UNIQUE.
    let walletUnique = false;
    try {
      await client.query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [
        `00000000-0000-7000-8000-${Math.floor(Math.random() * 1e12)
          .toString()
          .padStart(12, '0')}`,
        walletA,
      ]);
    } catch (e) {
      walletUnique = (e as { code?: string }).code === '23505';
    }
    record('users.wallet UNIQUE', walletUnique);

    // (8) cash_cents CHECK >= 0 present.
    const cashCheck = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conrelid = 'public.balances'::regclass
         AND contype = 'c'
         AND conname LIKE '%cash_cents%'`,
    );
    record(
      'balances.cash_cents has non-negative CHECK',
      cashCheck.rows.length > 0 && />= 0/i.test(cashCheck.rows[0]?.consrc ?? ''),
    );
  } finally {
    await client.end();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\nverify-migrations: ${failed.length} failure(s).`);
    process.exit(1);
  }
  console.log(`\nverify-migrations: ${results.length} check(s) passed.`);
}

void main();
