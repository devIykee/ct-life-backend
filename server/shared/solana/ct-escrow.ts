/**
 * ct_escrow transaction builders + event decoder.
 *
 * Master prompt M4 / spec section 6. The server builds the
 * unsigned v0 transactions for the Anchor program
 * `FKvuRNUxGgijeD8P4varsnzBiLduCWKMhSLQp5fQsMfz` (devnet) and
 * hands them to the settle authority keypair. The Helius
 * program-event webhook listens for `SessionOpened`,
 * `SessionAccepted`, `SessionSettled`, and `SessionRefunded`
 * events and reconciles the in-game ledger.
 *
 * ACCOUNT LISTS: the builders follow `programs/ct_escrow/programs/ct_escrow/src/lib.rs`
 * as it is in this repo (Accounts structs, in field order). That source is NOT what is
 * deployed on devnet as of 2026-10-30: the devnet binary is the earlier commit 2afe8fc
 * (the one `contract/idl/ct_escrow.json` describes; creator-signed accept, no settle
 * authority check). The program must be upgraded from the current lib.rs before paid
 * calls are turned on; `tools/scripts/escrow-init-config.ts` refuses to run against the old
 * binary. See docs/ONCHAIN.md "Paid-call escrow on devnet".
 *
 * Spec key points (contract section 6):
 *   • Config PDA seeds ["config"]. Stores admin, settle_authority,
 *     treasury, usdc_mint, vault, fee_bps (default 1000),
 *     accept_window_secs (default 120).
 *   • Session PDA seeds ["session", fan, creator, session_id_le_bytes].
 *   • open_session moves rate × max_minutes × (1 + fee_bps/10000)
 *     from fan to the Session PDA's USDC ATA (the vault).
 *   • accept and settle are signed by the settle authority, not
 *     the creator. (The creator is the receiving party; the
 *     backend's settle authority is the one that calls Anchor.)
 *   • settle pays creator (rate × minutes), treasury (rate × min
 *     × fee_bps / 10000), refunds remainder to fan, closes vault
 *     + Session (rent to fan).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Connection,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';

const IDL = JSON.parse(
  readFileSync(join(process.cwd(), 'contract/idl/ct_escrow.json'), 'utf8'),
) as {
  address: string;
  instructions: Array<{ name: string; discriminator: number[] }>;
};

/** Anchor ct_escrow program ID (devnet). */
export const CT_ESCROW_PROGRAM_ID: PublicKey = new PublicKey(IDL.address);

function disc(name: string): Uint8Array {
  const fromIdl = IDL.instructions.find((i) => i.name === name)?.discriminator;
  if (fromIdl) return Uint8Array.from(fromIdl);
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const IX_INIT_CONFIG = disc('init_config');
const IX_OPEN_SESSION = disc('open_session');
const IX_ACCEPT = disc('accept');
const IX_SETTLE = disc('settle');
const IX_REFUND = disc('refund');

/** Spec defaults. */
export const DEFAULT_FEE_BPS = 1_000; // 10%
export const DEFAULT_ACCEPT_WINDOW_SECS = 120;
export const MIN_RATE_BASE_UNITS = 250_000n; // 0.25 USDC
export const MAX_RATE_BASE_UNITS = 50_000_000n; // 50 USDC
export const FEE_BPS_DENOM = 10_000n;

function encU16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}
function encU32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
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
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

// --- PDAs -------------------------------------------------------------------

/** Config PDA: seeds = ["config"], program = CT_ESCROW_PROGRAM_ID. */
/**
 * Derives the Config PDA for ct_escrow (seeds: ["config"]).
 */
export function configPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('config')], CT_ESCROW_PROGRAM_ID);
  return pda;
}

/**
 * Session PDA: seeds = ["session", fan, creator, session_id_le_bytes].
 * Per spec section 6: the creator address is part of the seed
 * tuple so a given (fan, session_id) pair can only have one
 * creator.
 */
/**
 * Derives the Session PDA for ct_escrow (seeds: ["session", fan, creator, session_id_le_bytes]).
 */
export function sessionPda(fan: PublicKey, creator: PublicKey, sessionId: bigint): PublicKey {
  const sid = Buffer.alloc(8);
  sid.writeBigUInt64LE(sessionId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('session'), fan.toBuffer(), creator.toBuffer(), sid],
    CT_ESCROW_PROGRAM_ID,
  );
  return pda;
}

/**
 * The session's vault: the Session PDA's associated token account for `usdcMint`
 * (OpenSession `associated_token::authority = session`).
 */
export function sessionVault(session: PublicKey, usdcMint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [session.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), usdcMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/**
 * Compute the on-chain deposit amount.
 *
 * Spec: rate × max_minutes × (1 + fee_bps/10000). The single
 * deposit at open_session covers creator's eventual payout, the
 * fee, and any refund.
 */
/**
 * Computes the required deposit: rate × max_minutes × (1 + fee_bps/10000).
 */
export function computeDeposit(
  rateBaseUnitsPerMin: bigint,
  maxMinutes: number,
  feeBps: number,
): bigint {
  const factor = FEE_BPS_DENOM + BigInt(feeBps);
  return (rateBaseUnitsPerMin * BigInt(maxMinutes) * factor) / FEE_BPS_DENOM;
}

// --- Builders ---------------------------------------------------------------

export interface InitConfigArgs {
  admin: PublicKey;
  settleAuthority: PublicKey;
  treasury: PublicKey;
  usdcMint: PublicKey;
  vault: PublicKey;
  feeBps: number;
  acceptWindowSecs: number;
}

/**
 * Builds the init_config instruction (admin-only, one-time setup).
 */
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
      { pubkey: args.settleAuthority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat([IX_INIT_CONFIG, encU16(args.feeBps), encU32(args.acceptWindowSecs)])),
  });
}

export interface OpenSessionArgs {
  fan: PublicKey;
  fanUsdcAta: PublicKey;
  creator: PublicKey;
  /** The USDC mint (config.usdc_mint). */
  usdcMint: PublicKey;
  /** Optional pre-computed deposit. If undefined, computed from
   *  rate × max_minutes × (1 + DEFAULT_FEE_BPS/10000). Pass the
   *  on-chain Config fee_bps in production via this arg. */
  depositOverride?: bigint;
  sessionId: bigint;
  rateBaseUnitsPerMin: bigint;
  maxMinutes: number;
  feeBps: number;
}

/**
 * Builds the open_session instruction (fan deposits funds into escrow).
 */
export function buildOpenSessionIx(args: OpenSessionArgs): TransactionInstruction {
  const config = configPda();
  const session = sessionPda(args.fan, args.creator, args.sessionId);
  // Deposit amount is computed by the on-chain program from rate × max_minutes × fee
  // Not passed in instruction data; this calculation is for reference only.
  // Accounts: OpenSession in lib.rs (the vault is the session PDA's USDC ATA).
  return new TransactionInstruction({
    programId: CT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: sessionVault(session, args.usdcMint), isSigner: false, isWritable: true },
      { pubkey: args.usdcMint, isSigner: false, isWritable: false },
      { pubkey: args.fanUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.creator, isSigner: false, isWritable: false },
      { pubkey: args.fan, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concat([
        IX_OPEN_SESSION,
        encU64(args.sessionId),
        encU64(args.rateBaseUnitsPerMin),
        encU16(args.maxMinutes),
      ]),
    ),
  });
}
export interface AcceptArgs {
  settleAuthority: PublicKey;
  fan: PublicKey;
  creator: PublicKey;
  sessionId: bigint;
}

/**
 * Builds the accept instruction (settle authority moves session from Pending to Active).
 */
export function buildAcceptIx(args: AcceptArgs): TransactionInstruction {
  const config = configPda();
  const session = sessionPda(args.fan, args.creator, args.sessionId);
  return new TransactionInstruction({
    programId: CT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: args.settleAuthority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(IX_ACCEPT),
  });
}

export interface SettleArgs {
  settleAuthority: PublicKey;
  fan: PublicKey;
  creator: PublicKey;
  sessionId: bigint;
  secondsUsed: bigint;
  vault: PublicKey;
  usdcMint: PublicKey;
  creatorUsdcAta: PublicKey;
  fanUsdcAta: PublicKey;
  treasuryUsdcAta: PublicKey;
}

/**
 * Builds the settle instruction (settle authority closes session, pays creator and treasury, refunds fan).
 */
export function buildSettleIx(args: SettleArgs): TransactionInstruction {
  const config = configPda();
  const session = sessionPda(args.fan, args.creator, args.sessionId);
  return new TransactionInstruction({
    programId: CT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.usdcMint, isSigner: false, isWritable: false },
      { pubkey: args.creatorUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.fanUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.treasuryUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.settleAuthority, isSigner: true, isWritable: false },
      { pubkey: args.fan, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat([IX_SETTLE, encU64(args.secondsUsed)])),
  });
}

export interface RefundArgs {
  fan: PublicKey;
  creator: PublicKey;
  sessionId: bigint;
  vault: PublicKey;
  usdcMint: PublicKey;
  fanUsdcAta: PublicKey;
  /** Either the fan or the settle_authority. */
  signer: PublicKey;
}

/**
 * Builds the refund instruction (settle authority refunds fan before accept or after grace period).
 */
export function buildRefundIx(args: RefundArgs): TransactionInstruction {
  const config = configPda();
  const session = sessionPda(args.fan, args.creator, args.sessionId);
  return new TransactionInstruction({
    programId: CT_ESCROW_PROGRAM_ID,
    keys: [
      { pubkey: session, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.usdcMint, isSigner: false, isWritable: false },
      { pubkey: args.fanUsdcAta, isSigner: false, isWritable: true },
      { pubkey: args.signer, isSigner: true, isWritable: false },
      { pubkey: args.fan, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(IX_REFUND),
  });
}

// --- Compile + sign + send ---------------------------------------------------

export interface SendSettleExtra {
  settleAuthorityKeypair: Keypair;
}

/**
 * Sends a settle transaction on-chain (devnet/mainnet).
 */
export async function sendSettle(
  args: SettleArgs & SendSettleExtra & { connection: Connection },
): Promise<string> {
  const connection = args.connection;
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

/**
 * Sends an open_session transaction on-chain (devnet/mainnet).
 */
export async function sendOpenSession(
  args: OpenSessionArgs & { fanKeypair: Keypair } & { connection: Connection },
): Promise<string> {
  const connection = args.connection;
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

/**
 * Sends an accept transaction on-chain (devnet/mainnet).
 */
export async function sendAccept(
  args: AcceptArgs & { settleAuthorityKeypair: Keypair } & { connection: Connection },
): Promise<string> {
  const connection = args.connection;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: args.settleAuthorityKeypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(buildAcceptIx(args));
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

// --- Settled / Refunded event decoder ----------------------------------------

const EVENT_OPENED_DISC = new Uint8Array(
  createHash('sha256').update('event:SessionOpened').digest().slice(0, 8),
);
const EVENT_ACCEPTED_DISC = new Uint8Array(
  createHash('sha256').update('event:SessionAccepted').digest().slice(0, 8),
);
const EVENT_SETTLED_DISC = new Uint8Array(
  createHash('sha256').update('event:SessionSettled').digest().slice(0, 8),
);
const EVENT_REFUNDED_DISC = new Uint8Array(
  createHash('sha256').update('event:SessionRefunded').digest().slice(0, 8),
);

export interface DecodedOpened {
  kind: 'opened';
  session: string;
  fan: string;
  creator: string;
  sessionId: bigint;
  ratePerMin: bigint;
  maxMinutes: number;
  deposit: bigint;
  feeBps: number;
  openedAt: bigint;
}

export interface DecodedAccepted {
  kind: 'accepted';
  session: string;
  acceptedAt: bigint;
}

export interface DecodedSettled {
  kind: 'settled';
  session: string;
  minutes: bigint;
  creatorAmount: bigint;
  fee: bigint;
  refund: bigint;
}

export interface DecodedRefunded {
  kind: 'refunded';
  session: string;
  fan: string;
  creator: string;
  refundAmount: bigint;
}

export type DecodedEvent = DecodedOpened | DecodedAccepted | DecodedSettled | DecodedRefunded;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/**
 * Decodes a base58 string to a Buffer (for Solana pubkey decoding).
 */
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

function pubkeyFromBytes(bytes: Uint8Array): string {
  return base58Encode(bytes);
}

/** Decode a Solana program-data log line emitted by ct_escrow. */
/**
 * Decodes a ct_escrow program event from base64 (SessionOpened, SessionAccepted, SessionSettled, SessionRefunded).
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

  if (eq(eventDisc, EVENT_OPENED_DISC)) {
    if (body.byteLength < 32 + 32 + 32 + 8 + 8 + 2 + 8 + 8) return null;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const session = pubkeyFromBytes(body.slice(o, o + 32));
    o += 32;
    const fan = pubkeyFromBytes(body.slice(o, o + 32));
    o += 32;
    const creator = pubkeyFromBytes(body.slice(o, o + 32));
    o += 32;
    const sessionId = dv.getBigUint64(o, true);
    o += 8;
    const ratePerMin = dv.getBigUint64(o, true);
    o += 8;
    const maxMinutes = dv.getUint16(o, true);
    o += 2;
    const deposit = dv.getBigUint64(o, true);
    o += 8;
    const feeBps = dv.getUint16(o, true);
    o += 2;
    const openedAt = dv.getBigInt64(o, true);
    return {
      kind: 'opened',
      session,
      fan,
      creator,
      sessionId,
      ratePerMin,
      maxMinutes,
      deposit,
      feeBps,
      openedAt,
    };
  }
  if (eq(eventDisc, EVENT_ACCEPTED_DISC)) {
    if (body.byteLength < 32 + 8) return null;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const session = pubkeyFromBytes(body.slice(o, o + 32));
    o += 32;
    const acceptedAt = dv.getBigInt64(o, true);
    return { kind: 'accepted', session, acceptedAt };
  }
  if (eq(eventDisc, EVENT_SETTLED_DISC)) {
    if (body.byteLength < 32 + 8 + 8 + 8 + 8) return null;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const session = pubkeyFromBytes(body.slice(o, o + 32));
    o += 32;
    const minutes = dv.getBigUint64(o, true);
    o += 8;
    const creatorAmount = dv.getBigUint64(o, true);
    o += 8;
    const fee = dv.getBigUint64(o, true);
    o += 8;
    const refund = dv.getBigUint64(o, true);
    return { kind: 'settled', session, minutes, creatorAmount, fee, refund };
  }
  if (eq(eventDisc, EVENT_REFUNDED_DISC)) {
    if (body.byteLength < 32 + 32 + 32 + 8) return null;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const session = pubkeyFromBytes(body.slice(o, o + 32));
    o += 32;
    const fan = pubkeyFromBytes(body.slice(o, o + 32));
    o += 32;
    const creator = pubkeyFromBytes(body.slice(o, o + 32));
    o += 32;
    const refundAmount = dv.getBigUint64(o, true);
    return { kind: 'refunded', session, fan, creator, refundAmount };
  }
  return null;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- Account decoders (current lib.rs layouts, Borsh) --------------------------

const ACCOUNT_CONFIG_DISC = new Uint8Array(
  createHash('sha256').update('account:Config').digest().slice(0, 8),
);
const ACCOUNT_SESSION_DISC = new Uint8Array(
  createHash('sha256').update('account:Session').digest().slice(0, 8),
);

/** The Config account (lib.rs `Config`). */
export interface EscrowConfig {
  admin: string;
  settleAuthority: string;
  treasury: string;
  usdcMint: string;
  vault: string;
  feeBps: number;
  acceptWindowSecs: number;
}

/**
 * Decode the Config PDA's data. Returns null for anything that is not the current
 * layout (including a Config written by the old devnet binary, which is 107 bytes).
 */
export function decodeEscrowConfig(data: Uint8Array): EscrowConfig | null {
  if (data.byteLength < 8 + 32 * 5 + 2 + 4 + 1) return null;
  if (!eq(data.slice(0, 8), ACCOUNT_CONFIG_DISC)) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (o: number): string => pubkeyFromBytes(data.slice(o, o + 32));
  return {
    admin: key(8),
    settleAuthority: key(40),
    treasury: key(72),
    usdcMint: key(104),
    vault: key(136),
    feeBps: dv.getUint16(168, true),
    acceptWindowSecs: dv.getUint32(170, true),
  };
}

/** The Session account (lib.rs `Session`). status: 0 Open, 1 Accepted, 2 Settled, 3 Refunded. */
export interface EscrowSession {
  sessionId: bigint;
  fan: string;
  creator: string;
  ratePerMin: bigint;
  maxMinutes: number;
  deposit: bigint;
  feeBps: number;
  openedAt: bigint;
  acceptedAt: bigint;
  settledAt: bigint;
  status: number;
}

/** Decode a Session PDA's data, or null when it is not a current-layout Session. */
export function decodeEscrowSession(data: Uint8Array): EscrowSession | null {
  if (data.byteLength < 8 + 8 + 32 + 32 + 8 + 2 + 8 + 2 + 8 + 8 + 8 + 1) return null;
  if (!eq(data.slice(0, 8), ACCOUNT_SESSION_DISC)) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const sessionId = dv.getBigUint64(o, true);
  o += 8;
  const fan = pubkeyFromBytes(data.slice(o, o + 32));
  o += 32;
  const creator = pubkeyFromBytes(data.slice(o, o + 32));
  o += 32;
  const ratePerMin = dv.getBigUint64(o, true);
  o += 8;
  const maxMinutes = dv.getUint16(o, true);
  o += 2;
  const deposit = dv.getBigUint64(o, true);
  o += 8;
  const feeBps = dv.getUint16(o, true);
  o += 2;
  const openedAt = dv.getBigInt64(o, true);
  o += 8;
  const acceptedAt = dv.getBigInt64(o, true);
  o += 8;
  const settledAt = dv.getBigInt64(o, true);
  o += 8;
  const status = dv.getUint8(o);
  return {
    sessionId,
    fan,
    creator,
    ratePerMin,
    maxMinutes,
    deposit,
    feeBps,
    openedAt,
    acceptedAt,
    settledAt,
    status,
  };
}

/** Test helper: the 8-byte account discriminators. */
export const ACCOUNT_DISCRIMINATORS = {
  config: ACCOUNT_CONFIG_DISC,
  session: ACCOUNT_SESSION_DISC,
} as const;

/**
 * The split `settle(seconds_used)` makes on chain (lib.rs): minutes = ceil(seconds/60)
 * capped at max; creator gets rate x minutes; the treasury fee is floor(gross x fee_bps
 * / 10000) on top; the fan gets the rest of the deposit back.
 */
export function settlementSplit(args: {
  ratePerMin: bigint;
  maxMinutes: number;
  feeBps: number;
  deposit: bigint;
  secondsUsed: bigint;
}): { minutes: bigint; creatorAmount: bigint; fee: bigint; refund: bigint } {
  const maxSecs = BigInt(args.maxMinutes) * 60n;
  const secs = args.secondsUsed < maxSecs ? args.secondsUsed : maxSecs;
  let minutes = (secs + 59n) / 60n;
  if (minutes > BigInt(args.maxMinutes)) minutes = BigInt(args.maxMinutes);
  const creatorAmount = args.ratePerMin * minutes;
  const fee = (creatorAmount * BigInt(args.feeBps)) / FEE_BPS_DENOM;
  return { minutes, creatorAmount, fee, refund: args.deposit - creatorAmount - fee };
}

/**
 * Sign `ixs` with the server's settle authority (fee payer) and send, waiting for
 * `confirmed`. Callers must run `assertDevnetRpc` first.
 */
export async function sendAuthorityTx(args: {
  connection: Connection;
  signer: Keypair;
  instructions: TransactionInstruction[];
}): Promise<string> {
  const { connection } = args;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: args.signer.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...args.instructions);
  tx.sign(args.signer);
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

export { base58Decode, PublicKey };
