/**
 * fairnessOf: the sealed-draw proof shown on markets and on bet history.
 * The secret appears only once a market is resolved or void.
 */
import { describe, expect, it } from 'vitest';
import { commitmentOf, fairnessOf } from './prediction-markets.js';

const seed = '01'.repeat(32);
const commitment = commitmentOf(seed);

describe('fairnessOf', () => {
  it('hides the seed while bets could still matter', () => {
    for (const status of ['open', 'closed'] as const) {
      expect(fairnessOf({ status, basis: { seed, commitment } })).toEqual({
        commitment,
        seed: null,
      });
    }
  });

  it('reveals the seed once resolved or void', () => {
    for (const status of ['resolved', 'void'] as const) {
      expect(fairnessOf({ status, basis: { seed, commitment } })).toEqual({ commitment, seed });
    }
  });

  it('is null for markets that are not sealed draws', () => {
    expect(fairnessOf({ status: 'resolved', basis: { symbol: 'BTCUSDT' } })).toBeNull();
  });
});
