/**
 * Off-chain reward grants shared by the Season Pass tracks and the nod sets.
 *
 * Everything here runs on the caller's transaction client, so a reward and
 * the claim record that gates it commit together or not at all. Rewards are
 * Cash (ledger), cosmetics (`cosmetic_inventory`, source 'grant') and shop
 * furniture (`player_items`). None of them is an NFT or can be traded.
 *
 * Reward-only cosmetics live in `cosmetic_items` with `onchain_only = true`
 * (so the Cash purchase path refuses them), price 0 and an item key that
 * starts with `reward_` (so the shop listing hides them).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { Db } from '../shared/db/pool.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ensureShopItemsSynced } from './shop.js';

export interface RewardCosmeticDef {
  readonly cosmeticId: string;
  readonly name: string;
  readonly slot: string;
}

/** Read a JSON file of the contract (relative to the repo root). */
export function readContractJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(process.cwd(), 'contract', ...parts), 'utf8')) as T;
}

let cosmeticsSynced: Promise<void> | null = null;

/** Every reward cosmetic defined by `season_tracks.json`, `nods.json` and `careers.json`. */
export function allRewardCosmetics(): RewardCosmeticDef[] {
  const season = readContractJson<{ cosmetics: RewardCosmeticDef[] }>(
    'config',
    'season_tracks.json',
  );
  const nods = readContractJson<{ cosmetics: RewardCosmeticDef[] }>('ids', 'nods.json');
  const careers = readContractJson<{ cosmetics: RewardCosmeticDef[] }>('config', 'careers.json');
  return [...season.cosmetics, ...nods.cosmetics, ...careers.cosmetics];
}

/**
 * Upsert the reward cosmetics listed in `season_tracks.json` and `nods.json`
 * into `cosmetic_items`, once per process. Also syncs the shop catalogue so a
 * furniture reward can point at a `shop_items` row.
 * @param db - The database handle.
 */
export async function ensureRewardCatalog(db: Db): Promise<void> {
  cosmeticsSynced ??= (async () => {
    const defs = allRewardCosmetics();
    await ensureShopItemsSynced(db);
    for (const d of defs) {
      await db.withConnection((c) =>
        c.query(
          `INSERT INTO cosmetic_items (item_id, slot, item_key, name, price_cents, onchain_only)
           VALUES ($1, $2, $3, $4, 0, true)
           ON CONFLICT (item_key) DO NOTHING`,
          [uuidv7(), d.slot, d.cosmeticId, d.name],
        ),
      );
    }
  })().catch((e: unknown) => {
    cosmeticsSynced = null; // retry on the next call
    throw e;
  });
  await cosmeticsSynced;
}

/** Re-read on the next call (tests). */
export function _resetRewardCatalogForTests(): void {
  cosmeticsSynced = null;
}

/**
 * Give a player a reward cosmetic. A second call is a no-op.
 * @returns True when the player did not own it yet.
 */
export async function grantCosmetic(
  client: PoolClient,
  userId: string,
  cosmeticId: string,
): Promise<boolean> {
  const r = await client.query(
    `INSERT INTO cosmetic_inventory (inventory_id, user_id, item_id, source)
     SELECT $1, $2, item_id, 'grant' FROM cosmetic_items WHERE item_key = $3
     ON CONFLICT (user_id, item_id) DO NOTHING`,
    [uuidv7(), userId, cosmeticId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Deliver one unit of a shop item straight to the player's items.
 * @throws When the item is not in `shop_items` (a config error).
 */
export async function grantFurniture(
  client: PoolClient,
  userId: string,
  itemId: string,
): Promise<void> {
  const r = await client.query(
    `INSERT INTO player_items (instance_id, user_id, item_id)
     SELECT $1, $2, item_id FROM shop_items WHERE item_id = $3`,
    [uuidv7(), userId, itemId],
  );
  if ((r.rowCount ?? 0) === 0) {
    throw new Error(`reward furniture item ${itemId} is not in shop_items`);
  }
}

/**
 * Credit Cash with a ledger row. `idempotencyRef` is unique, so a retry that
 * got past the claim record still cannot pay twice.
 */
export async function creditCash(
  client: PoolClient,
  userId: string,
  cents: number,
  reason: string,
  refType: string,
  refId: string,
  idempotencyRef: string,
): Promise<void> {
  await client.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  await client.query(`SELECT 1 FROM balances WHERE user_id = $1 FOR UPDATE`, [userId]);
  await client.query(
    `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
    [cents, userId],
  );
  await client.query(
    `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
     VALUES ($1, $2, 'cash', $3, $4, $5, $6)`,
    [userId, cents, reason, refType, refId, idempotencyRef],
  );
}
