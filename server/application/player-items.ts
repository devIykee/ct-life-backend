/**
 * Owned Duo Shop items and where they stand in a home.
 *
 *   GET /v1/me/items                      — what I own (delivered items)
 *   PUT /v1/homes/{homeId}/placements     — owner sets the home's placements
 *   GET /v1/homes/{homeId}/placements     — owner, guests and anyone who may
 *                                           enter the door read them
 *
 * Items are off-chain (`player_items`, one row per unit), bought with Cash
 * and never tradable. A placement is `{ itemInstanceId, x, z, rotY }`:
 * metres in the home's interior frame and a yaw in radians. The client owns
 * the grid and snapping; the server checks only who may place what.
 *
 * `PUT` replaces the whole set. Each item must be the caller's, placeable,
 * and listed once. An item still standing in a home the caller no longer
 * lives in (moved out, evicted) moves with it; one placed in another live
 * home is refused.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  ForbiddenError,
  ItemAlreadyPlacedError,
  ItemNotOwnedError,
  ItemNotPlaceableError,
  NotFoundError,
  NotHomeOwnerError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import { canEnterHome } from './homes.js';
import { toShopItem, type Footprint, type ShopCategory } from './shop.js';

/** Most items one home can hold. [Inference: tuning value] */
export const MAX_PLACEMENTS_PER_HOME = 200;
/** Largest |x| or |z| of a placement, metres from the home's origin. */
export const MAX_PLACEMENT_COORD = 200;

export interface PlayerItem {
  readonly itemInstanceId: string;
  readonly itemId: string;
  readonly name: string;
  readonly category: ShopCategory;
  readonly modelKey: string;
  readonly placeable: boolean;
  readonly footprint: Footprint | null;
  readonly orderId: string | null;
  readonly acquiredAt: string;
  /** The home it stands in, or null. */
  readonly placedHomeId: string | null;
}

export interface PlacementInput {
  readonly itemInstanceId: string;
  readonly x: number;
  readonly z: number;
  readonly rotY: number;
}

export interface Placement extends PlacementInput {
  readonly itemId: string;
  readonly name: string;
  readonly modelKey: string;
  readonly footprint: Footprint | null;
}

export interface HomePlacements {
  readonly homeId: string;
  readonly placements: Placement[];
}

const ITEM_JOIN_COLUMNS = `i.item_id, i.category, i.name, i.price_cents, i.deliverable, i.placeable,
       i.footprint_w, i.footprint_d, i.footprint_h, i.model_key`;

/**
 * The caller's owned items, newest first.
 * @param ctx - The app context.
 * @param userId - The owner.
 */
export async function listMyItems(ctx: AppContext, userId: string): Promise<PlayerItem[]> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query(
      `SELECT p.instance_id, p.order_id, p.acquired_at, h.home_id AS placed_home_id,
              ${ITEM_JOIN_COLUMNS}
         FROM player_items p
         JOIN shop_items i ON i.item_id = p.item_id
         LEFT JOIN home_placements h ON h.instance_id = p.instance_id
        WHERE p.user_id = $1
        ORDER BY p.acquired_at DESC, p.instance_id DESC
        LIMIT 500`,
      [userId],
    );
    return r.rows.map((row) => {
      const item = toShopItem(row);
      return {
        itemInstanceId: row.instance_id as string,
        itemId: item.itemId,
        name: item.name,
        category: item.category,
        modelKey: item.modelKey,
        placeable: item.placeable,
        footprint: item.footprint,
        orderId: row.order_id as string | null,
        acquiredAt: (row.acquired_at as Date).toISOString(),
        placedHomeId: row.placed_home_id as string | null,
      };
    });
  });
}

async function readPlacements(
  c: Pick<PoolClient, 'query'>,
  homeId: string,
): Promise<HomePlacements> {
  const r = await c.query(
    `SELECT h.instance_id, h.x, h.z, h.rot_y, ${ITEM_JOIN_COLUMNS}
       FROM home_placements h
       JOIN player_items p ON p.instance_id = h.instance_id
       JOIN shop_items i ON i.item_id = p.item_id
      WHERE h.home_id = $1
      ORDER BY h.placed_at ASC, h.instance_id ASC`,
    [homeId],
  );
  return {
    homeId,
    placements: r.rows.map((row) => {
      const item = toShopItem(row);
      return {
        itemInstanceId: row.instance_id as string,
        x: row.x as number,
        z: row.z as number,
        rotY: row.rot_y as number,
        itemId: item.itemId,
        name: item.name,
        modelKey: item.modelKey,
        footprint: item.footprint,
      };
    }),
  };
}

/**
 * Set where the owner's items stand in their home (replaces the set).
 * @param ctx - The app context.
 * @param homeId - The home's instance id (`home:<uuid>`).
 * @param userId - The caller; must own the home.
 * @param placements - The full new set; empty clears the home.
 */
export async function setPlacements(
  ctx: AppContext,
  homeId: string,
  userId: string,
  placements: ReadonlyArray<PlacementInput>,
): Promise<HomePlacements> {
  if (placements.length > MAX_PLACEMENTS_PER_HOME) {
    throw new ValidationFailedError({
      reason: 'too many placements',
      max: MAX_PLACEMENTS_PER_HOME,
    });
  }
  for (const p of placements) {
    if (
      ![p.x, p.z, p.rotY].every(Number.isFinite) ||
      Math.abs(p.x) > MAX_PLACEMENT_COORD ||
      Math.abs(p.z) > MAX_PLACEMENT_COORD
    ) {
      throw new ValidationFailedError({
        reason: 'placement out of range',
        itemInstanceId: p.itemInstanceId,
      });
    }
  }
  const ids = placements.map((p) => p.itemInstanceId);
  if (new Set(ids).size !== ids.length) {
    throw new ItemAlreadyPlacedError({ reason: 'item listed twice' });
  }

  await runInTransaction(async (client) => {
    const home = await client.query<{ owner_user_id: string; status: string }>(
      `SELECT owner_user_id, status FROM homes WHERE home_id = $1 FOR UPDATE`,
      [homeId],
    );
    const h = home.rows[0];
    if (!h) throw new NotFoundError({ resource: 'home', id: homeId });
    if (h.owner_user_id !== userId) throw new NotHomeOwnerError({ homeId });
    if (h.status !== 'active' && h.status !== 'overdue') {
      throw new ValidationFailedError({ reason: 'home is not active', status: h.status });
    }

    if (ids.length > 0) {
      // Owned, and placeable. A foreign or unknown id is the same answer.
      const own = await client.query<{ instance_id: string; placeable: boolean }>(
        `SELECT p.instance_id, i.placeable
           FROM player_items p JOIN shop_items i ON i.item_id = p.item_id
          WHERE p.user_id = $1 AND p.instance_id = ANY($2::uuid[])`,
        [userId, ids],
      );
      const byId = new Map(own.rows.map((r) => [r.instance_id, r]));
      for (const id of ids) {
        const row = byId.get(id);
        if (!row) throw new ItemNotOwnedError({ itemInstanceId: id });
        if (!row.placeable) throw new ItemNotPlaceableError({ itemInstanceId: id });
      }
      // Standing in another home: fine if that home is over, else refused.
      const elsewhere = await client.query<{ instance_id: string; status: string }>(
        `SELECT pl.instance_id, hm.status
           FROM home_placements pl JOIN homes hm ON hm.home_id = pl.home_id
          WHERE pl.instance_id = ANY($1::uuid[]) AND pl.home_id <> $2`,
        [ids, homeId],
      );
      for (const e of elsewhere.rows) {
        if (e.status === 'active' || e.status === 'overdue') {
          throw new ItemAlreadyPlacedError({ itemInstanceId: e.instance_id });
        }
      }
      await client.query(
        `DELETE FROM home_placements WHERE instance_id = ANY($1::uuid[]) AND home_id <> $2`,
        [ids, homeId],
      );
    }

    await client.query(`DELETE FROM home_placements WHERE home_id = $1`, [homeId]);
    for (const p of placements) {
      await client.query(
        `INSERT INTO home_placements (instance_id, home_id, x, z, rot_y) VALUES ($1, $2, $3, $4, $5)`,
        [p.itemInstanceId, homeId, p.x, p.z, p.rotY],
      );
    }
  });
  return ctx.db.withConnection((c) => readPlacements(c, homeId));
}

/**
 * A home's placements, for anyone who may walk through its door (the
 * owner, a guest; a home without a door is open, like the home room).
 * @param ctx - The app context.
 * @param homeId - The home's instance id.
 * @param viewerId - The caller.
 */
export async function getPlacements(
  ctx: AppContext,
  homeId: string,
  viewerId: string,
): Promise<HomePlacements> {
  const exists = await ctx.db.withConnection((c) =>
    c.query(`SELECT 1 FROM homes WHERE home_id = $1`, [homeId]),
  );
  if (exists.rowCount === 0) throw new NotFoundError({ resource: 'home', id: homeId });
  if (!(await canEnterHome(ctx, homeId, viewerId))) throw new ForbiddenError({ homeId });
  return ctx.db.withConnection((c) => readPlacements(c, homeId));
}
