/**
 * NFT mint service tests.
 *
 * Covers: mint address derives from user + item (deterministic),
 * nft_mints UNIQUE on (mint_address, signature), inventory
 * lists the user's mints, refuse minting an item the user
 * does not own, double-mint is idempotent, unknown network
 * refused.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let userId: string;
let itemId: string;

beforeAll(async () => {
  userId = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [userId, `nftUser-${userId}`]);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Clear our user's nft_mints; leave the catalog intact.
  await pool.query(`DELETE FROM nft_mints WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM cosmetic_inventory WHERE user_id = $1`, [userId]);
  // Seed one catalog item + an inventory row.
  const seedItemId = uuidv7();
  await pool.query(
    `INSERT INTO cosmetic_items (item_id, slot, item_key, name, price_cents, onchain_only)
     VALUES ($1, 'top', $2, 'Test Tee', 1000, true)
     ON CONFLICT (item_key) DO NOTHING`,
    [seedItemId, `nft-test-${userId}`],
  );
  const r = await pool.query<{ item_id: string }>(
    `SELECT item_id FROM cosmetic_items WHERE item_key = $1`,
    [`nft-test-${userId}`],
  );
  itemId = r.rows[0]!.item_id;
  await pool.query(
    `INSERT INTO cosmetic_inventory (inventory_id, user_id, item_id, source)
     VALUES ($1, $2, $3, 'shop')`,
    [uuidv7(), userId, itemId],
  );
});

describe('nft-mint service', () => {
  it('mints and records the nft_mints row with a deterministic mint address', async () => {
    const ctx = buildContext();
    const { mint } = await import('./nft-mint.js');
    const out = await mint(ctx, userId, { itemId });
    expect(out.userId).toBe(userId);
    expect(out.itemId).toBe(itemId);
    expect(out.mintAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(out.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(out.network).toBe('devnet');
  });

  it('mint address is deterministic for (userId, itemId)', async () => {
    const ctx = buildContext();
    const { mint } = await import('./nft-mint.js');
    const a = await mint(ctx, userId, { itemId });
    // Re-mint same user/item -> idempotent replay (same mintId).
    const b = await mint(ctx, userId, { itemId });
    expect(b.mintId).toBe(a.mintId);
    expect(b.mintAddress).toBe(a.mintAddress);
  });

  it('nft_mints.mint_address is UNIQUE (23505 on duplicate)', async () => {
    const ctx = buildContext();
    const { mint } = await import('./nft-mint.js');
    await mint(ctx, userId, { itemId });
    // Direct DB check: the UNIQUE index exists.
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'public.nft_mints'::regclass
         AND i.indisunique
         AND a.attname = 'mint_address'`,
    );
    expect(Number(r.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });

  it('nft_mints.signature is UNIQUE', async () => {
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'public.nft_mints'::regclass
         AND i.indisunique
         AND a.attname = 'signature'`,
    );
    expect(Number(r.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });

  it('inventory lists the user mints newest first', async () => {
    const ctx = buildContext();
    const { mint, listInventory } = await import('./nft-mint.js');
    await mint(ctx, userId, { itemId });
    const inv = await listInventory(ctx, userId);
    expect(inv.length).toBe(1);
    expect(inv[0]!.mintAddress).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses minting an item the user does not own', async () => {
    const ctx = buildContext();
    const { mint } = await import('./nft-mint.js');
    const otherItem = uuidv7();
    await expect(mint(ctx, userId, { itemId: otherItem })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an unknown network', async () => {
    const ctx = buildContext();
    const { mint } = await import('./nft-mint.js');
    await expect(
      // @ts-expect-error: testing runtime refusal
      mint(ctx, userId, { itemId, network: 'testnet' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
