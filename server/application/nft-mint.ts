/**
 * Cosmetic NFT mint service (M5 #66).
 *
 * Cash is purchasable but NON-transferable and has no cash-out, so nothing bought with
 * Cash (or earned by playing) can be minted: `POST /nft/mint` answers 403
 * NFT_MINT_NOT_ALLOWED unless the item was acquired on-chain (inventory source 'mint').
 *
 * Endpoints:
 *
 *   POST /v1/nft/mint        — mint a Core asset for an item the
 *                                user owns. The devnet Mints flow
 *                                builds the unsigned v0 transaction
 *                                for MWA; after the client signs and
 *                                submits, the M3 webhook records
 *                                nft_mints. The M5 dev path uses a
 *                                deterministic mint_address (sha256
 *                                of userId + itemId) and a synthetic
 *                                signature so the test suite can
 *                                exercise the inventory flow without
 *                                hitting the on-chain leg.
 *   GET  /v1/nft/inventory   — list the user's nft_mints.
 *
 * Idempotency:
 *   - nft_mints.mint_address is UNIQUE. Re-minting the same
 *     item for the same user returns the existing row.
 *   - nft_mints.signature is UNIQUE. Two different users can
 *     never share a signature.
 *
 * Network:
 *   - Defaults to 'devnet' per the build-spec. 'mainnet'
 *     is behind RUN_MAINNET_TESTS=1 and is a no-op stub
 *     in M5; the production code wires the real signer.
 */
import { createHash } from 'node:crypto';
import {
  NftMintNotAllowedError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type NftNetwork = 'devnet' | 'mainnet';

export interface NftMintRow {
  readonly mintId: string;
  readonly userId: string;
  readonly itemId: string;
  readonly mintAddress: string;
  readonly signature: string;
  readonly network: NftNetwork;
  readonly mintedAt: string;
}

interface NftMintDbRow {
  mint_id: string;
  user_id: string;
  item_id: string;
  mint_address: string;
  signature: string;
  network: NftNetwork;
  minted_at: Date;
}

function rowToMint(r: NftMintDbRow): NftMintRow {
  return {
    mintId: r.mint_id,
    userId: r.user_id,
    itemId: r.item_id,
    mintAddress: r.mint_address,
    signature: r.signature,
    network: r.network,
    mintedAt: r.minted_at.toISOString(),
  };
}

const VALID_NETWORKS: ReadonlyArray<NftNetwork> = ['devnet', 'mainnet'];

function deterministicAddress(userId: string, itemId: string): string {
  return createHash('sha256').update(`${userId}:${itemId}`).digest('hex');
}

function syntheticSignature(userId: string, itemId: string, network: NftNetwork): string {
  return createHash('sha256')
    .update(`synthetic:${network}:${userId}:${itemId}:${Date.now()}`)
    .digest('hex');
}

/**
 * How an owned cosmetic was acquired (`cosmetic_inventory.source`), which decides whether it
 * may ever become an NFT.
 *   shop   bought with Cash
 *   grant  earned in the game (events, quests, streaks, season tiers, jackpots)
 *   mint   acquired on-chain (an ORE or collection path)
 */
export type InventorySource = 'shop' | 'grant' | 'mint';

/**
 * The Cash wall. Cash is purchasable but never converts to anything tradable, so an item
 * bought with Cash, or earned by playing with Cash, can never be minted as an NFT. Only an
 * item that was itself acquired on-chain may be. A future on-chain swap must go through
 * this guard.
 * @throws NftMintNotAllowedError for a `shop` or `grant` item.
 */
export function assertMintable(source: InventorySource, itemId: string): void {
  if (source !== 'mint') {
    throw new NftMintNotAllowedError({
      itemId,
      reason: source === 'shop' ? 'bought_with_cash' : 'earned_in_game',
    });
  }
}

/**
 * Mint a Core asset for an item the user owns, if it was acquired on-chain. The M5 dev
 * path records the nft_mints row directly; the production
 * code (M6+) will swap in the unsigned-v0 transaction flow
 * and the Helius webhook confirmation.
 */
export async function mint(
  ctx: AppContext,
  userId: string,
  args: { itemId: string; network?: NftNetwork },
): Promise<NftMintRow> {
  const network: NftNetwork = args.network ?? 'devnet';
  if (!VALID_NETWORKS.includes(network)) {
    throw new ValidationFailedError({
      reason: `network must be one of ${VALID_NETWORKS.join(',')}`,
    });
  }
  // Confirm the user owns the item. (The cosmetic inventory
  // is the source of truth: the mint flow is for items the
  // user already owns, not items they want to acquire.)
  const owned = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ inventory_id: string; source: InventorySource }>(
      `SELECT inventory_id, source FROM cosmetic_inventory WHERE user_id = $1 AND item_id = $2`,
      [userId, args.itemId],
    );
    return r.rows[0];
  });
  if (!owned) {
    throw new NotFoundError({ reason: 'user does not own this cosmetic', itemId: args.itemId });
  }
  assertMintable(owned.source, args.itemId);
  const mintAddress = deterministicAddress(userId, args.itemId);
  // Idempotency on mint_address: re-mint returns the existing row.
  const existing = await ctx.db.withConnection(async (c) => {
    const r = await c.query<NftMintDbRow>(
      `SELECT mint_id, user_id, item_id, mint_address, signature, network, minted_at
       FROM nft_mints WHERE mint_address = $1`,
      [mintAddress],
    );
    return r.rows[0];
  });
  if (existing) {
    return rowToMint(existing);
  }
  const mintId = uuidv7();
  const signature = syntheticSignature(userId, args.itemId, network);
  const inserted = await ctx.db.withConnection(async (c) => {
    const r = await c.query<NftMintDbRow>(
      `INSERT INTO nft_mints (mint_id, user_id, item_id, mint_address, signature, network)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING mint_id, user_id, item_id, mint_address, signature, network, minted_at`,
      [mintId, userId, args.itemId, mintAddress, signature, network],
    );
    return r.rows[0]!;
  });
  return rowToMint(inserted);
}

/**
 *
 */
export async function listInventory(ctx: AppContext, userId: string): Promise<NftMintRow[]> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<NftMintDbRow>(
      `SELECT mint_id, user_id, item_id, mint_address, signature, network, minted_at
       FROM nft_mints WHERE user_id = $1
       ORDER BY minted_at DESC LIMIT 200`,
      [userId],
    );
    return r.rows.map(rowToMint);
  });
}
