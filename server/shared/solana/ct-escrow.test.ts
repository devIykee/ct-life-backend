/**
 * Decoder tests for the ct_escrow program events.
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
function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
function pubkey(seed: number): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = (seed + i) & 0xff;
  return b;
}
function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
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
  it('decodes a SessionOpened event', () => {
    const session = pubkey(1);
    const fan = pubkey(2);
    const creator = pubkey(3);
    const bytes = concat([
      disc('SessionOpened'),
      session,
      fan,
      creator,
      u64(42n),
      u64(1_000_000n),
      u16(5),
      u64(5_500_000n),
      u16(1_000),
      i64(1_700_000_000n),
    ]);
    const out = decodeCtEscrowEvent(Buffer.from(bytes).toString('base64'));
    expect(out).not.toBeNull();
    if (out?.kind !== 'opened') throw new Error('expected opened');
    expect(out.session).toBe(base58(session));
    expect(out.fan).toBe(base58(fan));
    expect(out.creator).toBe(base58(creator));
    expect(out.sessionId).toBe(42n);
    expect(out.ratePerMin).toBe(1_000_000n);
    expect(out.maxMinutes).toBe(5);
    expect(out.deposit).toBe(5_500_000n);
    expect(out.feeBps).toBe(1_000);
    expect(out.openedAt).toBe(1_700_000_000n);
  });

  it('decodes a SessionAccepted event', () => {
    const session = pubkey(11);
    const bytes = concat([disc('SessionAccepted'), session, i64(1_700_000_100n)]);
    const out = decodeCtEscrowEvent(Buffer.from(bytes).toString('base64'));
    expect(out).not.toBeNull();
    if (out?.kind !== 'accepted') throw new Error('expected accepted');
    expect(out.session).toBe(base58(session));
    expect(out.acceptedAt).toBe(1_700_000_100n);
  });

  it('decodes a SessionSettled event', () => {
    const session = pubkey(21);
    const bytes = concat([
      disc('SessionSettled'),
      session,
      u64(1n),
      u64(950_000n),
      u64(50_000n),
      u64(4_000_000n),
    ]);
    const out = decodeCtEscrowEvent(Buffer.from(bytes).toString('base64'));
    expect(out).not.toBeNull();
    if (out?.kind !== 'settled') throw new Error('expected settled');
    expect(out.session).toBe(base58(session));
    expect(out.minutes).toBe(1n);
    expect(out.creatorAmount).toBe(950_000n);
    expect(out.fee).toBe(50_000n);
    expect(out.refund).toBe(4_000_000n);
  });

  it('decodes a SessionRefunded event', () => {
    const session = pubkey(31);
    const fan = pubkey(32);
    const creator = pubkey(33);
    const bytes = concat([disc('SessionRefunded'), session, fan, creator, u64(5_000_000n)]);
    const out = decodeCtEscrowEvent(Buffer.from(bytes).toString('base64'));
    expect(out).not.toBeNull();
    if (out?.kind !== 'refunded') throw new Error('expected refunded');
    expect(out.refundAmount).toBe(5_000_000n);
  });

  it('returns null on a non-ct_escrow log', () => {
    const other = new Uint8Array(64);
    for (let i = 0; i < 64; i++) other[i] = i;
    expect(decodeCtEscrowEvent(Buffer.from(other).toString('base64'))).toBeNull();
  });

  it('returns null on an empty log', () => {
    expect(decodeCtEscrowEvent('')).toBeNull();
  });

  it('returns null on a too-short log', () => {
    const b64 = Buffer.from(new Uint8Array(4)).toString('base64');
    expect(decodeCtEscrowEvent(b64)).toBeNull();
  });
});
