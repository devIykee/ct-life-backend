/** A player UUID without a primary Solana wallet can play, but cannot prepare Solana spending. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from './context.js';
import { readOreMe } from './refinery.js';
import { loadPlayerGate } from './real-markets-gate.js';
import { putCreatorMode } from './creator.js';
import { prepareUsdcIntent } from './topup.js';
import { holdingsOf } from './nft-gallery.js';
import { syncFromWallet, _resetEntitlementSyncForTests } from './entitlements.js';

const player = '019a5194-846b-7000-8000-000000000001';

function playerContext(row: Record<string, unknown> | null = { wallet: null }) {
  const query = vi.fn(async (sql: string) => {
    if (!sql.startsWith('SELECT')) throw new Error('Unexpected player mutation');
    return { rows: row === null ? [] : [row], rowCount: row === null ? 0 : 1 };
  });
  const fetch = vi.fn(() => {
    throw new Error('Unexpected network request');
  });
  vi.stubGlobal('fetch', fetch);
  const collectionAssetsOwnedBy = vi.fn(() => {
    throw new Error('Unexpected wallet lookup');
  });
  const redisGet = vi.fn(() => {
    throw new Error('Unexpected wallet cache lookup');
  });
  const ctx = {
    db: { withConnection: (fn: (c: { query: typeof query }) => unknown) => fn({ query }) },
    config: {
      features: { oreReader: true },
      helius: { rpcUrlMainnet: 'https://unused.invalid' },
      entitlements: { hovercarCollection: 'fixture-collection' },
    },
    configCache: { load: () => ({ currencies: { USDC: { mint: 'fixture-mint' } } }) },
    helius: { collectionAssetsOwnedBy },
    redis: { main: { get: redisGet } },
  } as unknown as AppContext;
  return { ctx, query, fetch, collectionAssetsOwnedBy, redisGet };
}

afterEach(() => {
  vi.unstubAllGlobals();
  _resetEntitlementSyncForTests();
});

describe('player without a primary Solana wallet', () => {
  it('returns empty ORE holdings without querying an invalid wallet on mainnet', async () => {
    const f = playerContext({ wallet: null, miner_tier: 'none' });
    expect(await readOreMe(f.ctx, player)).toEqual({
      balance: '0',
      staked: '0',
      stOre: '0',
      minerTier: 'none',
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('retains the age confirmation but requires a wallet for Solana markets', async () => {
    const f = playerContext({ wallet: null, age_confirmed_at: new Date() });
    expect(await loadPlayerGate(f.ctx, player)).toEqual({ wallet: null, ageConfirmed: true });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('does not enable paid creator calls without a Solana payout address', async () => {
    const f = playerContext();
    await expect(
      putCreatorMode(f.ctx, player, {
        enabled: true,
        ratePerMinUsdc: '1000000',
        maxMinutes: 10,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'wallet_required' } });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('does not prepare a topup transaction or fetch a blockhash', async () => {
    const f = playerContext();
    await expect(
      prepareUsdcIntent(f.ctx, {
        userId: player,
        kind: 'topup',
        amountBaseUnits: 1_000_000n,
        cashCents: 100,
        bonusBps: 0,
        message: 'fixture',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { reason: 'wallet_required' } });
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('returns a wallet requirement for NFT holdings instead of claiming the player is missing', async () => {
    const f = playerContext();
    await expect(holdingsOf(f.ctx, player)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'wallet_required' },
    });
    expect(f.redisGet).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('continues to distinguish a missing player from a player without a wallet', async () => {
    const f = playerContext(null);
    await expect(holdingsOf(f.ctx, player)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('does not query or grant a Solana NFT entitlement without its wallet', async () => {
    const f = playerContext();
    await syncFromWallet(f.ctx, player);
    expect(f.collectionAssetsOwnedBy).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
