/**
 * Boards service tests (M7 #3).
 *
 * Covers the new scope=friends|league support. The M2 global
 * scope is unchanged. Friends reads the caller's follow list;
 * league reads the caller's current season league cohort.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { BoardsService } from './boards.js';
import { ensureLeagues, runSeasonRollover } from './leagues.js';
import { currentSeasonIso } from './season-clock.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function newUser(alias: string): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `boardsUser-${id}`]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id, age_confirmed_at)
     VALUES ($1, $2, $3, '{}'::jsonb, 'anon', ARRAY[]::text[], 'be_rich', 'studio', now())
     ON CONFLICT (user_id) DO NOTHING`,
    [uuidv7(), id, `${alias}-${id.slice(0, 8)}`],
  );
  return id;
}

async function setBalance(userId: string, cashCents: number): Promise<void> {
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2`,
    [userId, cashCents],
  );
}

async function follow(follower: string, followee: string): Promise<void> {
  await pool.query(
    `INSERT INTO follows (follower_user_id, followee_user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [follower, followee],
  );
}

beforeAll(async () => {
  // Pre-seed leagues so the league-scope tests can find a cohort.
  await pool.query(`DELETE FROM season_rollover_log`);
  await pool.query(`DELETE FROM season_memberships`);
  await pool.query(`DELETE FROM leagues`);
  const ctx = buildContext();
  await ensureLeagues(ctx);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Clean up test users + their balances + follows.
  await pool.query(
    `DELETE FROM follows WHERE follower_user_id IN (SELECT id FROM users WHERE wallet LIKE 'boardsUser-%')`,
  );
  await pool.query(
    `DELETE FROM balances WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'boardsUser-%')`,
  );
  await pool.query(
    `DELETE FROM season_memberships WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'boardsUser-%')`,
  );
  await pool.query(
    `DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'boardsUser-%')`,
  );
  await pool.query(`DELETE FROM users WHERE wallet LIKE 'boardsUser-%'`);
});

describe('boards service', () => {
  it('global scope returns a top-N list (M2 baseline)', async () => {
    const ctx = buildContext();
    const a = await newUser('alpha');
    const b = await newUser('beta');
    // Push them to a high enough net worth that they make the top-N
    // for whatever limit the test uses.
    await setBalance(a, 999_999_999_999);
    await setBalance(b, 999_999_999_998);
    const svc = new BoardsService(ctx);
    const entries = await svc.top('net_worth', 'global', 10000, a);
    const ids = entries.map((e) => e.userId);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    // Our 2 test users should be at the top of the list.
    expect(entries[0]!.userId).toBe(a);
    expect(entries[1]!.userId).toBe(b);
  });

  it('friends scope restricts the top-N to the caller + follows', async () => {
    const ctx = buildContext();
    const me = await newUser('me');
    const friend1 = await newUser('f1');
    const friend2 = await newUser('f2');
    const stranger = await newUser('stranger');
    await setBalance(me, 1_000);
    await setBalance(friend1, 2_000);
    await setBalance(friend2, 3_000);
    await setBalance(stranger, 9_999_999);
    await follow(me, friend1);
    await follow(me, friend2);
    const svc = new BoardsService(ctx);
    const entries = await svc.top('net_worth', 'friends', 50, me);
    const ids = entries.map((e) => e.userId);
    expect(ids).toContain(me);
    expect(ids).toContain(friend1);
    expect(ids).toContain(friend2);
    expect(ids).not.toContain(stranger);
    // The stranger has more cash but is not in the cohort.
  });

  it('friends scope with zero follows returns just the caller', async () => {
    const ctx = buildContext();
    const me = await newUser('solo');
    await setBalance(me, 1_000);
    const svc = new BoardsService(ctx);
    const entries = await svc.top('net_worth', 'friends', 50, me);
    expect(entries.length).toBe(1);
    expect(entries[0]!.userId).toBe(me);
  });

  it('league scope restricts the top-N to the league cohort', async () => {
    const ctx = buildContext();
    const me = await newUser('me');
    const cohortMate1 = await newUser('c1');
    const cohortMate2 = await newUser('c2');
    const outsider = await newUser('out');
    // me, c1, c2 land in iron (cash < 100_000). The outsider
    // has 1M cash so they land in silver and are NOT in the
    // iron cohort.
    await setBalance(me, 50_000);
    await setBalance(cohortMate1, 30_000);
    await setBalance(cohortMate2, 20_000);
    await setBalance(outsider, 1_000_000);
    // Run the rollover for the current season.
    await runSeasonRollover(ctx, currentSeasonIso());
    const svc = new BoardsService(ctx);
    const entries = await svc.top('net_worth', 'league', 10000, me);
    const ids = entries.map((e) => e.userId);
    expect(ids).toContain(me);
    expect(ids).toContain(cohortMate1);
    expect(ids).toContain(cohortMate2);
    expect(ids).not.toContain(outsider);
  });

  it('league scope with no membership returns just the caller', async () => {
    const ctx = buildContext();
    const me = await newUser('me');
    // No balance, no membership.
    const svc = new BoardsService(ctx);
    const entries = await svc.top('net_worth', 'league', 50, me);
    expect(entries.length).toBe(1);
    expect(entries[0]!.userId).toBe(me);
  });

  it('throws ValidationFailedError on unknown boardId', async () => {
    const ctx = buildContext();
    const me = await newUser('me');
    const svc = new BoardsService(ctx);
    await expect(svc.top('unknown', 'global', 50, me)).rejects.toBeInstanceOf(
      (await import('../shared/domain/errors.js')).ValidationFailedError,
    );
  });

  it('throws ValidationFailedError on friends scope with no caller', async () => {
    const ctx = buildContext();
    const svc = new BoardsService(ctx);
    await expect(svc.top('net_worth', 'friends', 50)).rejects.toBeInstanceOf(
      (await import('../shared/domain/errors.js')).ValidationFailedError,
    );
  });
});
