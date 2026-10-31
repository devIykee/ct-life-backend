/**
 * Pure parts of Real Markets reconciliation: instruction fingerprints survive the wallet
 * adding a priority fee, and `matchOrder` picks only an order whose every built
 * instruction landed, from its wallet, during its life.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { matchOrder, type LandedTx } from './real-markets-reconcile.js';
import type { OrderRow } from './real-markets-orders.js';
import {
  COMPUTE_BUDGET_PROGRAM,
  compileUnsignedV0,
  instructionFingerprint,
  txFingerprints,
  type WireInstruction,
} from '../shared/real-markets/tx.js';

const wallet = Keypair.generate().publicKey.toBase58();
const program = Keypair.generate().publicKey.toBase58();
const ix = (data: string): WireInstruction => ({
  programId: program,
  data,
  accounts: [{ pubkey: wallet, isSigner: true, isWritable: true }],
});
const fee: WireInstruction = {
  programId: COMPUTE_BUDGET_PROGRAM,
  data: Buffer.from([3, 9, 0, 0, 0, 0, 0, 0, 0]).toString('base64'),
  accounts: [],
};

function row(over: Partial<OrderRow>): OrderRow {
  const now = Date.now();
  return {
    order_id: crypto.randomUUID(),
    user_id: 'u',
    wallet,
    provider: 'panta',
    market_id: 'm',
    side: 'yes',
    amount_base: '1000000',
    est_shares: null,
    fee_usdc: null,
    provider_order_id: null,
    provider_quote_id: null,
    program_ids: [program],
    last_valid_block_height: null,
    status: 'built',
    provider_state: null,
    signature: null,
    error: null,
    created_at: new Date(now - 10_000),
    expires_at: new Date(now + 50_000),
    submitted_at: null,
    confirmed_at: null,
    recent_blockhash: null,
    ix_fingerprints: [],
    reconciled_at: null,
    ...over,
  };
}

function landed(fps: string[], over: Partial<LandedTx> = {}): LandedTx {
  return {
    signature: 'sig',
    feePayer: wallet,
    recentBlockhash: 'bh',
    fingerprints: new Set(fps),
    blockTime: Math.floor(Date.now() / 1000),
    ...over,
  };
}

describe('txFingerprints', () => {
  it('ignores compute-budget instructions, so a wallet priority fee keeps the match', () => {
    const bh = Keypair.generate().publicKey.toBase58();
    const built = compileUnsignedV0('panta', wallet, [ix('AQID')], bh);
    const signed = compileUnsignedV0('panta', wallet, [fee, ix('AQID')], bh);
    const s = VersionedTransaction.deserialize(Buffer.from(signed.txBase64, 'base64'));
    expect(txFingerprints(s)).toEqual(built.fingerprints);
    expect(built.fingerprints).toEqual([
      instructionFingerprint(program, Buffer.from('AQID', 'base64')),
    ]);
    expect(built.recentBlockhash).toBe(bh);
  });

  it('differs when the instruction data differs', () => {
    const bh = Keypair.generate().publicKey.toBase58();
    const a = compileUnsignedV0('panta', wallet, [ix('AQID')], bh).fingerprints;
    const b = compileUnsignedV0('panta', wallet, [ix('AQIE')], bh).fingerprints;
    expect(a).not.toEqual(b);
  });
});

describe('matchOrder', () => {
  const f1 = instructionFingerprint(program, Buffer.from([1]));
  const f2 = instructionFingerprint(program, Buffer.from([2]));

  it('needs every built fingerprint, the same fee payer and a block time in the order life', () => {
    const o = row({ ix_fingerprints: [f1, f2] });
    expect(matchOrder(landed([f1, f2, 'extra']), [o])).toBe(o);
    expect(matchOrder(landed([f1]), [o])).toBeNull();
    expect(
      matchOrder(landed([f1, f2], { feePayer: Keypair.generate().publicKey.toBase58() }), [o]),
    ).toBeNull();
    const late = Math.floor((o.expires_at.getTime() + 3600_000) / 1000);
    expect(matchOrder(landed([f1, f2], { blockTime: late }), [o])).toBeNull();
    const early = Math.floor((o.created_at.getTime() - 3600_000) / 1000);
    expect(matchOrder(landed([f1, f2], { blockTime: early }), [o])).toBeNull();
  });

  it('never matches an order without fingerprints (built before this change)', () => {
    expect(matchOrder(landed([f1]), [row({ ix_fingerprints: [] })])).toBeNull();
  });

  it('breaks a tie by blockhash, else takes the newest', () => {
    const older = row({ ix_fingerprints: [f1], recent_blockhash: 'a' });
    const newer = row({
      ix_fingerprints: [f1],
      recent_blockhash: 'b',
      created_at: new Date(Date.now() - 5_000),
    });
    expect(matchOrder(landed([f1], { recentBlockhash: 'a' }), [older, newer])).toBe(older);
    expect(matchOrder(landed([f1], { recentBlockhash: 'z' }), [older, newer])).toBe(newer);
  });
});
