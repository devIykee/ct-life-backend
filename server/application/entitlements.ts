/**
 * Player entitlements: what a player owns that unlocks something in
 * the game. The first item is 'vehicle.hovercar', the scarce
 * right-to-drive pass for the roadstar (the v3 hovercar).
 *
 * Endpoint:
 *
 *   GET /v1/me/entitlements   — { items: string[], updatedAt }
 *
 * Sources:
 *   - 'nft'   — the player's wallet holds an asset in the item's
 *               Metaplex Core collection. syncFromWallet() grants it
 *               and revokes it once the asset leaves the wallet.
 *   - 'grant' — ops / test grant (tools/scripts/entitlement-grant.ts).
 *
 * Money rule: there is no Cash path. Game Cash can be won, so it can
 * never buy anything backed by a tradable NFT.
 *
 * Wallet sync runs on GET at most once per SYNC_INTERVAL_MS per user
 * per instance, and only when HOVERCAR_COLLECTION is set. A Helius
 * failure keeps the existing rows: an outage never revokes.
 */
import type { AppContext } from './context.js';
import { uuidv7 } from '../shared/domain/uuid.js';

export const HOVERCAR = 'vehicle.hovercar';

const SYNC_INTERVAL_MS = 60_000;
const lastSync = new Map<string, number>();

export interface Entitlements {
  readonly items: string[];
  readonly updatedAt: string;
}

/** The live item keys of a player, sorted. */
export async function listEntitlements(ctx: AppContext, userId: string): Promise<Entitlements> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ item_key: string; granted_at: Date }>(
      `SELECT item_key, granted_at FROM player_entitlements
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY item_key`,
      [userId],
    ),
  );
  const latest = r.rows.reduce((t, row) => Math.max(t, row.granted_at.getTime()), 0);
  return {
    items: r.rows.map((row) => row.item_key),
    updatedAt: new Date(latest || Date.now()).toISOString(),
  };
}

/** True when the player holds a live entitlement for `itemKey`. */
export async function hasEntitlement(
  ctx: AppContext,
  userId: string,
  itemKey: string,
): Promise<boolean> {
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `SELECT 1 FROM player_entitlements
        WHERE user_id = $1 AND item_key = $2 AND revoked_at IS NULL
        LIMIT 1`,
      [userId, itemKey],
    ),
  );
  return (r.rowCount ?? 0) > 0;
}

/** Grant `itemKey` unless a live row exists. Returns true when a row was added. */
export async function grantEntitlement(
  ctx: AppContext,
  userId: string,
  itemKey: string,
  source: 'nft' | 'grant',
  reference = '',
): Promise<boolean> {
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `INSERT INTO player_entitlements (entitlement_id, user_id, item_key, source, reference)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, item_key) WHERE revoked_at IS NULL DO NOTHING`,
      [uuidv7(), userId, itemKey, source, reference],
    ),
  );
  return (r.rowCount ?? 0) > 0;
}

/** Revoke the live `itemKey` row, optionally only one from `source`. */
export async function revokeEntitlement(
  ctx: AppContext,
  userId: string,
  itemKey: string,
  source?: 'nft' | 'grant',
): Promise<boolean> {
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE player_entitlements SET revoked_at = now()
        WHERE user_id = $1 AND item_key = $2 AND revoked_at IS NULL
          AND ($3::text IS NULL OR source = $3)`,
      [userId, itemKey, source ?? null],
    ),
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Match the hovercar entitlement to the player's wallet: grant while
 * the wallet holds a pass from HOVERCAR_COLLECTION, revoke an 'nft'
 * row once it doesn't. 'grant' rows are never touched here.
 */
export async function syncFromWallet(
  ctx: AppContext,
  userId: string,
  now = Date.now(),
): Promise<void> {
  const collection = ctx.config.entitlements.hovercarCollection;
  if (!collection) return;
  if (now - (lastSync.get(userId) ?? 0) < SYNC_INTERVAL_MS) return;
  lastSync.set(userId, now);

  const u = await ctx.db.withConnection((c) =>
    c.query<{ wallet: string }>(`SELECT wallet FROM users WHERE id = $1`, [userId]),
  );
  const wallet = u.rows[0]?.wallet;
  if (!wallet) return;

  let assets: string[];
  try {
    assets = await ctx.helius.collectionAssetsOwnedBy(wallet, collection);
  } catch {
    lastSync.delete(userId);
    return;
  }
  if (assets.length > 0) await grantEntitlement(ctx, userId, HOVERCAR, 'nft', assets[0]);
  else await revokeEntitlement(ctx, userId, HOVERCAR, 'nft');
}

/** Test hook: forget the per-user sync throttle. */
export function _resetEntitlementSyncForTests(): void {
  lastSync.clear();
}
