/**
 * Tribes + district service tests (M7 #1).
 *
 * Covers: ensureDistricts seeds one row per tribe home-turf +
 * the two extra districts, listTribes / getTribe / listDistricts
 * / getDistrict / getDistrictOwner, rollDailyDistrict flips
 * ownership when a new tribe outscores the current one, history
 * rows are inserted with valid_to NULL, prior history rows close
 * with valid_to = now, and a re-run within the same day is a
 * no-op.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { NotFoundError, ValidationFailedError, ForbiddenError } from '../shared/domain/errors.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  // Make sure the districts + scores + history tables are empty
  // before the first test runs.
  await pool.query(`DELETE FROM district_ownership_history`);
  await pool.query(`DELETE FROM tribe_district_scores`);
  await pool.query(`DELETE FROM districts`);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM district_ownership_history`);
  await pool.query(`DELETE FROM tribe_district_scores`);
  await pool.query(`DELETE FROM districts`);
});

describe('tribes service', () => {
  it('ensureDistricts seeds one row per tribe + the two extras', async () => {
    const ctx = buildContext();
    const { ensureDistricts } = await import('./tribes.js');
    await ensureDistricts(ctx);
    const r = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM districts`);
    // 7 tribes + 2 extras (marina_villa, cabal_lounge) = 9
    expect(Number(r.rows[0]?.count ?? '0')).toBe(9);
  });

  it('ensureDistricts is idempotent on re-run', async () => {
    const ctx = buildContext();
    const { ensureDistricts } = await import('./tribes.js');
    await ensureDistricts(ctx);
    await ensureDistricts(ctx);
    const r = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM districts`);
    expect(Number(r.rows[0]?.count ?? '0')).toBe(9);
  });

  it('listTribes returns every tribe with ownedDistricts', async () => {
    const ctx = buildContext();
    const { ensureDistricts, listTribes } = await import('./tribes.js');
    await ensureDistricts(ctx);
    const rows = await listTribes(ctx);
    expect(rows.length).toBe(7);
    for (const t of rows) {
      expect(t.tribeId).toMatch(/.+/);
      expect(t.name).toMatch(/.+/);
      expect(t.homeTurf).toMatch(/.+/);
      expect(t.ownedDistricts.length).toBeGreaterThan(0);
    }
  });

  it('getTribe on unknown id throws NotFoundError', async () => {
    const ctx = buildContext();
    const { ensureDistricts, getTribe } = await import('./tribes.js');
    await ensureDistricts(ctx);
    await expect(getTribe(ctx, 'nope_nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listDistricts returns every district in slug order', async () => {
    const ctx = buildContext();
    const { ensureDistricts, listDistricts } = await import('./tribes.js');
    await ensureDistricts(ctx);
    const rows = await listDistricts(ctx);
    expect(rows.length).toBe(9);
    const slugs = rows.map((d) => d.slug);
    expect(slugs).toEqual([...slugs].sort());
  });

  it('getDistrict on unknown id throws NotFoundError', async () => {
    const ctx = buildContext();
    const { ensureDistricts, getDistrict } = await import('./tribes.js');
    await ensureDistricts(ctx);
    await expect(getDistrict(ctx, 'nope_nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('getDistrictOwner returns the seeded default owner on a fresh install', async () => {
    const ctx = buildContext();
    const { ensureDistricts, getDistrictOwner } = await import('./tribes.js');
    await ensureDistricts(ctx);
    const owner = await getDistrictOwner(ctx, 'marina_villa');
    expect(owner?.tribeId).toBe('trencher');
    expect(owner?.previousTribeId).toBeNull();
  });

  it('rollDailyDistrict flips ownership when a new tribe outscores the current one', async () => {
    const ctx = buildContext();
    const { ensureDistricts, rollDailyDistrict, getDistrictOwner } = await import('./tribes.js');
    await ensureDistricts(ctx);
    const dayDate = '2026-10-06';
    const now = new Date(`${dayDate}T00:05:00Z`);
    // perp_pit's default holder is perp_degen (per contract/ids/tribes.json).
    // airdrop_farmer outscores.
    const scores = new Map<string, Map<string, number>>();
    scores.set(
      'perp_pit',
      new Map([
        ['perp_degen', 50],
        ['airdrop_farmer', 200],
      ]),
    );
    const r = await rollDailyDistrict(dayDate, scores, now);
    expect(r.changed).toBe(1);
    const owner = await getDistrictOwner(ctx, 'perp_pit');
    expect(owner?.tribeId).toBe('airdrop_farmer');
    expect(owner?.previousTribeId).toBe('perp_degen');
  });

  it('rollDailyDistrict is idempotent on re-run within the same day', async () => {
    const ctx = buildContext();
    const { ensureDistricts, rollDailyDistrict, getDistrictOwner } = await import('./tribes.js');
    await ensureDistricts(ctx);
    const dayDate = '2026-10-06';
    const now = new Date(`${dayDate}T00:05:00Z`);
    const scores = new Map<string, Map<string, number>>();
    scores.set('perp_pit', new Map([['airdrop_farmer', 200]]));
    const first = await rollDailyDistrict(dayDate, scores, now);
    const second = await rollDailyDistrict(dayDate, scores, now);
    expect(first.changed).toBe(1);
    expect(second.changed).toBe(0);
    const owner = await getDistrictOwner(ctx, 'perp_pit');
    expect(owner?.tribeId).toBe('airdrop_farmer');
  });

  it('rollDailyDistrict keeps the existing owner when the new score does not beat them', async () => {
    const ctx = buildContext();
    const { ensureDistricts, rollDailyDistrict, getDistrictOwner } = await import('./tribes.js');
    await ensureDistricts(ctx);
    const dayDate = '2026-10-06';
    const now = new Date(`${dayDate}T00:05:00Z`);
    // perp_pit default holder is perp_degen. anon scores 30, which is
    // less than the default's base_score_per_day (50).
    const scores = new Map<string, Map<string, number>>();
    scores.set(
      'perp_pit',
      new Map([
        ['anon', 30],
        ['perp_degen', 50],
      ]),
    );
    const r = await rollDailyDistrict(dayDate, scores, now);
    expect(r.changed).toBe(0);
    const owner = await getDistrictOwner(ctx, 'perp_pit');
    expect(owner?.tribeId).toBe('perp_degen');
  });

  it('rollDailyDistrict rejects malformed dayDate', async () => {
    const ctx = buildContext();
    const { ensureDistricts, rollDailyDistrict } = await import('./tribes.js');
    await ensureDistricts(ctx);
    const scores = new Map<string, Map<string, number>>();
    await expect(rollDailyDistrict('not-a-date', scores)).rejects.toThrow();
  });

  it('rollDailyDistrict closes the prior history row when ownership flips', async () => {
    const ctx = buildContext();
    const { ensureDistricts, rollDailyDistrict } = await import('./tribes.js');
    await ensureDistricts(ctx);
    const dayDate = '2026-10-06';
    const first = new Date(`${dayDate}T00:05:00Z`);
    const second = new Date(`${dayDate}T00:10:00Z`);
    // First roll: airdrop_farmer takes perp_pit.
    const s1 = new Map<string, Map<string, number>>();
    s1.set('perp_pit', new Map([['airdrop_farmer', 200]]));
    await rollDailyDistrict(dayDate, s1, first);
    // Second roll (same day, later): anon retakes perp_pit.
    const s2 = new Map<string, Map<string, number>>();
    s2.set('perp_pit', new Map([['anon', 300]]));
    const r = await rollDailyDistrict(dayDate, s2, second);
    // Same day, but anon outscores the existing owner — second
    // roll does NOT flip because the prior roll's score stays in
    // place (UNIQUE on (tribe_id, district_id, day_date) DO UPDATE).
    // anon now has 300 > airdrop_farmer 200, so the second roll
    // should flip ownership.
    expect(r.changed).toBe(1);
    const r2 = await pool.query<{ valid_to: Date | null }>(
      `SELECT valid_to FROM district_ownership_history
       WHERE district_id = 'perp_pit' AND tribe_id = 'airdrop_farmer'
       ORDER BY valid_from DESC LIMIT 1`,
    );
    expect(r2.rows[0]?.valid_to).not.toBeNull();
  });

  // --- M7 #4: tribe change once per season --------------------------

  describe('changeTribe', () => {
    async function newCharUser(): Promise<string> {
      const id = uuidv7();
      await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
        id,
        `tribeChangeUser-${id}`,
      ]);
      await pool.query(
        `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
         VALUES ($1, $2, $3, '{}'::jsonb, 'anon', ARRAY[]::text[], 'be_rich', 'studio')
         ON CONFLICT (user_id) DO NOTHING`,
        [uuidv7(), id, `tribe-${id.slice(0, 8)}`],
      );
      return id;
    }

    beforeEach(async () => {
      await pool.query(
        `DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE wallet LIKE 'tribeChangeUser-%')`,
      );
      await pool.query(`DELETE FROM users WHERE wallet LIKE 'tribeChangeUser-%'`);
    });

    it('allows the first-ever tribe change', async () => {
      const ctx = buildContext();
      const { changeTribe } = await import('./tribes.js');
      const userId = await newCharUser();
      const out = await changeTribe(ctx, userId, 'perp_degen');
      expect(out.tribeId).toBe('perp_degen');
    });

    it('refuses the second change in the same ISO-8601 week', async () => {
      const ctx = buildContext();
      const { changeTribe } = await import('./tribes.js');
      const userId = await newCharUser();
      const now = new Date('2026-10-06T00:00:00Z');
      await changeTribe(ctx, userId, 'perp_degen', now);
      await expect(changeTribe(ctx, userId, 'trencher', now)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('allows a new change in a new ISO-8601 week', async () => {
      const ctx = buildContext();
      const { changeTribe } = await import('./tribes.js');
      const userId = await newCharUser();
      const first = new Date('2026-10-06T00:00:00Z'); // 2026-W41
      const next = new Date('2026-10-12T00:00:00Z'); // 2026-W42 (Monday)
      await changeTribe(ctx, userId, 'perp_degen', first);
      const out = await changeTribe(ctx, userId, 'trencher', next);
      expect(out.tribeId).toBe('trencher');
    });

    it('refuses an unknown tribe id', async () => {
      const ctx = buildContext();
      const { changeTribe } = await import('./tribes.js');
      const userId = await newCharUser();
      await expect(changeTribe(ctx, userId, 'mythic_9999')).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
    });

    it('refuses the same tribe the caller is already in', async () => {
      const ctx = buildContext();
      const { changeTribe } = await import('./tribes.js');
      const userId = await newCharUser();
      await expect(changeTribe(ctx, userId, 'anon')).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
    });

    it('refuses when the user has no character', async () => {
      const ctx = buildContext();
      const { changeTribe } = await import('./tribes.js');
      const userId = uuidv7();
      await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
        userId,
        `noCharUser-${userId}`,
      ]);
      await expect(changeTribe(ctx, userId, 'perp_degen')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // silence the unused-uuid warning
  void uuidv7;
});
