/**
 * Paid-call chain pieces that need no RPC: settle and refund recreate the fan's token
 * account first (a fan closing it cannot block settle), the open_session signature check,
 * and closure classification from logs (forged events from other programs are ignored).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  checkOpenTransaction,
  classifyClosure,
  escrowEventsFromLogs,
  refundInstructions,
  settleInstructions,
  type RpcTx,
} from './paid-call-chain.js';
import { CT_ESCROW_PROGRAM_ID, sessionPda } from '../shared/solana/ct-escrow.js';

const USDC = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const authority = Keypair.generate().publicKey;
const fan = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const ref = { fan: fan.toBase58(), creator: creator.toBase58(), sessionId: 7n };
const pda = sessionPda(fan, creator, 7n).toBase58();
const fanAta = getAssociatedTokenAddressSync(USDC, fan);
const cfg = { usdcMint: USDC.toBase58(), treasury: treasury.toBase58() };
const PROGRAM = CT_ESCROW_PROGRAM_ID.toBase58();

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = `1${out}`;
    else break;
  }
  return out;
}
const disc = (s: string): Buffer => createHash('sha256').update(s).digest().subarray(0, 8);

describe('settle and refund recreate the fan token account first', () => {
  it('settle: fan, creator and treasury ATAs (idempotent, authority pays), then settle', () => {
    const ixs = settleInstructions({ authority, cfg, ref, secondsUsed: 60n });
    expect(ixs).toHaveLength(4);
    for (const ix of ixs.slice(0, 3)) {
      expect(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
      expect(ix.data[0]).toBe(1); // CreateIdempotent
      expect(ix.keys[0]!.pubkey.equals(authority)).toBe(true);
    }
    expect(ixs[0]!.keys[1]!.pubkey.equals(fanAta)).toBe(true);
    expect(ixs[3]!.programId.equals(CT_ESCROW_PROGRAM_ID)).toBe(true);
  });

  it('refund: the fan ATA (idempotent) before refund', () => {
    const ixs = refundInstructions({ authority, cfg, ref });
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[0]!.data[0]).toBe(1);
    expect(ixs[0]!.keys[1]!.pubkey.equals(fanAta)).toBe(true);
    expect(ixs[1]!.programId.equals(CT_ESCROW_PROGRAM_ID)).toBe(true);
  });
});

function openTx(
  opts: {
    err?: unknown;
    signer?: string;
    program?: string;
    session?: string;
    data?: Uint8Array;
    loaded?: boolean;
  } = {},
): RpcTx {
  const signer = opts.signer ?? ref.fan;
  const program = opts.program ?? PROGRAM;
  const keys = [signer, opts.session ?? pda, Keypair.generate().publicKey.toBase58()];
  const loaded = opts.loaded ? [program] : [];
  if (!opts.loaded) keys.push(program);
  return {
    meta: {
      err: opts.err ?? null,
      logMessages: [],
      loadedAddresses: { writable: [], readonly: loaded },
    },
    transaction: {
      message: {
        accountKeys: keys,
        header: { numRequiredSignatures: 1 },
        instructions: [
          {
            programIdIndex: opts.loaded ? keys.length : keys.indexOf(program),
            accounts: [1, 2, 0],
            data: b58(opts.data ?? Buffer.concat([disc('global:open_session'), Buffer.alloc(18)])),
          },
        ],
      },
    },
  };
}

describe('checkOpenTransaction', () => {
  it('accepts a successful fan-signed open_session of this PDA (static or loaded program key)', () => {
    expect(checkOpenTransaction(openTx(), ref)).toBe('ok');
    expect(checkOpenTransaction(openTx({ loaded: true }), ref)).toBe('ok');
  });
  it('refuses missing, failed, not fan-signed, other program, other PDA, other instruction', () => {
    expect(checkOpenTransaction(null, ref)).toBe('not_found');
    expect(checkOpenTransaction(openTx({ err: { InstructionError: [0, 'Custom'] } }), ref)).toBe(
      'failed',
    );
    expect(
      checkOpenTransaction(openTx({ signer: Keypair.generate().publicKey.toBase58() }), ref),
    ).toBe('mismatch');
    expect(
      checkOpenTransaction(openTx({ program: Keypair.generate().publicKey.toBase58() }), ref),
    ).toBe('mismatch');
    expect(
      checkOpenTransaction(openTx({ session: Keypair.generate().publicKey.toBase58() }), ref),
    ).toBe('mismatch');
    expect(
      checkOpenTransaction(
        openTx({ data: Buffer.concat([disc('global:settle'), Buffer.alloc(8)]) }),
        ref,
      ),
    ).toBe('mismatch');
  });
});

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
const settledEvent = (session: string): string =>
  Buffer.concat([
    disc('event:SessionSettled'),
    new PublicKey(session).toBuffer(),
    u64(2n),
    u64(1_000_000n),
    u64(100_000n),
    u64(1_650_000n),
  ]).toString('base64');
const refundedEvent = (session: string): string =>
  Buffer.concat([
    disc('event:SessionRefunded'),
    new PublicKey(session).toBuffer(),
    fan.toBuffer(),
    creator.toBuffer(),
    u64(2_750_000n),
  ]).toString('base64');

const okTx = (logs: string[]): RpcTx => ({ ...openTx(), meta: { err: null, logMessages: logs } });

describe('closure from logs', () => {
  it('reads events only while ct_escrow is executing', () => {
    const other = Keypair.generate().publicKey.toBase58();
    const logs = [
      `Program ${other} invoke [1]`,
      `Program data: ${settledEvent(pda)}`, // forged by another program
      `Program ${other} success`,
      `Program ${PROGRAM} invoke [1]`,
      `Program data: ${refundedEvent(pda)}`,
      `Program ${PROGRAM} success`,
    ];
    const evs = escrowEventsFromLogs(logs);
    expect(evs.map((e) => e.kind)).toEqual(['refunded']);
  });

  it('classifies settle, refund, and nothing found', () => {
    const inEscrow = (data: string) => [
      `Program ${PROGRAM} invoke [1]`,
      `Program data: ${data}`,
      `Program ${PROGRAM} success`,
    ];
    expect(
      classifyClosure([{ signature: 's1', tx: okTx(inEscrow(settledEvent(pda))) }], pda),
    ).toEqual({
      kind: 'settled',
      signature: 's1',
      creatorAmount: 1_000_000n,
      fee: 100_000n,
      refund: 1_650_000n,
      minutes: 2n,
    });
    expect(
      classifyClosure([{ signature: 's2', tx: okTx(inEscrow(refundedEvent(pda))) }], pda),
    ).toEqual({ kind: 'refunded', signature: 's2', refundAmount: 2_750_000n });
    // Another session's event, a failed tx, or nothing: null.
    const otherPda = Keypair.generate().publicKey.toBase58();
    const failed = { ...okTx(inEscrow(settledEvent(pda))) };
    failed.meta = { err: { x: 1 }, logMessages: inEscrow(settledEvent(pda)) };
    expect(
      classifyClosure(
        [
          { signature: 'a', tx: okTx(inEscrow(settledEvent(otherPda))) },
          { signature: 'b', tx: failed },
          { signature: 'c', tx: null },
        ],
        pda,
      ),
    ).toBeNull();
  });
});
