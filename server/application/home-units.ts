/**
 * Home units: the enterable doors behind a home lease.
 *
 * A unit is one door in the world (`flat:<buildingInstanceId>:<doorIndex>`),
 * listed by the frontend in `contract/ids/home_units.json` and upserted
 * into `home_units`. A lease takes a free unit of its tier; the unit
 * stays held while the home is active or overdue and is free again once
 * the home is moved out or evicted.
 *
 *   GET /v1/units/{unitId}/access  — { canEnter, reason } for the caller
 *
 * Access: the owner and the owner's guests of a live home can enter. An
 * evicted owner cannot. Everyone else meets a locked door. The answer is
 * only ever about the caller; it never names the occupant.
 *
 * A tier with no units in the file keeps the old behaviour: the lease
 * succeeds with no door (`unitId` null) and the home is open to visitors.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Db } from '../shared/db/pool.js';
import { NotFoundError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

/**
 * Presence channel the API and the rent worker publish `{ homeId }` on
 * when somebody may have lost the door (guest removed, move-out, eviction).
 * The `home` room re-checks its clients on it.
 */
export const HOME_ACCESS_CHANNEL = 'ctl:home_access';

export type HomeTier = 'basement' | 'flat' | 'penthouse';

/** Status values of a home; active and overdue hold their unit. */
export type HomeStatus = 'active' | 'overdue' | 'evicted' | 'moved_out';

export type AccessReason = 'owner' | 'guest' | 'locked' | 'vacant' | 'evicted';

export interface UnitAccess {
  readonly canEnter: boolean;
  readonly reason: AccessReason;
}

const UnitFile = z.object({
  units: z.array(
    z.object({
      unitId: z.string().min(1),
      district: z.string().min(1),
      tier: z.enum(['basement', 'flat', 'penthouse']),
      roomType: z.string().min(1),
      weeklyRentCents: z.number().int().positive(),
      capacity: z.number().int().positive(),
    }),
  ),
});

let synced: Promise<number> | null = null;

/**
 * Upsert `contract/ids/home_units.json` into `home_units`, once per
 * process. Units dropped from the file are left in the table so a leased
 * door is never pulled from under a tenant.
 * @param db - The database handle.
 */
export async function ensureUnitsSynced(db: Db): Promise<void> {
  synced ??= syncHomeUnits(db).catch((e: unknown) => {
    synced = null; // retry on the next call
    throw e;
  });
  await synced;
}

/**
 * Re-read the file on the next call (tests, and after the file changes).
 */
export function _resetUnitsSyncForTests(): void {
  synced = null;
}

/**
 * Upsert the units file into `home_units`.
 * @param db - The database handle.
 * @returns How many units the file lists.
 */
export async function syncHomeUnits(db: Db): Promise<number> {
  const raw: unknown = JSON.parse(
    readFileSync(join(process.cwd(), 'contract', 'ids', 'home_units.json'), 'utf8'),
  );
  const file = UnitFile.parse(raw);
  await db.withConnection(async (c) => {
    for (const u of file.units) {
      await c.query(
        `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents, capacity)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (unit_id) DO UPDATE
           SET district = EXCLUDED.district, tier = EXCLUDED.tier, room_type = EXCLUDED.room_type,
               weekly_rent_cents = EXCLUDED.weekly_rent_cents, capacity = EXCLUDED.capacity`,
        [u.unitId, u.district, u.tier, u.roomType, u.weeklyRentCents, u.capacity],
      );
    }
  });
  return file.units.length;
}

/**
 * Pick a free unit of a tier and lock it for this transaction.
 * @param client - The transaction client.
 * @param tier - The home tier to house.
 * @returns The unit id; null when the tier has no units at all (a
 *   unit-less home); 'full' when it has units but all are taken.
 */
export async function takeFreeUnit(
  client: PoolClient,
  tier: HomeTier,
): Promise<string | null | 'full'> {
  const any = await client.query(`SELECT 1 FROM home_units WHERE tier = $1 LIMIT 1`, [tier]);
  if (any.rowCount === 0) return null;
  const free = await client.query<{ unit_id: string }>(
    `SELECT u.unit_id FROM home_units u
      WHERE u.tier = $1
        AND NOT EXISTS (SELECT 1 FROM homes h
                         WHERE h.unit_id = u.unit_id AND h.status IN ('active', 'overdue'))
      ORDER BY u.unit_id
      LIMIT 1
        FOR UPDATE OF u SKIP LOCKED`,
    [tier],
  );
  return free.rows[0]?.unit_id ?? 'full';
}

/**
 * Whether a user may enter a home's door, from the home row's facts.
 * @param c - A client.
 * @param home - The home (id, owner, status and unit).
 * @param userId - The caller.
 * @returns The access verdict.
 */
export async function accessToHome(
  c: Pick<PoolClient, 'query'>,
  home: { homeId: string; ownerUserId: string; status: HomeStatus },
  userId: string,
): Promise<UnitAccess> {
  if (home.status === 'evicted' && home.ownerUserId === userId) {
    return { canEnter: false, reason: 'evicted' };
  }
  if (home.status === 'evicted' || home.status === 'moved_out') {
    return { canEnter: false, reason: 'locked' };
  }
  if (home.ownerUserId === userId) return { canEnter: true, reason: 'owner' };
  const g = await c.query(`SELECT 1 FROM home_guests WHERE home_id = $1 AND user_id = $2`, [
    home.homeId,
    userId,
  ]);
  return g.rowCount ? { canEnter: true, reason: 'guest' } : { canEnter: false, reason: 'locked' };
}

/**
 * Can this user walk through this unit's door?
 * @param ctx - The app context.
 * @param unitId - The door id.
 * @param userId - The caller.
 * @returns The verdict about the caller only.
 */
export async function unitAccess(
  ctx: AppContext,
  unitId: string,
  userId: string,
): Promise<UnitAccess> {
  return ctx.db.withConnection(async (c) => {
    const u = await c.query(`SELECT 1 FROM home_units WHERE unit_id = $1`, [unitId]);
    if (u.rowCount === 0) throw new NotFoundError({ resource: 'unit', id: unitId });
    const live = await c.query<{ home_id: string; owner_user_id: string; status: HomeStatus }>(
      `SELECT home_id, owner_user_id, status FROM homes
        WHERE unit_id = $1 AND status IN ('active', 'overdue')`,
      [unitId],
    );
    const h = live.rows[0];
    if (h) {
      return accessToHome(
        c,
        { homeId: h.home_id, ownerUserId: h.owner_user_id, status: h.status },
        userId,
      );
    }
    // Nobody lives there. Tell a former tenant why the door is shut.
    const gone = await c.query(
      `SELECT 1 FROM homes WHERE unit_id = $1 AND owner_user_id = $2 AND status = 'evicted'
        ORDER BY ended_at DESC LIMIT 1`,
      [unitId, userId],
    );
    return { canEnter: false, reason: gone.rowCount ? 'evicted' : 'vacant' };
  });
}

/**
 * Tell the `home` room that access to a home may have changed. Best
 * effort: the room also re-checks on a timer, so a lost message only delays
 * the disconnect.
 * @param redis - Anything with a Redis `publish`.
 * @param homeId - The home whose access changed.
 */
export async function publishHomeAccess(
  redis: { publish(channel: string, message: string): Promise<unknown> },
  homeId: string,
): Promise<void> {
  try {
    await redis.publish(HOME_ACCESS_CHANNEL, JSON.stringify({ homeId }));
  } catch {
    // The room's interval re-check covers a missed publish.
  }
}
