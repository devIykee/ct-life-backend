/**
 * Home units (doors): lease assigns one, a full tier refuses, move-out and
 * eviction free it, access for owner / guest / stranger / evicted owner,
 * visit returns the room or 403, guests are owner-only.
 *
 * Uses its own penthouse units (`test:home_units:*`) so it never competes
 * with the flat doors from contract/ids/home_units.json.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createHome, moveOut, addGuest, removeGuest, recordVisit, loadMeHome } from './homes.js';
import { syncHomeUnits, unitAccess } from './home-units.js';
import { runWeeklyRent } from '../workers/rent.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const UNIT_A = 'test:home_units_a:0';
const UNIT_B = 'test:home_units_b:0';

const ids = {
  owner: uuidv7(),
  owner2: uuidv7(),
  guest: uuidv7(),
  stranger: uuidv7(),
  late: uuidv7(),
};
const all = Object.values(ids);

async function cleanup(): Promise<void> {
  await pool.query(
    `DELETE FROM homes WHERE owner_user_id = ANY($1::uuid[]) OR unit_id LIKE 'test:home_units_%'`,
    [all],
  );
  await pool.query(`DELETE FROM home_units WHERE unit_id LIKE 'test:home_units_%'`);
}

beforeAll(async () => {
  await cleanup();
  for (const id of all) {
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `hu-${id}`]);
    await pool.query(
      `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 1000000, 0)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = 1000000, debt_cents = 0`,
      [id],
    );
  }
  await pool.query(
    `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents, capacity)
     VALUES ($1, 'residences', 'penthouse', 'test_room', 150000, 2),
            ($2, 'residences', 'penthouse', 'test_room', 150000, 1)`,
    [UNIT_A, UNIT_B],
  );
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('home units', () => {
  const ctx = buildContext();

  it('seeds the flat doors from contract/ids/home_units.json', async () => {
    const n = await syncHomeUnits(ctx.db);
    expect(n).toBeGreaterThanOrEqual(6);
    const r = await pool.query<{ unit_id: string }>(
      `SELECT unit_id FROM home_units WHERE tier = 'flat' AND unit_id LIKE 'flat:%'`,
    );
    expect(r.rows.map((x) => x.unit_id)).toContain('flat:midrise_01:0');
  });

  let ownerHome: Awaited<ReturnType<typeof createHome>>;

  it('lease assigns a free unit of the matching tier', async () => {
    ownerHome = await createHome(ctx, ids.owner, 'penthouse');
    expect(ownerHome.unitId).toBe(UNIT_A);
    expect(ownerHome.tier).toBe('penthouse');
    expect(ownerHome.roomType).toBe('test_room');
    expect(ownerHome.status).toBe('active');
    expect(ownerHome.missedWeeks).toBe(0);
    const me = await ctx.db.withConnection((c) => loadMeHome(c, ids.owner));
    expect(me).toEqual({
      homeId: ownerHome.homeId,
      unitId: UNIT_A,
      tier: 'penthouse',
      roomType: 'test_room',
      status: 'active',
      missedWeeks: 0,
    });
  });

  it('refuses with NO_FREE_UNIT when every unit of the tier is held', async () => {
    const second = await createHome(ctx, ids.owner2, 'marina_villa');
    expect(second.unitId).toBe(UNIT_B);
    const before = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [ids.late],
    );
    await expect(createHome(ctx, ids.late, 'penthouse')).rejects.toMatchObject({
      code: 'NO_FREE_UNIT',
      httpStatus: 409,
    });
    const after = await pool.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1`,
      [ids.late],
    );
    expect(after.rows[0]?.cash_cents).toBe(before.rows[0]?.cash_cents);
    const homes = await pool.query(`SELECT 1 FROM homes WHERE owner_user_id = $1`, [ids.late]);
    expect(homes.rowCount).toBe(0);
  });

  it('a tier with no doors still leases, without a unit', async () => {
    const h = await createHome(ctx, ids.late, 'parents_basement');
    expect(h.unitId).toBeNull();
    expect(h.tier).toBe('basement');
    expect(h.status).toBe('active');
    await pool.query(`DELETE FROM homes WHERE home_id = $1`, [h.homeId]);
  });

  it('access: owner and guest enter; stranger and evicted owner do not', async () => {
    expect(await unitAccess(ctx, UNIT_A, ids.owner)).toEqual({ canEnter: true, reason: 'owner' });
    expect(await unitAccess(ctx, UNIT_A, ids.stranger)).toEqual({
      canEnter: false,
      reason: 'locked',
    });
    await addGuest(ctx, ownerHome.homeId, ids.owner, ids.guest);
    expect(await unitAccess(ctx, UNIT_A, ids.guest)).toEqual({ canEnter: true, reason: 'guest' });
    await expect(unitAccess(ctx, 'nope:nope:0', ids.owner)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // Evicted: the owner loses the door, and so does the guest.
    await pool.query(`UPDATE homes SET status = 'evicted', ended_at = now() WHERE home_id = $1`, [
      ownerHome.homeId,
    ]);
    expect(await unitAccess(ctx, UNIT_A, ids.owner)).toEqual({
      canEnter: false,
      reason: 'evicted',
    });
    expect(await unitAccess(ctx, UNIT_A, ids.guest)).toEqual({ canEnter: false, reason: 'vacant' });
    const me = await ctx.db.withConnection((c) => loadMeHome(c, ids.owner));
    expect(me?.status).toBe('evicted');
    expect(me?.unitId).toBeNull();
    await pool.query(`UPDATE homes SET status = 'active', ended_at = NULL WHERE home_id = $1`, [
      ownerHome.homeId,
    ]);
  });

  it('visit returns the room to the owner and guests, 403 to a stranger', async () => {
    const guestVisit = await recordVisit(ctx, ids.owner, ids.guest);
    expect(guestVisit.unitId).toBe(UNIT_A);
    expect(guestVisit.roomType).toBe('test_room');
    expect(guestVisit.homeId).toBe(ownerHome.homeId);
    const ownVisit = await recordVisit(ctx, ids.owner, ids.owner);
    expect(ownVisit.unitId).toBe(UNIT_A);
    await expect(recordVisit(ctx, ids.owner, ids.stranger)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      httpStatus: 403,
    });
    const logged = await pool.query(
      `SELECT 1 FROM home_visits WHERE home_id = $1 AND visitor_user_id = $2`,
      [ownerHome.homeId, ids.stranger],
    );
    expect(logged.rowCount).toBe(0);
  });

  it('guests: only the owner adds or removes; capacity is enforced', async () => {
    await expect(addGuest(ctx, ownerHome.homeId, ids.stranger, ids.stranger)).rejects.toMatchObject(
      { code: 'NOT_HOME_OWNER', httpStatus: 403 },
    );
    await expect(addGuest(ctx, ownerHome.homeId, ids.stranger, ids.late)).rejects.toMatchObject({
      code: 'NOT_HOME_OWNER',
    });
    await expect(removeGuest(ctx, ownerHome.homeId, ids.guest, ids.guest)).rejects.toMatchObject({
      code: 'NOT_HOME_OWNER',
    });
    // The guest is still in.
    expect((await unitAccess(ctx, UNIT_A, ids.guest)).canEnter).toBe(true);
    // Capacity 2 = owner + one guest.
    await expect(addGuest(ctx, ownerHome.homeId, ids.owner, ids.late)).rejects.toMatchObject({
      code: 'UNIT_FULL',
      httpStatus: 409,
    });
    // Adding the existing guest again is a no-op, not UNIT_FULL.
    const again = await addGuest(ctx, ownerHome.homeId, ids.owner, ids.guest);
    expect(again.guests).toEqual([ids.guest]);
    await expect(addGuest(ctx, ownerHome.homeId, ids.owner, ids.owner)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const removed = await removeGuest(ctx, ownerHome.homeId, ids.owner, ids.guest);
    expect(removed.guests).toEqual([]);
    expect((await unitAccess(ctx, UNIT_A, ids.guest)).canEnter).toBe(false);
  });

  it('move-out is owner-only and frees the unit for the next lease', async () => {
    await expect(moveOut(ctx, ownerHome.homeId, ids.stranger)).rejects.toMatchObject({
      code: 'NOT_HOME_OWNER',
    });
    const out = await moveOut(ctx, ownerHome.homeId, ids.owner);
    expect(out.status).toBe('moved_out');
    expect(out.unitId).toBeNull();
    expect((await unitAccess(ctx, UNIT_A, ids.owner)).canEnter).toBe(false);
    // Moving out twice is fine.
    expect((await moveOut(ctx, ownerHome.homeId, ids.owner)).status).toBe('moved_out');
    // The freed unit is leased again.
    const next = await createHome(ctx, ids.late, 'penthouse');
    expect(next.unitId).toBe(UNIT_A);
    // The old owner cannot visit or pay for the ended home.
    await expect(recordVisit(ctx, ids.owner, ids.stranger)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await pool.query(`DELETE FROM homes WHERE home_id = $1`, [next.homeId]);
  });

  it('the rent worker walks active, overdue, evicted and frees the unit', async () => {
    const h = await createHome(ctx, ids.late, 'penthouse');
    expect(h.unitId).toBe(UNIT_A);
    await pool.query(`UPDATE balances SET cash_cents = 0 WHERE user_id = $1`, [ids.late]);
    await runWeeklyRent(ctx.db);
    let row = await pool.query<{ status: string; missed_weeks: number }>(
      `SELECT status, missed_weeks FROM homes WHERE home_id = $1`,
      [h.homeId],
    );
    expect(row.rows[0]).toEqual({ status: 'overdue', missed_weeks: 1 });
    // Overdue still holds the door.
    expect((await unitAccess(ctx, UNIT_A, ids.late)).canEnter).toBe(true);
    for (let i = 0; i < 3; i++) await runWeeklyRent(ctx.db);
    row = await pool.query(`SELECT status, missed_weeks FROM homes WHERE home_id = $1`, [h.homeId]);
    expect(row.rows[0]).toEqual({ status: 'evicted', missed_weeks: 4 });
    expect(await unitAccess(ctx, UNIT_A, ids.late)).toEqual({ canEnter: false, reason: 'evicted' });
    // Evicted homes owe nothing more and the door can be let again.
    const next = await createHome(ctx, ids.stranger, 'penthouse');
    expect(next.unitId).toBe(UNIT_A);
  });
});
