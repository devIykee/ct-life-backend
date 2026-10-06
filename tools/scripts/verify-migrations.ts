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
 * Checks (M5):
 *
 *  31. M5 tables exist: daily_clue, daily_clue_attempts, season_pass,
 *      cosmetic_items, cosmetic_inventory, businesses, business_days,
 *      gig_runs, ad_slots, ad_bookings, ad_creatives, projects,
 *      project_hires, nft_mints, meta_jobs.
 *  32. daily_clue.date UNIQUE.
 *  33. daily_clue_attempts UNIQUE (user_id, clue_id).
 *  34. daily_clue.prize_cents > 0.
 *  35. season_pass.user_id UNIQUE.
 *  36. season_pass.tier CHECK contains 'free', 'season'.
 *  37. cosmetic_items.item_key UNIQUE.
 *  38. cosmetic_items.slot CHECK contains skin/head/hair/top/bottom/shoes/acc.
 *  39. cosmetic_inventory UNIQUE (user_id, item_id).
 *  40. cosmetic_inventory.source CHECK contains shop/mint/grant.
 *  41. businesses.kind CHECK contains the 5 kinds.
 *  42. business_days.kind CHECK contains normal/bad_day/great_day.
 *  43. business_days UNIQUE (business_id, day_date).
 *  44. gig_runs.pay_cents >= 0.
 *  45. ad_slots has terms jsonb.
 *  46. ad_bookings.status CHECK contains pending_review/live/rejected.
 *  47. ad_creatives UNIQUE booking_id.
 *  48. ad_creatives.mime_type CHECK contains image/png, image/jpeg.
 *  49. projects.status CHECK contains founded/launching/live/paused/rugged.
 *  50. projects.kind CHECK contains memecoin/dex/nft_studio/perps_venue/l2.
 *  51. project_hires.role CHECK contains dev/mod/kol/auditor.
 *  52. project_hires UNIQUE (project_id, user_id).
 *  53. nft_mints.mint_address UNIQUE.
 *  54. nft_mints.signature UNIQUE.
 *  55. nft_mints.network CHECK contains devnet/mainnet.
 *  56. meta_jobs UNIQUE (kind, week_iso).
 *  57. meta_jobs.kind CHECK contains weekly_meta/sunday_unlock.
 *  58. cosmetic_items.price_cents >= 0.
 *  59. businesses.income_min_cents <= income_max_cents.
 *  60. daily_clue.answer_hash length 64.
 *
 * Checks (M7 #1):
 *
 *  61. M7 tables exist: districts, tribe_district_scores,
 *      district_ownership_history.
 *  62. districts.slug UNIQUE.
 *  63. districts.base_score_per_day > 0.
 *  64. tribe_district_scores.score > 0.
 *  65. tribe_district_scores UNIQUE (tribe_id, district_id, day_date).
 *  66. district_ownership_history UNIQUE (district_id, valid_from).
 *
 * Checks (M7 #2):
 *
 *  67. M7 #2 tables exist: leagues, season_memberships,
 *      season_rollover_log.
 *  68. leagues.slug UNIQUE.
 *  69. leagues.sort_order UNIQUE.
 *  70. leagues.min_net_worth_cents >= 0.
 *  71. leagues.max_members > 0.
 *  72. season_memberships UNIQUE (user_id, season_iso).
 *  73. season_memberships.rank > 0.
 *  74. season_rollover_log UNIQUE (kind, season_iso).
 *  75. season_rollover_log.kind CHECK contains 'season_rollover'.
 *
 * Checks (M7 #5):
 *
 *  76. M7 #5 tables exist: beef_matches, beef_elo.
 *  77. beef_matches.status CHECK contains
 *      'open','active','closed','declined','cancelled'.
 *  78. beef_matches.stake_cents > 0.
 *  79. beef_matches.elo_*_pre/post BETWEEN 0 AND 3000.
 *  80. beef_matches (status='closed' AND winner_user_id NOT NULL)
 *      OR (status != 'closed') CHECK.
 *  81. beef_elo.elo BETWEEN 0 AND 3000.
 *  82. beef_elo.matches_played >= 0.
 *  83. beef_elo (wins + losses + draws) = matches_played CHECK.
 *
 * Checks (M7 #6):
 *
 *  84. users.is_sybil_jailed column exists (default false).
 *  85. airdrop_claims table exists.
 *  86. airdrop_claims UNIQUE (user_id, day_date).
 *  87. airdrop_claims.amount_cents > 0.
 *
 * Checks (M7 #7):
 *
 *  88. cabal_invites table exists.
 *  89. cabal_invites.code UNIQUE.
 *  90. cabal_invites.code length 16..64.
 *
 * Checks (M7 #8):
 *
 *  91. llm_npc_interactions table exists.
 *  92. llm_npc_interactions.archetype CHECK contains
 *      'ai_agent','sleuth'.
 *  93. llm_npc_interactions.prompt_tokens >= 0.
 *  94. llm_npc_interactions.completion_tokens >= 0.
 *
 * Checks (M7 #9):
 *
 *  95. x_links table exists.
 *  96. x_links.user_id UNIQUE.
 *  97. x_links.x_user_id UNIQUE.
 *  98. x_links.state UNIQUE.
 *  99. x_links.x_handle length 1..32.
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

    // --- M5 invariants ----------------------------------------------

    // (31) M5 tables exist.
    for (const t of [
      'daily_clue',
      'daily_clue_attempts',
      'season_pass',
      'cosmetic_items',
      'cosmetic_inventory',
      'businesses',
      'business_days',
      'gig_runs',
      'ad_slots',
      'ad_bookings',
      'ad_creatives',
      'projects',
      'project_hires',
      'nft_mints',
      'meta_jobs',
    ]) {
      record(`table ${t} exists`, await tableExists(client, t));
    }

    // (32) daily_clue.date UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.daily_clue'::regclass
           AND i.indisunique
           AND a.attname = 'date'`,
      );
      record('daily_clue.date UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (33) daily_clue_attempts UNIQUE (user_id, clue_id).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.daily_clue_attempts'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['user_id','clue_id']::name[]`,
      );
      record('daily_clue_attempts UNIQUE (user_id, clue_id)', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (34) daily_clue.prize_cents > 0.
    {
      const cs = await checks('daily_clue');
      const all = cs.join('\n');
      record('daily_clue.prize_cents > 0', /prize_cents\s*>\s*0/i.test(all));
    }

    // (35) season_pass.user_id UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.season_pass'::regclass
           AND i.indisunique
           AND a.attname = 'user_id'`,
      );
      record('season_pass.user_id UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (36) season_pass.tier CHECK contains 'free', 'season'.
    {
      const cs = await checks('season_pass');
      const all = cs.join('\n');
      record('season_pass.tier in allowed set', /free.*season/is.test(all));
    }

    // (37) cosmetic_items.item_key UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.cosmetic_items'::regclass
           AND i.indisunique
           AND a.attname = 'item_key'`,
      );
      record('cosmetic_items.item_key UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (38) cosmetic_items.slot CHECK.
    {
      const cs = await checks('cosmetic_items');
      const all = cs.join('\n');
      record(
        'cosmetic_items.slot in allowed set',
        /skin.*head.*hair.*top.*bottom.*shoes.*acc/is.test(all),
      );
    }

    // (39) cosmetic_inventory UNIQUE (user_id, item_id).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.cosmetic_inventory'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['user_id','item_id']::name[]`,
      );
      record('cosmetic_inventory UNIQUE (user_id, item_id)', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (40) cosmetic_inventory.source CHECK.
    {
      const cs = await checks('cosmetic_inventory');
      const all = cs.join('\n');
      record('cosmetic_inventory.source in allowed set', /shop.*mint.*grant/is.test(all));
    }

    // (41) businesses.kind CHECK.
    {
      const cs = await checks('businesses');
      const all = cs.join('\n');
      record(
        'businesses.kind in allowed set',
        /lemonade_stand.*laundromat.*cafe.*shop.*arcade/is.test(all),
      );
    }

    // (42) business_days.kind CHECK.
    {
      const cs = await checks('business_days');
      const all = cs.join('\n');
      record('business_days.kind in allowed set', /normal.*bad_day.*great_day/is.test(all));
    }

    // (43) business_days UNIQUE (business_id, day_date).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.business_days'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['business_id','day_date']::name[]`,
      );
      record('business_days UNIQUE (business_id, day_date)', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (44) gig_runs.pay_cents >= 0.
    {
      const cs = await checks('gig_runs');
      const all = cs.join('\n');
      record('gig_runs.pay_cents >= 0', />=\s*0/i.test(all) && /pay_cents/i.test(all));
    }

    // (45) ad_slots has terms jsonb.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_attribute
         WHERE attrelid = 'public.ad_slots'::regclass
           AND attname = 'terms'
           AND atttypid = 'jsonb'::regtype`,
      );
      record('ad_slots.terms is jsonb', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (46) ad_bookings.status CHECK.
    {
      const cs = await checks('ad_bookings');
      const all = cs.join('\n');
      record('ad_bookings.status in allowed set', /pending_review.*live.*rejected/is.test(all));
    }

    // (47) ad_creatives UNIQUE booking_id.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.ad_creatives'::regclass
           AND i.indisunique
           AND a.attname = 'booking_id'`,
      );
      record('ad_creatives.booking_id UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (48) ad_creatives.mime_type CHECK.
    {
      const cs = await checks('ad_creatives');
      const all = cs.join('\n');
      record('ad_creatives.mime_type in allowed set', /image\/png.*image\/jpeg/is.test(all));
    }

    // (49) projects.status CHECK.
    {
      const cs = await checks('projects');
      const all = cs.join('\n');
      record(
        'projects.status in allowed set',
        /founded.*launching.*live.*paused.*rugged/is.test(all),
      );
    }

    // (50) projects.kind CHECK.
    {
      const cs = await checks('projects');
      const all = cs.join('\n');
      record(
        'projects.kind in allowed set',
        /memecoin.*dex.*nft_studio.*perps_venue.*l2/is.test(all),
      );
    }

    // (51) project_hires.role CHECK.
    {
      const cs = await checks('project_hires');
      const all = cs.join('\n');
      record('project_hires.role in allowed set', /dev.*mod.*kol.*auditor/is.test(all));
    }

    // (52) project_hires UNIQUE (project_id, user_id).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.project_hires'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['project_id','user_id']::name[]`,
      );
      record('project_hires UNIQUE (project_id, user_id)', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (53) nft_mints.mint_address UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.nft_mints'::regclass
           AND i.indisunique
           AND a.attname = 'mint_address'`,
      );
      record('nft_mints.mint_address UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (54) nft_mints.signature UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.nft_mints'::regclass
           AND i.indisunique
           AND a.attname = 'signature'`,
      );
      record('nft_mints.signature UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (55) nft_mints.network CHECK.
    {
      const cs = await checks('nft_mints');
      const all = cs.join('\n');
      record('nft_mints.network in allowed set', /devnet.*mainnet/is.test(all));
    }

    // (56) meta_jobs UNIQUE (kind, week_iso).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.meta_jobs'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['kind','week_iso']::name[]`,
      );
      record('meta_jobs UNIQUE (kind, week_iso)', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (57) meta_jobs.kind CHECK.
    {
      const cs = await checks('meta_jobs');
      const all = cs.join('\n');
      record('meta_jobs.kind in allowed set', /weekly_meta.*sunday_unlock/is.test(all));
    }

    // (58) cosmetic_items.price_cents >= 0.
    {
      const cs = await checks('cosmetic_items');
      const all = cs.join('\n');
      record('cosmetic_items.price_cents >= 0', />=\s*0/i.test(all) && /price_cents/i.test(all));
    }

    // (59) businesses.income_min_cents <= income_max_cents.
    {
      const cs = await checks('businesses');
      const all = cs.join('\n');
      record(
        'businesses.income_min <= income_max',
        /income_min_cents\s*>=\s*0/i.test(all) &&
          /income_max_cents\s*>=\s*income_min_cents/i.test(all),
      );
    }

    // (60) daily_clue.answer_hash length 64.
    {
      const cs = await checks('daily_clue');
      const all = cs.join('\n');
      record('daily_clue.answer_hash length 64', /length\(answer_hash\)\s*=\s*64/i.test(all));
    }

    // --- M7 #1 invariants -------------------------------------------

    // (61) M7 tables exist.
    for (const t of ['districts', 'tribe_district_scores', 'district_ownership_history']) {
      record(`table ${t} exists`, await tableExists(client, t));
    }

    // (62) districts.slug UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.districts'::regclass
           AND i.indisunique
           AND a.attname = 'slug'`,
      );
      record('districts.slug UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (63) districts.base_score_per_day > 0.
    {
      const cs = await checks('districts');
      const all = cs.join('\n');
      record('districts.base_score_per_day > 0', /base_score_per_day\s*>\s*0/i.test(all));
    }

    // (64) tribe_district_scores.score > 0.
    {
      const cs = await checks('tribe_district_scores');
      const all = cs.join('\n');
      record('tribe_district_scores.score > 0', /score\s*>\s*0/i.test(all));
    }

    // (65) tribe_district_scores UNIQUE (tribe_id, district_id, day_date).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.tribe_district_scores'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['tribe_id','district_id','day_date']::name[]`,
      );
      record(
        'tribe_district_scores UNIQUE (tribe_id, district_id, day_date)',
        Number(r.rows[0]?.count ?? '0') > 0,
      );
    }

    // (66) district_ownership_history UNIQUE (district_id, valid_from).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.district_ownership_history'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['district_id','valid_from']::name[]`,
      );
      record(
        'district_ownership_history UNIQUE (district_id, valid_from)',
        Number(r.rows[0]?.count ?? '0') > 0,
      );
    }

    // --- M7 #2 invariants -------------------------------------------

    // (67) M7 #2 tables exist.
    for (const t of ['leagues', 'season_memberships', 'season_rollover_log']) {
      record(`table ${t} exists`, await tableExists(client, t));
    }

    // (68) leagues.slug UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.leagues'::regclass
           AND i.indisunique
           AND a.attname = 'slug'`,
      );
      record('leagues.slug UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (69) leagues.sort_order UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.leagues'::regclass
           AND i.indisunique
           AND a.attname = 'sort_order'`,
      );
      record('leagues.sort_order UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (70) leagues.min_net_worth_cents >= 0.
    {
      const cs = await checks('leagues');
      const all = cs.join('\n');
      record('leagues.min_net_worth_cents >= 0', /min_net_worth_cents\s*>=\s*0/i.test(all));
    }

    // (71) leagues.max_members > 0.
    {
      const cs = await checks('leagues');
      const all = cs.join('\n');
      record('leagues.max_members > 0', /max_members\s*>\s*0/i.test(all));
    }

    // (72) season_memberships UNIQUE (user_id, season_iso).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.season_memberships'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['user_id','season_iso']::name[]`,
      );
      record(
        'season_memberships UNIQUE (user_id, season_iso)',
        Number(r.rows[0]?.count ?? '0') > 0,
      );
    }

    // (73) season_memberships.rank > 0.
    {
      const cs = await checks('season_memberships');
      const all = cs.join('\n');
      record('season_memberships.rank > 0', /rank\s*>\s*0/i.test(all));
    }

    // (74) season_rollover_log UNIQUE (kind, season_iso).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.season_rollover_log'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['kind','season_iso']::name[]`,
      );
      record('season_rollover_log UNIQUE (kind, season_iso)', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (75) season_rollover_log.kind CHECK.
    {
      const cs = await checks('season_rollover_log');
      const all = cs.join('\n');
      record('season_rollover_log.kind in allowed set', /season_rollover/i.test(all));
    }

    // --- M7 #5 invariants -------------------------------------------

    // (76) M7 #5 tables exist.
    for (const t of ['beef_matches', 'beef_elo']) {
      record(`table ${t} exists`, await tableExists(client, t));
    }

    // (77) beef_matches.status CHECK.
    {
      const cs = await checks('beef_matches');
      const all = cs.join('\n');
      record(
        'beef_matches.status in allowed set',
        /open.*active.*closed.*declined.*cancelled/is.test(all),
      );
    }

    // (78) beef_matches.stake_cents > 0.
    {
      const cs = await checks('beef_matches');
      const all = cs.join('\n');
      record('beef_matches.stake_cents > 0', /stake_cents\s*>\s*0/i.test(all));
    }

    // (79) beef_matches.elo_*_pre/post BETWEEN 0 AND 3000.
    {
      const cs = await checks('beef_matches');
      const all = cs.join('\n');
      record(
        'beef_matches.elo_*_pre/post BETWEEN 0 AND 3000',
        /elo_challenger_pre\s+BETWEEN\s+0\s+AND\s+3000/i.test(all) === false
          ? /elo_challenger_pre\s*>=\s*0/i.test(all) &&
              /elo_challenger_pre\s*<=\s*3000/i.test(all) &&
              /elo_accepter_pre\s*>=\s*0/i.test(all) &&
              /elo_accepter_pre\s*<=\s*3000/i.test(all) &&
              /elo_challenger_post\s*>=\s*0/i.test(all) &&
              /elo_challenger_post\s*<=\s*3000/i.test(all) &&
              /elo_accepter_post\s*>=\s*0/i.test(all) &&
              /elo_accepter_post\s*<=\s*3000/i.test(all)
          : true,
      );
    }

    // (80) beef_matches (closed + winner) CHECK.
    {
      const cs = await checks('beef_matches');
      const all = cs.join('\n');
      record(
        'beef_matches status=closed requires winner_user_id',
        /status\s*=\s*'closed'/i.test(all) && /winner_user_id\s+IS\s+NOT\s+NULL/i.test(all),
      );
    }

    // (81) beef_elo.elo BETWEEN 0 AND 3000.
    {
      const cs = await checks('beef_elo');
      const all = cs.join('\n');
      record(
        'beef_elo.elo BETWEEN 0 AND 3000',
        /elo\s+BETWEEN\s+0\s+AND\s+3000/i.test(all) ||
          (/elo\s*>=\s*0/i.test(all) && /elo\s*<=\s*3000/i.test(all)),
      );
    }

    // (82) beef_elo.matches_played >= 0.
    {
      const cs = await checks('beef_elo');
      const all = cs.join('\n');
      record('beef_elo.matches_played >= 0', /matches_played\s*>=\s*0/i.test(all));
    }

    // (83) beef_elo wins+losses+draws = matches_played.
    {
      const cs = await checks('beef_elo');
      const all = cs.join('\n');
      record(
        'beef_elo wins+losses+draws = matches_played',
        /wins\s*\+\s*losses\s*\+\s*draws\s*=\s*matches_played/is.test(all) ||
          /wins\s*\+\s*losses\s*\)\s*\+\s*draws\s*=\s*matches_played/is.test(all) ||
          /\(\(wins\s*\+\s*losses\)\s*\+\s*draws\)\s*=\s*matches_played/is.test(all),
      );
    }

    // --- M7 #6 invariants -------------------------------------------

    // (84) users.is_sybil_jailed column exists.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_attribute
         WHERE attrelid = 'public.users'::regclass
           AND attname = 'is_sybil_jailed'`,
      );
      record('users.is_sybil_jailed exists', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (85) airdrop_claims table exists.
    {
      record('table airdrop_claims exists', await tableExists(client, 'airdrop_claims'));
    }

    // (86) airdrop_claims UNIQUE (user_id, day_date).
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         WHERE i.indrelid = 'public.airdrop_claims'::regclass
           AND i.indisunique
           AND (SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
                = ARRAY['user_id','day_date']::name[]`,
      );
      record('airdrop_claims UNIQUE (user_id, day_date)', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (87) airdrop_claims.amount_cents > 0.
    {
      const cs = await checks('airdrop_claims');
      const all = cs.join('\n');
      record('airdrop_claims.amount_cents > 0', /amount_cents\s*>\s*0/i.test(all));
    }

    // --- M7 #7 invariants -------------------------------------------

    // (88) cabal_invites table exists.
    {
      record('table cabal_invites exists', await tableExists(client, 'cabal_invites'));
    }

    // (89) cabal_invites.code UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.cabal_invites'::regclass
           AND i.indisunique
           AND a.attname = 'code'`,
      );
      record('cabal_invites.code UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (90) cabal_invites.code length 16..64.
    {
      const cs = await checks('cabal_invites');
      const all = cs.join('\n');
      record(
        'cabal_invites.code length 16..64',
        /length\(code\)\s+BETWEEN\s+16\s+AND\s+64/i.test(all) ||
          (/length\(code\)\s*>=\s*16/i.test(all) && /length\(code\)\s*<=\s*64/i.test(all)),
      );
    }

    // --- M7 #8 invariants -------------------------------------------

    // (91) llm_npc_interactions table exists.
    {
      record(
        'table llm_npc_interactions exists',
        await tableExists(client, 'llm_npc_interactions'),
      );
    }

    // (92) llm_npc_interactions.archetype CHECK.
    {
      const cs = await checks('llm_npc_interactions');
      const all = cs.join('\n');
      record(
        'llm_npc_interactions.archetype in allowed set',
        /ai_agent.*sleuth/is.test(all) || /sleuth.*ai_agent/is.test(all),
      );
    }

    // (93) llm_npc_interactions.prompt_tokens >= 0.
    {
      const cs = await checks('llm_npc_interactions');
      const all = cs.join('\n');
      record('llm_npc_interactions.prompt_tokens >= 0', /prompt_tokens\s*>=\s*0/i.test(all));
    }

    // (94) llm_npc_interactions.completion_tokens >= 0.
    {
      const cs = await checks('llm_npc_interactions');
      const all = cs.join('\n');
      record(
        'llm_npc_interactions.completion_tokens >= 0',
        /completion_tokens\s*>=\s*0/i.test(all),
      );
    }

    // --- M7 #9 invariants -------------------------------------------

    // (95) x_links table exists.
    {
      record('table x_links exists', await tableExists(client, 'x_links'));
    }

    // (96) x_links.user_id UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.x_links'::regclass
           AND i.indisunique
           AND a.attname = 'user_id'`,
      );
      record('x_links.user_id UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (97) x_links.x_user_id UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.x_links'::regclass
           AND i.indisunique
           AND a.attname = 'x_user_id'`,
      );
      record('x_links.x_user_id UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (98) x_links.state UNIQUE.
    {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = 'public.x_links'::regclass
           AND i.indisunique
           AND a.attname = 'state'`,
      );
      record('x_links.state UNIQUE', Number(r.rows[0]?.count ?? '0') > 0);
    }

    // (99) x_links.x_handle length 1..32.
    {
      const cs = await checks('x_links');
      const all = cs.join('\n');
      record(
        'x_links.x_handle length 1..32',
        /length\(x_handle\)\s+BETWEEN\s+1\s+AND\s+32/i.test(all) ||
          (/length\(x_handle\)\s*>=\s*1/i.test(all) && /length\(x_handle\)\s*<=\s*32/i.test(all)),
      );
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
