/**
 * Cosmetics service (M5 #59).
 *
 * Endpoints:
 *
 *   GET  /v1/shop                  — list shop items, optionally filtered by slot
 *   POST /v1/shop/purchase         — buy a Cash cosmetic; debits a 'cosmetic'
 *                                    ledger row and appends a cosmetic_inventory row
 *   GET  /v1/inventory             — list the user's owned cosmetics
 *
 * Idempotency:
 *   - Replaying POST /v1/shop/purchase for an item the user already owns
 *     returns the existing inventory row (no double-debit).
 *   - The unique index on (user_id, item_id) is the floor.
 *
 * Daily cap:
 *   - At most 5 cosmetic purchases per user per UTC day (across all
 *     kinds). The cap is enforced inside the transaction with a
 *     SELECT COUNT(*) on cosmetic_inventory by user_id grouped by
 *     date(acquired_at). The limit is hard-coded; a future config
 *     table can parameterise it.
 *
 * onchain_only:
 *   - Items with onchain_only=true refuse the Cash purchase path
 *     with 400 VALIDATION_FAILED. The M5 #66 NFT mint flow is the
 *     only way to acquire them.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type CosmeticSlot = 'skin' | 'head' | 'hair' | 'top' | 'bottom' | 'shoes' | 'acc';

export interface CosmeticItem {
  readonly itemId: string;
  readonly slot: CosmeticSlot;
  readonly itemKey: string;
  readonly name: string;
  readonly priceCents: number;
  readonly onchainOnly: boolean;
}

export interface InventoryRow {
  readonly inventoryId: string;
  readonly itemId: string;
  readonly slot: CosmeticSlot;
  readonly itemKey: string;
  readonly name: string;
  readonly source: 'shop' | 'mint' | 'grant';
  readonly acquiredAt: string;
}

interface ItemDbRow {
  item_id: string;
  slot: CosmeticSlot;
  item_key: string;
  name: string;
  price_cents: string;
  onchain_only: boolean;
}

interface InventoryDbRow {
  inventory_id: string;
  item_id: string;
  slot: CosmeticSlot;
  item_key: string;
  name: string;
  source: 'shop' | 'mint' | 'grant';
  acquired_at: Date;
}

const DAILY_PURCHASE_CAP = 5;

const DEFAULT_CATALOG: ReadonlyArray<{
  slot: CosmeticSlot;
  itemKey: string;
  name: string;
  priceCents: number;
  onchainOnly?: boolean;
  /** Only ever granted (event rewards); never in the shop, never buyable. */
  grantOnly?: boolean;
}> = [
  // tops
  { slot: 'top', itemKey: 'top_hoodie_black', name: 'Black Hoodie', priceCents: 1000 },
  { slot: 'top', itemKey: 'top_tshirt_white', name: 'Plain White Tee', priceCents: 500 },
  { slot: 'top', itemKey: 'top_fleece_vest', name: 'Fleece Vest', priceCents: 5000 },
  // bottoms
  { slot: 'bottom', itemKey: 'bottom_jeans_blue', name: 'Blue Jeans', priceCents: 1000 },
  { slot: 'bottom', itemKey: 'bottom_shorts_khaki', name: 'Khaki Shorts', priceCents: 800 },
  // shoes
  { slot: 'shoes', itemKey: 'shoes_sneakers_white', name: 'White Sneakers', priceCents: 1500 },
  { slot: 'shoes', itemKey: 'shoes_boots_brown', name: 'Brown Boots', priceCents: 3000 },
  // hair
  { slot: 'hair', itemKey: 'hair_mohawk_red', name: 'Red Mohawk', priceCents: 2000 },
  { slot: 'hair', itemKey: 'hair_dreadlocks_black', name: 'Black Dreadlocks', priceCents: 2500 },
  // head
  { slot: 'head', itemKey: 'head_cap_black', name: 'Black Cap', priceCents: 800 },
  { slot: 'head', itemKey: 'head_headphones_silver', name: 'Silver Headphones', priceCents: 4000 },
  // acc
  { slot: 'acc', itemKey: 'acc_aviator_sunglasses', name: 'Aviator Sunglasses', priceCents: 1200 },
  { slot: 'acc', itemKey: 'acc_chain_gold', name: 'Gold Chain', priceCents: 10000 },
  // ORE-only cosmetics (onchain path only; not buyable here)
  { slot: 'head', itemKey: 'head_hard_hat', name: 'Hard Hat', priceCents: 0, onchainOnly: true },
  {
    slot: 'acc',
    itemKey: 'acc_pickaxe',
    name: 'Pickaxe Emote',
    priceCents: 0,
    onchainOnly: true,
  },
  {
    slot: 'acc',
    itemKey: 'acc_ore_backpack',
    name: 'Glowing Ore Backpack',
    priceCents: 0,
    onchainOnly: true,
  },
  // Event rewards (granted by the events service, off-chain, never tradable)
  {
    slot: 'acc',
    itemKey: 'lanyard_breakpoint_2026',
    name: 'Breakpoint 2026 Lanyard',
    priceCents: 0,
    grantOnly: true,
  },
  {
    slot: 'acc',
    itemKey: 'lanyard_breakpoint_2026_gold',
    name: 'Breakpoint 2026 Gold Lanyard',
    priceCents: 0,
    grantOnly: true,
  },
  {
    slot: 'acc',
    itemKey: 'irl_badge_breakpoint_2026',
    name: 'Breakpoint 2026 IRL Attendee Badge',
    priceCents: 0,
    grantOnly: true,
  },
];

/**
 * Idempotently seed the cosmetic catalog. Called once on first
 * GET /v1/shop. We do not block on this: the call is a
 * `... ON CONFLICT (item_key) DO NOTHING` so re-runs are safe.
 */
export async function ensureCatalog(_ctx: AppContext): Promise<void> {
  for (const item of DEFAULT_CATALOG) {
    const itemId = uuidv7();
    await _ctx.db.withConnection(async (c) => {
      await c.query(
        `INSERT INTO cosmetic_items (item_id, slot, item_key, name, price_cents, onchain_only, grant_only)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (item_key) DO NOTHING`,
        [
          itemId,
          item.slot,
          item.itemKey,
          item.name,
          item.priceCents,
          item.onchainOnly ?? false,
          item.grantOnly ?? false,
        ],
      );
    });
  }
}

/** List shop items, optionally filtered by slot. */
export async function listShop(
  ctx: AppContext,
  slot: CosmeticSlot | null,
): Promise<CosmeticItem[]> {
  await ensureCatalog(ctx);
  return ctx.db.withConnection(async (c) => {
    const r = slot
      ? await c.query<ItemDbRow>(
          `SELECT item_id, slot, item_key, name, price_cents, onchain_only
           FROM cosmetic_items WHERE slot = $1 AND NOT grant_only ORDER BY price_cents ASC, item_key ASC`,
          [slot],
        )
      : await c.query<ItemDbRow>(
          `SELECT item_id, slot, item_key, name, price_cents, onchain_only
           FROM cosmetic_items WHERE NOT grant_only ORDER BY slot ASC, price_cents ASC, item_key ASC`,
        );
    return r.rows.map(rowToItem);
  });
}

/** List the user's owned cosmetics, newest first. */
export async function listInventory(ctx: AppContext, userId: string): Promise<InventoryRow[]> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<InventoryDbRow>(
      `SELECT ci.inventory_id, ci.item_id, c.slot, c.item_key, c.name, ci.source, ci.acquired_at
       FROM cosmetic_inventory ci
       JOIN cosmetic_items c ON c.item_id = ci.item_id
       WHERE ci.user_id = $1
       ORDER BY ci.acquired_at DESC
       LIMIT 200`,
      [userId],
    );
    return r.rows.map(rowToInventory);
  });
}

/**
 * Buy a Cash cosmetic. Idempotent on (user_id, item_id): a
 * second call for the same item returns the existing inventory
 * row without debiting cash again.
 */
export async function purchase(
  _ctx: AppContext,
  userId: string,
  itemId: string,
): Promise<InventoryRow> {
  const inventoryId = uuidv7();
  const result = await runInTransaction(async (client) => {
    // Lock + read the item.
    const itemR = await client.query<ItemDbRow>(
      `SELECT item_id, slot, item_key, name, price_cents, onchain_only, grant_only
       FROM cosmetic_items WHERE item_id = $1 FOR UPDATE`,
      [itemId],
    );
    const item = itemR.rows[0] as (ItemDbRow & { grant_only: boolean }) | undefined;
    if (!item) {
      throw new NotFoundError({ reason: 'item not found', itemId });
    }
    if (item.grant_only) {
      throw new ValidationFailedError({
        reason: 'item is grant-only; it cannot be bought',
        itemKey: item.item_key,
      });
    }
    if (item.onchain_only) {
      throw new ValidationFailedError({
        reason: 'item is onchain-only; use the NFT mint flow',
        itemKey: item.item_key,
      });
    }
    const price = Number(item.price_cents);

    // Daily cap: count this user's shop-source acquisitions today.
    const capR = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM cosmetic_inventory
       WHERE user_id = $1
         AND source = 'shop'
         AND acquired_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
      [userId],
    );
    const todayCount = Number(capR.rows[0]?.count ?? '0');
    if (todayCount >= DAILY_PURCHASE_CAP) {
      throw new ValidationFailedError({
        reason: 'daily cosmetic purchase cap reached',
        cap: DAILY_PURCHASE_CAP,
      });
    }

    // Idempotency: if the user already owns this item, return the
    // existing inventory row without debiting.
    const existingR = await client.query<InventoryDbRow>(
      `SELECT ci.inventory_id, ci.item_id, c.slot, c.item_key, c.name, ci.source, ci.acquired_at
       FROM cosmetic_inventory ci
       JOIN cosmetic_items c ON c.item_id = ci.item_id
       WHERE ci.user_id = $1 AND ci.item_id = $2`,
      [userId, itemId],
    );
    if (existingR.rows[0]) {
      return existingR.rows[0];
    }

    // Ensure the balances row exists and lock it.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const balR = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const cash = BigInt(balR.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(price)) {
      throw new ValidationFailedError({
        reason: 'insufficient cash',
        have: cash.toString(),
        need: price.toString(),
      });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [price, userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'cosmetic', 'cosmetic_item', $3, $4)`,
      [userId, -price, itemId, `cosmetic:${userId}:${itemId}:${uuidv7()}`],
    );
    // Try to insert; if the unique index fires (concurrent first
    // purchase), translate to a duplicate-ownership reply.
    try {
      await client.query(
        `INSERT INTO cosmetic_inventory (inventory_id, user_id, item_id, source)
         VALUES ($1, $2, $3, 'shop')`,
        [inventoryId, userId, itemId],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        // Concurrent purchase; the OTHER transaction's inventory
        // row is the source of truth. Re-read and return.
        const replayR = await client.query<InventoryDbRow>(
          `SELECT ci.inventory_id, ci.item_id, c.slot, c.item_key, c.name, ci.source, ci.acquired_at
           FROM cosmetic_inventory ci
           JOIN cosmetic_items c ON c.item_id = ci.item_id
           WHERE ci.user_id = $1 AND ci.item_id = $2`,
          [userId, itemId],
        );
        if (replayR.rows[0]) return replayR.rows[0];
      }
      throw e;
    }
    // Return the freshly-inserted row.
    return {
      inventory_id: inventoryId,
      item_id: item.item_id,
      slot: item.slot,
      item_key: item.item_key,
      name: item.name,
      source: 'shop' as const,
      acquired_at: new Date(),
    };
  });
  return rowToInventory(result);
}

function rowToItem(r: ItemDbRow): CosmeticItem {
  return {
    itemId: r.item_id,
    slot: r.slot,
    itemKey: r.item_key,
    name: r.name,
    priceCents: Number(r.price_cents),
    onchainOnly: r.onchain_only,
  };
}

function rowToInventory(r: InventoryDbRow): InventoryRow {
  return {
    inventoryId: r.inventory_id,
    itemId: r.item_id,
    slot: r.slot,
    itemKey: r.item_key,
    name: r.name,
    source: r.source,
    acquiredAt: r.acquired_at.toISOString(),
  };
}

/**
 * Grant a cosmetic by key (event rewards, ops). Writes the inventory row with
 * source 'grant' on the caller's transaction client. Idempotent: owning the
 * item already is not an error and grants nothing twice.
 * @param client - The transaction client.
 * @param userId - The player.
 * @param itemKey - The cosmetic's key (must be in the catalogue).
 * @returns True when newly granted, false when already owned.
 */
export async function grantCosmetic(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  userId: string,
  itemKey: string,
): Promise<boolean> {
  const item = await client.query(`SELECT item_id FROM cosmetic_items WHERE item_key = $1`, [
    itemKey,
  ]);
  const row = item.rows[0] as { item_id: string } | undefined;
  if (!row) throw new NotFoundError({ reason: 'cosmetic not in catalogue', itemKey });
  const r = await client.query(
    `INSERT INTO cosmetic_inventory (inventory_id, user_id, item_id, source)
     VALUES ($1, $2, $3, 'grant')
     ON CONFLICT (user_id, item_id) DO NOTHING
     RETURNING inventory_id`,
    [uuidv7(), userId, row.item_id],
  );
  return r.rows.length > 0;
}
