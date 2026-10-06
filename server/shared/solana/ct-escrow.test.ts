/**
 * Pure-TS unit tests for the ct_escrow event decoder.
 *
 * The decoder reads Solana program-data log lines (base64) and
 * decodes the Settled / Refunded events. We hand-construct the
 * binary payloads (matching the on-chain Borsh layout) and
 * verify the decoder produces the right fields.
 *
 * Run: `pnpm exec vitest run server/shared/solana/ct-escrow.test.ts`
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeCtEscrowEvent } from './ct-escrow.js';

function disc(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`event:${name}`).digest().slice(0, 8));
}

function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

function i64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
}

function pubkey(seed: number): Uint8Array {
  // Deterministic 32-byte "address" — fill with the seed for
  // each byte so each test gets a distinct value.
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = (seed + i) & 0xff;
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function base58(bytes: Uint8Array): string {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (bytes.length === 0) return '';
  const digits: number[] = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let zeros = 0;
  for (const b of bytes) {
    if (b === 0) zeros++;
    else break;
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHA[digits[i]!];
  return out;
}

describe('ct_escrow event decoder', () => {
  it('decodes a Settled event', () => {
    const session = pubkey(1);
    const fan = pubkey(2);
    const creator = pubkey(3);
    const bytes = concat([
      disc('Settled'),
      session,
      fan,
      creator,
      u64(60n),                  // seconds_used
      u64(1_000_000n),           // gross
      u64(50_000n),              // fee
      u64(950_000n),             // creator_payout
      u64(4_000_000n),           // refund
      i64(1_700_000_000n),       // settled_at
    ]);
    const b64 = Buffer.from(bytes).toString('base64');
    const out = decodeCtEscrowEvent(b64);
    expect(out).not.toBeNull();
    if (out?.kind !== 'settled') throw new Error('expected settled');
    expect(out.session).toBe(base58(session));
    expect(out.fan).toBe(base58(fan));
    expect(out.creator).toBe(base58(creator));
    expect(out.secondsUsed).toBe(60n);
    expect(out.grossBaseUnits).toBe(1_000_000n);
    expect(out.feeBaseUnits).toBe(50_000n);
    expect(out.creatorPayoutBaseUnits).toBe(950_000n);
    expect(out.refundBaseUnits).toBe(4_000_000n);
    expect(out.settledAt).toBe(1_700_000_000n);
  });

  it('decodes a Refunded event', () => {
    const session = pubkey(11);
    const fan = pubkey(12);
    const creator = pubkey(13);
    const bytes = concat([
      disc('Refunded'),
      session,
      fan,
      creator,
      u64(5_000_000n),          // refund_base_units
      i64(1_700_000_001n),
    ]);
    const b64 = Buffer.from(bytes).toString('base64');
    const out = decodeCtEscrowEvent(b64);
    expect(out).not.toBeNull();
    if (out?.kind !== 'refunded') throw new Error('expected refunded');
    expect(out.refundBaseUnits).toBe(5_000_000n);
    expect(out.refundedAt).toBe(1_700_000_001n);
  });

  it('returns null on a non-ct_escrow log line', () => {
    const other = new Uint8Array(64);
    for (let i = 0; i < 64; i++) other[i] = i;
    const b64 = Buffer.from(other).toString('base64');
    expect(decodeCtEscrowEvent(b64)).toBeNull();
  });

  it('returns null on an empty log', () => {
    expect(decodeCtEscrowEvent('')).toBeNull();
  });

  it('returns null on a too-short log', () => {
    const b64 = Buffer.from(new Uint8Array(4)).toString('base64');
    expect(decodeCtEscrowEvent(b64)).toBeNull();
  });
});