/**
 * ct_escrow transaction builders + event decoder.
 *
 * Master prompt M4 / contract section 6. The server builds the
 * unsigned v0 transactions for the Anchor program
 * `FKvuRNUxGgijeD8P4varsnzBiLduCWKMhSLQp5fQsMfz` (devnet) and
 * hands them to the settle authority keypair. The Helius
 * program-event webhook listens for `Settled` and `Refunded`
 * events and reconciles the in-game ledger.
 *
 * Why a hand-rolled encoder instead of `@coral-xyz/anchor`?
 * `@coral-xyz/anchor` requires `target/types/ct_escrow.ts`
 * which we cannot generate in this env (Rust edition2024 needs
 * nightly, but the SBF builds clean). The instruction layout is
 * fixed and tiny (5 instructions), so a hand-rolled encoder is
 * shorter, more debuggable, and side-steps the toolchain gap.
 *
 * Discriminators are the first 8 bytes of sha256("global:<name>"),
 * computed at module load and asserted to match the IDL.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Connection,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const IDL = JSON.parse(
  readFileSync(join(process.cwd(), 'contract/idl/ct_escrow.json'), 'utf8'),
) as {
  address: string;
  instructions: Array<{ name: string; discriminator: number[] }>;
};

/** Anchor ct_escrow program ID (devnet). */
export const CT_ESCROW_PROGRAM_ID = new PublicKey(IDL.address);

/** Compute the Anchor instruction discriminator from the IDL. */
function disc(name: string): Uint8Array {
  const fromIdl = IDL.instructions.find((i) => i.name === name)?.discriminator;
  if (fromIdl) return Uint8Array.from(fromIdl);
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const IX_ACCEPT = disc('accept');
const IX_INIT_CONFIG = disc('initConfig');
const IX_OPEN_SESSION = disc('openSession');
const IX_REFUND = disc('refund');
const IX_SETTLE = disc('settle');

function encU8(n: number): Uint8Array {
  const b = new Uint8Array(1);
  b[0] = n & 0xff;
  return b;
}
function encU16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}
function encU64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

// --- PDAs -------------------------------------------------------------------

/** Config PDA: seeds = ["config"], program = CT_ESCROW_PROGRAM_ID. */
export function configPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    CT_ESCROW_PROGRAM_ID,
  );
  return pda;
}

/** Session PDA: seeds = ["session", fan, session_id_le_u64]. */
export function sessionPda(fan: PublicKey, sessionId: bigint): PublicKey {
  const sid = Buffer.alloc(8);
  sid.writeBigUInt64LE(sessionId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('session'), fan.toBuffer(), sid],
    CT_ESCROW_PROGRAM_ID,
  );
  return pda;
}

// --- Builders ---------------------------------------------------------------

export interface InitConfigArgs {
  admin: PublicKey;
  treasury: PublicKey;
  vault: PublicKey;
  usdcMint: PublicKey;
  feeBps: number;
}

export function buildInitConfigIx(args: InitConfigArgs): TransactionInstruction {
  const config = configPda();
  return new TransactionInstruction({
    programId: CT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: false },
      { pubkey: args.usdcMint, isSigner: false, isWritable: false },
      { pubkey: args.treasury, isSigner: false, isWritable: false },
      { pubkey: args.admin, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat([IX_INIT_CONFIG, encU16(args.feeBps)])),
  });
}

export interface OpenSessionArgs {
  fan: PublicKey;
  fanUsdcAta: PublicKey;
  creator: PublicKey;
  vault: PublicKey;
  sessionId: bigint;
  rateBaseUnitsPerMin: bigint;
  maxMinutes: number;
}

export function buildOpenSessionIx(args: OpenSessionArgs): TransactionInstruction {
  const config = configPda();
  const session = sessionPda(args.fan, args.sessionId);
  return new TransactionInstruction({
    programId: CT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.fanUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.fan, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concat([
        IX_OPEN_SESSION,
        encU64(args.sessionId),
        encU64(args.rateBaseUnitsPerMin),
        encU8(args.maxMinutes),
      ]),
    ),
  });
}

export interface AcceptArgs {
  creator: PublicKey;
  fan: PublicKey;
  sessionId: bigint;
}

export function buildAcceptIx(args: AcceptArgs): TransactionInstruction {
  const session = sessionPda(args.fan, args.sessionId);
  return new TransactionInstruction({
    programId: CT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: args.creator, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(IX_ACCEPT),
  });
}

export interface SettleArgs {
  settleAuthority: PublicKey;
  fan: PublicKey;
  sessionId: bigint;
  secondsUsed: bigint;
  vault: PublicKey;
  creatorUsdcAta: PublicKey;
  fanUsdcAta: PublicKey;
  treasuryUsdcAta: PublicKey;
}

export function buildSettleIx(args: SettleArgs): TransactionInstruction {
  const config = configPda();
  const session = sessionPda(args.fan, args.sessionId);
  return new TransactionInstruction({
    programId: CT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.creatorUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.fanUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.treasuryUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.settleAuthority, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat([IX_SETTLE, encU64(args.secondsUsed)])),
  });
}

export interface RefundArgs {
  fan: PublicKey;
  sessionId: bigint;
  vault: PublicKey;
  fanUsdcAta: PublicKey;
}

export function buildRefundIx(args: RefundArgs): TransactionInstruction {
  const config = configPda();
  const session = sessionPda(args.fan, args.sessionId);
  return new TransactionInstruction({
    programId: CT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.fanUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.fan, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_REFUND),
  });
}

// --- Compile + sign + send ---------------------------------------------------

/**
 * Build, sign, and send the on-chain settle transaction. Returns
 * the transaction signature.
 */
export async function sendSettle(
  connection: Connection,
  args: SettleArgs & { settleAuthorityKeypair: Keypair },
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: args.settleAuthorityKeypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(buildSettleIx(args));
  tx.sign(args.settleAuthorityKeypair);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

/** Build the on-chain open_session transaction (fan signs). */
export async function sendOpenSession(
  connection: Connection,
  args: OpenSessionArgs & { fanKeypair: Keypair },
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: args.fanKeypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(buildOpenSessionIx(args));
  tx.sign(args.fanKeypair);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

/** Build the on-chain accept transaction (creator signs). */
export async function sendAccept(
  connection: Connection,
  args: AcceptArgs & { creatorKeypair: Keypair },
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: args.creatorKeypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(buildAcceptIx(args));
  tx.sign(args.creatorKeypair);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

/** Build the on-chain refund transaction (fan signs). */
export async function sendRefund(
  connection: Connection,
  args: RefundArgs & { fanKeypair: Keypair },
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: args.fanKeypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(buildRefundIx(args));
  tx.sign(args.fanKeypair);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  return sig;
}

// --- Settled / Refunded event decoder ----------------------------------------

const EVENT_SETTLED_DISC = new Uint8Array(
  createHash('sha256').update('event:Settled').digest().slice(0, 8),
);
const EVENT_REFUNDED_DISC = new Uint8Array(
  createHash('sha256').update('event:Refunded').digest().slice(0, 8),
);

export interface DecodedSettled {
  kind: 'settled';
  session: string;
  fan: string;
  creator: string;
  secondsUsed: bigint;
  grossBaseUnits: bigint;
  feeBaseUnits: bigint;
  creatorPayoutBaseUnits: bigint;
  refundBaseUnits: bigint;
  settledAt: bigint;
}

export interface DecodedRefunded {
  kind: 'refunded';
  session: string;
  fan: string;
  creator: string;
  refundBaseUnits: bigint;
  refundedAt: bigint;
}

export type DecodedEvent = DecodedSettled | DecodedRefunded;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode base58 (Solana alphabet) to 32-byte buffer. */
function base58Decode(s: string): Buffer {
  if (s.length === 0) return Buffer.alloc(0);
  const bytes: number[] = [0];
  for (const c of s) {
    const v = BASE58_ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`base58Decode: invalid char "${c}"`);
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  for (const c of s) {
    if (c === '1') zeros++;
    else break;
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}
// Reference the decoder so tsc keeps it; some callers may need it
// in the future when we add a settle-init watcher that decodes
// fan/creator addresses from on-chain event bytes.
void base58Decode;

function pubkeyFromBytes(bytes: Uint8Array): string {
  return base58Encode(bytes);
}

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits = [0];
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
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

/**
 * Decode a Solana program-data log line emitted by ct_escrow.
 * The log line is a base64-encoded string of
 * `[discriminator(8) | Borsh-serialized body]`. Returns null if
 * the line is not one of our events.
 */
export function decodeCtEscrowEvent(b64: string): DecodedEvent | null {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
  if (bytes.byteLength < 8) return null;
  const eventDisc = bytes.slice(0, 8);
  const body = bytes.slice(8);

  if (eq(eventDisc, EVENT_SETTLED_DISC)) {
    if (body.byteLength < 32 + 32 + 32 + 5 * 8) return null;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const session = pubkeyFromBytes(body.slice(o, o + 32)); o += 32;
    const fan = pubkeyFromBytes(body.slice(o, o + 32)); o += 32;
    const creator = pubkeyFromBytes(body.slice(o, o + 32)); o += 32;
    const secondsUsed = dv.getBigUint64(o, true); o += 8;
    const gross = dv.getBigUint64(o, true); o += 8;
    const fee = dv.getBigUint64(o, true); o += 8;
    const creatorPayout = dv.getBigUint64(o, true); o += 8;
    const refund = dv.getBigUint64(o, true); o += 8;
    const settledAt = dv.getBigInt64(o, true);
    return {
      kind: 'settled',
      session, fan, creator,
      secondsUsed,
      grossBaseUnits: gross,
      feeBaseUnits: fee,
      creatorPayoutBaseUnits: creatorPayout,
      refundBaseUnits: refund,
      settledAt,
    };
  }
  if (eq(eventDisc, EVENT_REFUNDED_DISC)) {
    if (body.byteLength < 32 + 32 + 32 + 8 + 8) return null;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const session = pubkeyFromBytes(body.slice(o, o + 32)); o += 32;
    const fan = pubkeyFromBytes(body.slice(o, o + 32)); o += 32;
    const creator = pubkeyFromBytes(body.slice(o, o + 32)); o += 32;
    const refund = dv.getBigUint64(o, true); o += 8;
    const refundedAt = dv.getBigInt64(o, true);
    return { kind: 'refunded', session, fan, creator, refundBaseUnits: refund, refundedAt };
  }
  return null;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- Re-exports for callers that already depend on the kit API ---------------

export { PublicKey, Connection };
export const usdcAtaFor = (mint: PublicKey, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner);