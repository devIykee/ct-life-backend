/**
 * `GET /config` chain blocks: a key appears only while its capability is on and the
 * deployment is on devnet (and, for the season pass, while a season is running).
 */
import { describe, expect, it } from 'vitest';
import { chainConfigPayload } from './chain-config.js';
import { seasonFile } from './season-tracks.js';
import type { CapabilityName } from '../shared/domain/capabilities.js';
import type { Config } from '../shared/config/config.js';

function ctx(on: CapabilityName[], cluster: 'devnet' | 'mainnet' = 'devnet') {
  return {
    config: {
      capabilities: { on: new Set(on), ignored: [] },
      solana: { cluster },
    } as unknown as Config,
  };
}

describe('chainConfigPayload', () => {
  const season = seasonFile().seasons[0]!;
  const inSeason = new Date(Date.parse(season.startsAt) + 1000);

  it('sends nothing while the capabilities are off', () => {
    expect(chainConfigPayload(ctx([]), inSeason)).toEqual({});
  });

  it('sends seasonPass while seasonPassPurchase is on, on devnet, in a season', () => {
    expect(chainConfigPayload(ctx(['seasonPassPurchase']), inSeason)).toEqual({
      seasonPass: {
        sku: 'season_pass',
        priceUsdc: '5000000',
        currency: 'USDC',
        seasonId: season.seasonId,
        endsAt: season.endsAt,
      },
    });
  });

  it('never offers the pass on mainnet or outside a season', () => {
    expect(chainConfigPayload(ctx(['seasonPassPurchase'], 'mainnet'), inSeason)).toEqual({});
    expect(chainConfigPayload(ctx(['seasonPassPurchase']), new Date('2001-01-01'))).toEqual({});
  });
});
