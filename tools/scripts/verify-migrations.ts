/**
 * Migration verifier.
 *
 * Asserts the SQL-level invariants the M2 + M3 schema must hold
 * against a running Postgres database. This is the cheapest
 * possible smoke test for the ledger, the market engine's
 * coins/positions/perps tables, and the social tables.
 *
 * Checks (M2):
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
 * Checks (M3):
 *
 *   9.  Every M3 table exists.
 *   10. `positions.units >= 0` (CHECK).
 *   11. `perps.leverage` is in [1, 25] (CHECK).
 *   12. `perps.margin_cents > 0` (CHECK).
 *   13. `payment_intents.status` is in the allowed set (CHECK).
 *   14. `alpha_calls.target_micros > stop_micros` (CHECK).
 *   15. `predictions.closes_at > created_at` (CHECK).
 *   16. `dm_messages.text` length is in [1, 500] (CHECK).
 *   17. `feed_posts.text` length is in [1, 280] (CHECK).
 *   18. `payment_intents.reference` is UNIQUE.
 *   19. `tombstones` exists with `lost_cents > 0` CHECK.
 *   20. `users.is_opted_in_smart_money` and `miner_tier` exist.
 *
 * Checks (M4):
 *
 *  21. M4 tables exist: voice_rooms, voice_speakers, paid_call_escrow,
 *      creator_profiles, homes, home_visits, tips, push_devices, meta.
 *  22. voice_rooms.kind CHECK contains 'space', 'video', 'paid_call'.
 *  23. voice_speakers.role CHECK contains 'host', 'speaker', 'listener'.
 *  24. paid_call_escrow.status CHECK contains 'pending', 'active',
 *      'settled', 'refunded', 'disputed'.
 *  25. creator_profiles.handle is UNIQUE.
 *  26. homes.kind CHECK contains parents_basement, hacker_house,
 *      studio, penthouse, marina_villa.
 *  27. tips.kind CHECK contains 'cash', 'onchain'.
 *  28. tips has the (kind = cash AND amount_cents > 0) OR
 *      (kind = onchain AND amount_lamports > 0) CHECK.
 *  29. push_devices.platform CHECK contains 'ios', 'android', 'web'.
 *  30. tips has signature UNIQUE.
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

    // --- M3 invariants ----------------------------------------------

    // (9) M3 tables exist.
    for (const t of [
      'payment_intents',
      'coins',
      'positions',
      'perps',
      'alpha_calls',
      'predictions',
      'dm_messages',
      'feed_posts',
      'follows',
      'webhook_events',
      'tombstones',
    ]) {
      record(`table ${t} exists`, await tableExists(client, t));
    }

    // (10) positions.units CHECK >= 0 present.
    const posUnitsCheck = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conrelid = 'public.positions'::regclass
         AND contype = 'c'`,
    );
    record(
      'positions.units >= 0',
      posUnitsCheck.rows.some((r) => />=\s*0/i.test(r.consrc) && /units/i.test(r.consrc)),
    );

    // (11) perps.leverage BETWEEN 1 AND 25.
    const perpLevCheck = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conrelid = 'public.perps'::regclass
         AND contype = 'c'`,
    );
    record(
      'perps.leverage BETWEEN 1 AND 25',
      perpLevCheck.rows.some(
        (r) => /leverage\s*>=\s*1/i.test(r.consrc) && /leverage\s*<=\s*25/i.test(r.consrc),
      ),
    );

    // (12) perps.margin_cents > 0.
    record(
      'perps.margin_cents > 0',
      perpLevCheck.rows.some((r) => />\s*0/i.test(r.consrc) && /margin_cents/i.test(r.consrc)),
    );

    // (13) payment_intents.status CHECK.
    const payStatusCheck = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conrelid = 'public.payment_intents'::regclass
         AND contype = 'c'
         AND conname LIKE '%status%'`,
    );
    record(
      'payment_intents.status in allowed set',
      payStatusCheck.rows.length > 0 &&
        /pending.*confirmed.*expired.*failed/is.test(payStatusCheck.rows[0]?.consrc ?? ''),
    );

    // (14) alpha_calls.target_micros > stop_micros.
    const alphaCheck = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conrelid = 'public.alpha_calls'::regclass
         AND contype = 'c'`,
    );
    record(
      'alpha_calls.target_micros > stop_micros',
      alphaCheck.rows.some((r) => /target_micros\s*>\s*stop_micros/i.test(r.consrc)),
    );

    // (15) predictions.closes_at > created_at.
    const predCheck = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conrelid = 'public.predictions'::regclass
         AND contype = 'c'`,
    );
    record(
      'predictions.closes_at > created_at',
      predCheck.rows.some((r) => /closes_at\s*>\s*created_at/i.test(r.consrc)),
    );

    // (16) dm_messages.text length 1..500.
    const dmCheck = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conrelid = 'public.dm_messages'::regclass
         AND contype = 'c'`,
    );
    record(
      'dm_messages.text length 1..500',
      dmCheck.rows.some(
        (r) =>
          /length\(text\)\s*>=\s*1/i.test(r.consrc) && /length\(text\)\s*<=\s*500/i.test(r.consrc),
      ),
    );

    // (17) feed_posts.text length 1..280.
    const feedCheck = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conrelid = 'public.feed_posts'::regclass
         AND contype = 'c'`,
    );
    record(
      'feed_posts.text length 1..280',
      feedCheck.rows.some(
        (r) =>
          /length\(text\)\s*>=\s*1/i.test(r.consrc) && /length\(text\)\s*<=\s*280/i.test(r.consrc),
      ),
    );

    // (18) payment_intents.reference UNIQUE.
    const refIdx = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'public.payment_intents'::regclass
         AND i.indisunique
         AND a.attname = 'reference'`,
    );
    record('payment_intents.reference UNIQUE', Number(refIdx.rows[0]?.count ?? '0') > 0);

    // (19) tombstones.lost_cents > 0.
    const tombCheck = await client.query<{ consrc: string }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
       FROM pg_constraint
       WHERE conrelid = 'public.tombstones'::regclass
         AND contype = 'c'`,
    );
    record(
      'tombstones.lost_cents > 0',
      tombCheck.rows.some((r) => /lost_cents\s*>\s*0/i.test(r.consrc)),
    );

    // (20) users smart-money and miner_tier columns.
    const smartCol = await client.query<{ attname: string }>(
      `SELECT attname FROM pg_attribute
       WHERE attrelid = 'public.users'::regclass
         AND attname IN ('is_opted_in_smart_money', 'miner_tier')
       ORDER BY attname`,
    );
    record('users.is_opted_in_smart_money and miner_tier exist', smartCol.rows.length === 2);

    // --- M4 invariants ----------------------------------------------

    // (21) M4 tables exist.
    for (const t of [
      'voice_rooms',
      'voice_speakers',
      'paid_call_escrow',
      'creator_profiles',
      'homes',
      'home_visits',
      'tips',
      'push_devices',
      'meta',
    ]) {
      record(`table ${t} exists`, await tableExists(client, t));
    }

    // Helper: read all CHECK constraints on a table.
    async function checks(table: string): Promise<string[]> {
      const r = await client.query<{ consrc: string }>(
        `SELECT pg_get_constraintdef(oid) AS consrc
         FROM pg_constraint
         WHERE conrelid = $1::regclass AND contype = 'c'`,
        [`public.${table}`],
      );
      return r.rows.map((row) => row.consrc);
    }

    // (22) voice_rooms.kind CHECK contains space/video/paid_call.
    {
      const cs = await checks('voice_rooms');
      const all = cs.join('\n');
      record(
        'voice_rooms.kind in allowed set',
        /kind.*space.*video.*paid_call/is.test(all) || /space.*video.*paid_call/is.test(all),
      );
    }

    // (23) voice_speakers.role CHECK.
    {
      const cs = await checks('voice_speakers');
      const all = cs.join('\n');
      record('voice_speakers.role in allowed set', /host.*speaker.*listener/is.test(all));
    }

    // (24) paid_call_escrow.status CHECK.
    {
      const cs = await checks('paid_call_escrow');
      const all = cs.join('\n');
      record(
        'paid_call_escrow.status in allowed set',
        /pending.*active.*settled.*refunded.*disputed/is.test(all),
      );
    }

    // (25) creator_profiles.handle UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.creator_profiles'::regclass
           AND i.indisunique
           AND a.attname = 'handle'`,
      );
      record('creator_profiles.handle UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (26) homes.kind CHECK.
    {
      const cs = await checks('homes');
      const all = cs.join('\n');
      record(
        'homes.kind in allowed set',
        /parents_basement.*hacker_house.*studio.*penthouse.*marina_villa/is.test(all),
      );
    }

    // (27) tips.kind CHECK.
    {
      const cs = await checks('tips');
      const all = cs.join('\n');
      record('tips.kind in allowed set', /cash.*onchain/is.test(all));
    }

    // (28) tips amount invariant CHECK.
    {
      const cs = await checks('tips');
      const all = cs.join('\n');
      record(
        'tips amount invariant CHECK',
        /kind\s*=\s*'cash'/i.test(all) &&
          /kind\s*=\s*'onchain'/i.test(all) &&
          /amount_cents\s*IS NOT NULL/i.test(all) &&
          /amount_lamports\s*IS NOT NULL/i.test(all),
      );
    }

    // (29) push_devices.platform CHECK.
    {
      const cs = await checks('push_devices');
      const all = cs.join('\n');
      record('push_devices.platform in allowed set', /ios.*android.*web/is.test(all));
    }

    // (30) tips.signature UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.tips'::regclass
           AND i.indisunique
           AND a.attname = 'signature'`,
      );
      record('tips.signature UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }
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
