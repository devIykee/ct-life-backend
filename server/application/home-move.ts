/**
 * Move home (unlock D1, capability `homeMove`).
 *
 *   POST /v1/homes/move {kind}
 *
 * One transaction: the player gives up every live lease (active or overdue),
 * takes a free unit of the new tier, pays the first week of the new rent and
 * the new lease starts. Either all of that happens or none of it does, so a
 * player is never left with two leases (what `POST /homes` does) or with none
 * after a failed move.
 *
 *   - Moving to the kind you already live in is `409 CONFLICT {reason:'same_home'}`.
 *   - No free unit of the new tier is `409 CONFLICT {reason:'no_unit_free', tier}`.
 *   - Too little Cash for the first week is `402 INSUFFICIENT_CASH {have, need}`.
 *   - Before homes open (LIVE_PHASE < 4) it is `403 FORBIDDEN {reason:'phase_locked'}`.
 *
 * Downsizing works the same way: the cheaper rent is charged for the new
 * week and nothing of the old week is refunded (the old lease simply ends).
 * Debt from missed weeks stays on the balance; moving never clears it.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import { ConflictError, ForbiddenError, InsufficientCashError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import { RENT_BY_KIND, TIER_BY_KIND, getHomeRow, type HomeKind, type HomeRow } from './homes.js';
import { ensureUnitsSynced, publishHomeAccess, takeFreeUnit } from './home-units.js';

/** The release phase that opens homes (`x-phase: 4` in the contract). */
export const HOMES_PHASE = 4;

export interface MoveResult {
  /** The new lease. */
  readonly home: HomeRow;
  /** The lease that ended, or null when the player had no home (street). */
  readonly movedOutHomeId: string | null;
}

/** Lock (creating if needed) the player's balance row and return the Cash. */
async function lockCash(client: PoolClient, userId: string): Promise<bigint> {
  await client.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const r = await client.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  return BigInt(r.rows[0]?.cash_cents ?? '0');
}

/** End every live lease of the player; returns the ended home ids, newest first. */
async function endLiveLeases(
  client: PoolClient,
  userId: string,
  kind: HomeKind,
): Promise<string[]> {
  const live = await client.query<{ home_id: string; kind: HomeKind }>(
    `SELECT home_id, kind FROM homes
      WHERE owner_user_id = $1 AND status IN ('active', 'overdue')
      ORDER BY created_at DESC
        FOR UPDATE`,
    [userId],
  );
  if (live.rows.some((h) => h.kind === kind)) throw new ConflictError({ reason: 'same_home' });
  const ids = live.rows.map((h) => h.home_id);
  if (ids.length === 0) return ids;
  await client.query(
    `UPDATE homes SET status = 'moved_out', ended_at = now() WHERE home_id = ANY($1::text[])`,
    [ids],
  );
  await client.query(`DELETE FROM home_guests WHERE home_id = ANY($1::text[])`, [ids]);
  return ids;
}

/**
 * Move the player into a home of `kind`, atomically.
 * @param ctx - The app context.
 * @param userId - The player moving.
 * @param kind - The home kind to move into.
 * @returns The new lease and the id of the lease that ended.
 */
export async function moveHome(
  ctx: AppContext,
  userId: string,
  kind: HomeKind,
): Promise<MoveResult> {
  if (ctx.config.livePhase < HOMES_PHASE) {
    throw new ForbiddenError({ reason: 'phase_locked', phase: HOMES_PHASE });
  }
  const rent = RENT_BY_KIND[kind];
  const homeId = `home:${uuidv7()}`;
  await ensureUnitsSynced(ctx.db);
  const ended = await runInTransaction(async (client) => {
    // The balance row is the per-player lock: two moves at once serialize here.
    const cash = await lockCash(client, userId);
    const endedIds = await endLiveLeases(client, userId, kind);
    if (cash < BigInt(rent)) {
      throw new InsufficientCashError({ have: cash.toString(), need: rent.toString() });
    }
    // After the old lease ended, so a move inside one tier may reuse its own door.
    const unitId = await takeFreeUnit(client, TIER_BY_KIND[kind]);
    if (unitId === 'full') {
      throw new ConflictError({ reason: 'no_unit_free', tier: TIER_BY_KIND[kind] });
    }
    await client.query(
      `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, last_rent_paid_at, unit_id)
       VALUES ($1, $2, $3, $4, now(), $5)`,
      [homeId, userId, kind, rent, unitId],
    );
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [rent, userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'rent', 'home', $3, $4)`,
      [userId, -rent, homeId, `home-rent-init:${homeId}`],
    );
    return endedIds;
  });
  // Guests standing in the old home are shown out by the home room.
  for (const id of ended) await publishHomeAccess(ctx.redis.main, id);
  return { home: await getHomeRow(ctx, homeId), movedOutHomeId: ended[0] ?? null };
}
