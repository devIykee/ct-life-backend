/**
 * TokenAmount decimal formatting: base units to user units, the form
 * Solana Pay URLs carry.
 */
import { describe, expect, it } from 'vitest';
import { MINTS, TokenAmount } from './token-amount.js';
import { buildSolanaPayUrl } from '../../application/topup.js';

describe('TokenAmount.toDecimalString', () => {
  it.each([
    [1_000_000n, MINTS.USDC, '1'],
    [1_500_000n, MINTS.USDC, '1.5'],
    [1n, MINTS.USDC, '0.000001'],
    [0n, MINTS.USDC, '0'],
    [25_000_000n, MINTS.USDC, '25'],
    [1_000_000_000n, MINTS.SOL, '1'],
    [123_456_789_012n, MINTS.ORE, '1.23456789012'],
    [-2_500_000n, MINTS.USDC, '-2.5'],
  ])('%s base units of %o is %s', (base, mint, expected) => {
    expect(TokenAmount.of(base, mint).toDecimalString()).toBe(expected);
  });
});

describe('buildSolanaPayUrl', () => {
  it('carries the amount in user units', () => {
    const url = buildSolanaPayUrl({
      recipient: '11111111111111111111111111111111',
      amount: TokenAmount.of(1_000_000n, MINTS.USDC).toDecimalString(),
      splToken: MINTS.USDC.mint,
      reference: 'ref',
      memo: 'memo',
      label: 'CT Life',
      message: 'Cash top-up',
    });
    expect(new URL(url).searchParams.get('amount')).toBe('1');
  });
});
