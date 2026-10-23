/**
 * Entitlement service tests.
 *
 * Covers grant / list / has / revoke, the one-live-row rule, and the
 * wallet sync: grant while the wallet holds a pass, revoke an 'nft' row
 * when it doesn't, leave 'grant' rows alone, and never revoke on a
 * Helius failure.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  HOVERCAR,
  _resetEntitlementSyncForTests,
  grantEntitlement,
  hasEntitlement,
  listEntitlements,
  revokeEntitlement,
  syncFromWallet,
} from './entitlements.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let userId: string;
let wallet: string;

/** A context whose Helius answers `assets` (or throws) for the hovercar collection. */
function withWallet(assets: string[] | Error): AppContext {
  const base = buildContext();
  return {
    ...base,
    config: { ...base.config, entitlements: { hovercarCollection: 'HovercarPassCollection' } },
    helius: {
      ...base.helius,
      collectionAssetsOwnedBy: async (owner: string, collection: string) => {
        expect(owner).toBe(wallet);
        expect(collection).toBe('HovercarPassCollection');
        if (assets instanceof Error) throw assets;
        return assets;
      },
    },
  };
}

beforeAll(async () => {
  userId = uuidv7();
  wallet = `entitlementUser-${userId}`;
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [userId, wallet]);
});

beforeEach(async () => {
  _resetEntitlementSyncForTests();
  await pool.query(`DELETE FROM player_entitlements WHERE user_id = $1`, [userId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM player_entitlements WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

describe('entitlements', () => {
  it('grants, lists and revokes, with one live row per item', async () => {
    const ctx = buildContext();
    expect(await hasEntitlement(ctx, userId, HOVERCAR)).toBe(false);
    expect(await grantEntitlement(ctx, userId, HOVERCAR, 'grant', 'qa')).toBe(true);
    expect(await grantEntitlement(ctx, userId, HOVERCAR, 'grant', 'qa again')).toBe(false);
    expect((await listEntitlements(ctx, userId)).items).toEqual([HOVERCAR]);
    expect(await revokeEntitlement(ctx, userId, HOVERCAR)).toBe(true);
    expect(await hasEntitlement(ctx, userId, HOVERCAR)).toBe(false);
    // A re-grant after a revoke (e.g. bought back) works.
    expect(await grantEntitlement(ctx, userId, HOVERCAR, 'grant')).toBe(true);
  });

  it('wallet sync grants while the wallet holds a pass and revokes when it leaves', async () => {
    await syncFromWallet(withWallet(['PassAsset1']), userId, 1_000_000);
    expect(await hasEntitlement(buildContext(), userId, HOVERCAR)).toBe(true);
    await syncFromWallet(withWallet([]), userId, 2_000_000);
    expect(await hasEntitlement(buildContext(), userId, HOVERCAR)).toBe(false);
  });

  it('wallet sync never revokes an ops grant', async () => {
    await grantEntitlement(buildContext(), userId, HOVERCAR, 'grant', 'showcase');
    await syncFromWallet(withWallet([]), userId, 1_000_000);
    expect(await hasEntitlement(buildContext(), userId, HOVERCAR)).toBe(true);
  });

  it('a Helius failure keeps the existing entitlement', async () => {
    await syncFromWallet(withWallet(['PassAsset1']), userId, 1_000_000);
    await syncFromWallet(withWallet(new Error('helius down')), userId, 2_000_000);
    expect(await hasEntitlement(buildContext(), userId, HOVERCAR)).toBe(true);
  });

  it('one pass unlocks one account: a new holder revokes the previous one', async () => {
    const other = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [other, `buyer-${other}`]);
    try {
      const ctx = buildContext();
      await grantEntitlement(ctx, userId, HOVERCAR, 'nft', 'PassAsset1');
      expect(await grantEntitlement(ctx, other, HOVERCAR, 'nft', 'PassAsset1')).toBe(true);
      expect(await hasEntitlement(ctx, userId, HOVERCAR)).toBe(false);
      expect(await hasEntitlement(ctx, other, HOVERCAR)).toBe(true);
    } finally {
      await pool.query(`DELETE FROM player_entitlements WHERE user_id = $1`, [other]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [other]);
    }
  });

  it('wallet sync is off without HOVERCAR_COLLECTION', async () => {
    const base = buildContext();
    const ctx = { ...base, config: { ...base.config, entitlements: { hovercarCollection: '' } } };
    await syncFromWallet(ctx, userId, 1_000_000);
    expect(await hasEntitlement(base, userId, HOVERCAR)).toBe(false);
  });
});
