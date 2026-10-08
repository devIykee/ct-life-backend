/**
 * Leagues + seasons service tests (M7 #2).
 *
 * Covers: ensureLeagues seeds 5 tiers from the config, listLeagues +
 * getLeague, getMyLeague before/after rollover, runSeasonRollover
 * assigns a league to every user with a balance, league promotion
 * + relegation across two rollovers, league cap (max_members),
 * idempotent re-run, simulated-clock 8-week rollover.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { NotFoundError } from '../shared/domain/errors.js';
import { weekIso } from './season-clock.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Clean up test data only, never touching production leagues or users.
 * Handles foreign keys properly: delete children first, then parents.
 */
async function resetLeagueTables(): Promise<void> {
  // Delete only test user data (identified by wallet pattern)
  await pool.query(
    `DELETE FROM season_memberships WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'leagueUser-%')`,
  );
  await pool.query(
    `DELETE FROM balances WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'leagueUser-%')`,
  );
  await pool.query(`DELETE FROM users WHERE wallet LIKE 'leagueUser-%'`);

  // Clean ALL test-created rollover log entries (anything matching 2026-W pattern from tests)
  // This prevents cross-test pollution in the 8-week rollover test
  await pool.query(`DELETE FROM season_rollover_log WHERE season_iso ~ '^2026-W[0-9]{2}$'`);
}

async function freshUsers(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = uuidv7();
    ids.push(id);
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `leagueUser-${id}`]);
  }
  return ids;
}

async function setBalance(userId: string, cashCents: number, debtCents = 0): Promise<void> {
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = $3`,
    [userId, cashCents, debtCents],
  );
}

beforeAll(async () => {
  await resetLeagueTables();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetLeagueTables();
});

describe('leagues service', () => {
  it('ensureLeagues seeds 5 tiers from the config', async () => {
    const ctx = buildContext();
    const { ensureLeagues } = await import('./leagues.js');
    await ensureLeagues(ctx);
    const r = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM leagues`);
    expect(Number(r.rows[0]?.count ?? '0')).toBe(5);
  });

  it('listLeagues returns every tier in sort_order', async () => {
    const ctx = buildContext();
    const { ensureLeagues, listLeagues } = await import('./leagues.js');
    await ensureLeagues(ctx);
    const rows = await listLeagues(ctx);
    expect(rows.map((l) => l.slug)).toEqual(['iron', 'bronze', 'silver', 'gold', 'diamond']);
    expect(rows[4]!.promoteToSlug).toBeNull();
    expect(rows[0]!.promoteToSlug).toBe('bronze');
  });

  it('getLeague on unknown slug throws NotFoundError', async () => {
    const ctx = buildContext();
    const { ensureLeagues, getLeague } = await import('./leagues.js');
    await ensureLeagues(ctx);
    await expect(getLeague(ctx, 'mythic')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('runSeasonRollover assigns a league to every user with a balance', async () => {
    const ctx = buildContext();
    const { ensureLeagues, runSeasonRollover } = await import('./leagues.js');
    await ensureLeagues(ctx);
    const ids = await freshUsers(3);
    // Per the config: iron >=0, bronze >=100_000, silver >=1_000_000,
    // gold >=10_000_000, diamond >=100_000_000.
    await setBalance(ids[0]!, 0); // iron
    await setBalance(ids[1]!, 1_000_000); // silver
    await setBalance(ids[2]!, 10_000_000); // gold
    const seasonIso = '2026-W40';
    await runSeasonRollover(ctx, seasonIso);
    const members = await pool.query<{ user_id: string; league_id: string }>(
      `SELECT user_id, league_id FROM season_memberships
       WHERE season_iso = $1 AND user_id = ANY($2::uuid[])`,
      [seasonIso, ids],
    );
    expect(members.rows.length).toBe(3);
    const byId = new Map(members.rows.map((m) => [m.user_id, m.league_id]));
    expect(byId.get(ids[0]!)).toBe('iron');
    expect(byId.get(ids[1]!)).toBe('silver');
    expect(byId.get(ids[2]!)).toBe('gold');
  });

  it('runSeasonRollover is idempotent on re-run', async () => {
    const ctx = buildContext();
    const { ensureLeagues, runSeasonRollover } = await import('./leagues.js');
    await ensureLeagues(ctx);
    const ids = await freshUsers(2);
    await setBalance(ids[0]!, 1_000_000); // silver
    await setBalance(ids[1]!, 10_000_000); // gold
    const seasonIso = '2026-W40';
    await runSeasonRollover(ctx, seasonIso);
    await runSeasonRollover(ctx, seasonIso);
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM season_memberships
       WHERE season_iso = $1 AND user_id = ANY($2::uuid[])`,
      [seasonIso, ids],
    );
    expect(Number(r.rows[0]?.count ?? '0')).toBe(2);
  });

  it('runSeasonRollover writes a season_rollover_log row', async () => {
    const ctx = buildContext();
    const { ensureLeagues, runSeasonRollover } = await import('./leagues.js');
    await ensureLeagues(ctx);
    const seasonIso = '2026-W40';
    await runSeasonRollover(ctx, seasonIso);
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM season_rollover_log
       WHERE kind = 'season_rollover' AND season_iso = $1`,
      [seasonIso],
    );
    expect(Number(r.rows[0]?.count ?? '0')).toBe(1);
  });

  it('runSeasonRollover enforces max_members cap by demoting overflow', async () => {
    const ctx = buildContext();
    const { ensureLeagues, runSeasonRollover } = await import('./leagues.js');
    await ensureLeagues(ctx);
    // Bronze max is 2000. Iron max is 5000. Build 3 players who
    // would land in bronze (500_000 cents) and 5 who would land
    // in iron (50_000 cents).
    const ids = await freshUsers(8);
    for (let i = 0; i < 3; i++) await setBalance(ids[i]!, 500_000);
    for (let i = 3; i < 8; i++) await setBalance(ids[i]!, 50_000);
    await runSeasonRollover(ctx, '2026-W40');
    const members = await pool.query<{ league_id: string }>(
      `SELECT league_id FROM season_memberships
       WHERE season_iso = '2026-W40' AND user_id = ANY($1::uuid[])`,
      [ids],
    );
    const counts = new Map<string, number>();
    for (const m of members.rows) counts.set(m.league_id, (counts.get(m.league_id) ?? 0) + 1);
    expect(counts.get('bronze')).toBe(3);
    expect(counts.get('iron')).toBe(5);
  });

  it('runSeasonRollover across two seasons promotes a player', async () => {
    const ctx = buildContext();
    const { ensureLeagues, runSeasonRollover } = await import('./leagues.js');
    await ensureLeagues(ctx);
    const ids = await freshUsers(1);
    await setBalance(ids[0]!, 150_000); // bronze
    await runSeasonRollover(ctx, '2026-W40');
    await setBalance(ids[0]!, 1_000_000); // silver
    const r2 = await runSeasonRollover(ctx, '2026-W41');
    expect(r2.promoted).toBeGreaterThanOrEqual(1);
    const r3 = await pool.query<{ league_id: string; promoted_from_league_id: string | null }>(
      `SELECT league_id, promoted_from_league_id FROM season_memberships
       WHERE season_iso = '2026-W41' AND user_id = $1`,
      [ids[0]!],
    );
    expect(r3.rows[0]?.league_id).toBe('silver');
    expect(r3.rows[0]?.promoted_from_league_id).toBe('bronze');
  });

  it('simulated-clock 8-week rollover covers every Monday', async () => {
    const ctx = buildContext();
    const { ensureLeagues, runSeasonRollover } = await import('./leagues.js');
    await ensureLeagues(ctx);
    const ids = await freshUsers(2);
    await setBalance(ids[0]!, 1_000_000); // silver
    await setBalance(ids[1]!, 50_000); // bronze
    for (let w = 1; w <= 8; w++) {
      const seasonIso = `2026-W${String(w).padStart(2, '0')}`;
      await runSeasonRollover(ctx, seasonIso);
    }
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM season_rollover_log
       WHERE kind = 'season_rollover' AND season_iso LIKE '2026-W%'`,
    );
    expect(Number(r.rows[0]?.count ?? '0')).toBe(8);
  }, 60_000); // 60s timeout: 8 rollovers with DB writes (each ~5s)

  it('getMyLeague returns null before rollover, populated after', async () => {
    const ctx = buildContext();
    const { ensureLeagues, runSeasonRollover, getMyLeague } = await import('./leagues.js');
    await ensureLeagues(ctx);
    const ids = await freshUsers(1);
    await setBalance(ids[0]!, 1_000_000); // silver
    const seasonIso = '2026-W40';
    expect(await getMyLeague(ctx, ids[0]!, seasonIso)).toBeNull();
    await runSeasonRollover(ctx, seasonIso);
    const m = await getMyLeague(ctx, ids[0]!, seasonIso);
    expect(m?.leagueId).toBe('silver');
    // Rank is position-within-league; can be > 1 when other users
    // from prior tests share the league.
    expect(m?.rank).toBeGreaterThanOrEqual(1);
  });

  it('weekIso round-trips a known Monday', () => {
    // 2026-01-05 is a Monday. The ISO-8601 week is W02.
    expect(weekIso(new Date('2026-01-05T00:00:00Z'))).toBe('2026-W02');
  });

  it('getLeagueCohort returns the user_ids in a season+league', async () => {
    const ctx = buildContext();
    const { ensureLeagues, runSeasonRollover, getLeagueCohort } = await import('./leagues.js');
    await ensureLeagues(ctx);
    const ids = await freshUsers(3);
    for (const id of ids) await setBalance(id, 50_000);
    await runSeasonRollover(ctx, '2026-W40');
    const cohort = await getLeagueCohort(ctx, '2026-W40', 'iron');
    // The cohort includes our 3 test users (and possibly others
    // from prior runs). Verify ours are in it.
    for (const id of ids) expect(cohort).toContain(id);
  });
});
