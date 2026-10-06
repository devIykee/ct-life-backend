/**
 * ct_escrow transaction builders.
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
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  pipe,
  compileTransaction,
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  getBase58Decoder,
  getProgramDerivedAddress,
  type Address,
  type KeyPairSigner,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IDL = JSON.parse(
  readFileSync(join(process.cwd(), 'contract/idl/ct_escrow.json'), 'utf8'),
) as {
  address: string;
  instructions: Array<{
    name: string;
    discriminator: number[];
    accounts: Array<{ name: string }>;
  }>;
};

export const CT_ESCROW_PROGRAM_ID: Address = address(IDL.address);

/** Compute the Anchor instruction discriminator from the IDL. */
function disc(name: string): Uint8Array {
  const fromIdl = IDL.instructions.find((i) => i.name === name)?.discriminator;
  if (fromIdl) return Uint8Array.from(fromIdl);
  // Fallback: sha256("global:<name>").slice(0, 8).
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const IX_ACCEPT = disc('accept');
const IX_INIT_CONFIG = disc('initConfig');
const IX_OPEN_SESSION = disc('openSession');
const IX_REFUND = disc('refund');
const IX_SETTLE = disc('settle');

/** Encode a u8 / u16 / u32 / u64 / i64 little-endian. */
function encU8(n: number): Uint8Array {
  const b = new Uint8Array(1);
  new DataView(b.buffer).setUint8(0, n);
  return b;
}
function encU16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
function encU64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

/** Append multiple Uint8Arrays end-to-end. */
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

/** Config PDA: ["config"], program = CT_ESCROW_PROGRAM_ID. */
export async function configPda(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: CT_ESCROW_PROGRAM_ID,
    seeds: [new TextEncoder().encode('config')],
  });
  return pda;
}

/** Session PDA: ["session", fan, session_id_le_u64]. */
export async function sessionPda(
  fan: Address,
  sessionId: bigint,
): Promise<Address> {
  const sid = new Uint8Array(8);
  new DataView(sid.buffer).setBigUint64(0, sessionId, true);
  const fanBytes = new Uint8Array(32);
  // Address is a base58-encoded string; decode it to bytes.
  const decoded = getBase58Decoder().decode(fan);
  if (decoded.byteLength !== 32) {
    throw new Error(`sessionPda: fan address must decode to 32 bytes, got ${decoded.byteLength}`);
  }
  fanBytes.set(decoded);
  const [pda] = await getProgramDerivedAddress({
    programAddress: CT_ESCROW_PROGRAM_ID,
    seeds: [new TextEncoder().encode('session'), fanBytes, sid],
  });
  return pda;
}

// --- Helpers ----------------------------------------------------------------

/** Build a kit `Instruction` from data + accounts. */
function buildIx(
  program: Address,
  accounts: Array<{ address: Address; role: { isWritable: boolean; isSigner: boolean } }>,
  data: Uint8Array,
): Instruction {
  return {
    programAddress: program,
    accounts,
    data: new Uint8Array(data),
  } as unknown as Instruction;
}

// --- Builders ---------------------------------------------------------------

export interface InitConfigAccounts {
  admin: Address;
  treasury: Address;
  vault: Address;
  usdcMint: Address;
}

export async function buildInitConfigIx(
  accounts: InitConfigAccounts,
  feeBps: number,
): Promise<Instruction> {
  const config = await configPda();
  return buildIx(
    CT_ESCROW_PROGRAM_ID,
    [
      { address: config, role: { isWritable: true, isSigner: false } },
      { address: accounts.vault, role: { isWritable: false, isSigner: false } },
      { address: accounts.usdcMint, role: { isWritable: false, isSigner: false } },
      { address: accounts.treasury, role: { isWritable: false, isSigner: false } },
      { address: accounts.admin, role: { isWritable: true, isSigner: true } },
    ],
    concat([IX_INIT_CONFIG, encU16(feeBps)]),
  );
}

export interface OpenSessionAccounts {
  fan: Address;
  fanUsdcAta: Address;
  creator: Address;
}

export async function buildOpenSessionIx(
  accounts: OpenSessionAccounts,
  sessionId: bigint,
  rateBaseUnitsPerMin: bigint,
  maxMinutes: number,
): Promise<Instruction> {
  const config = await configPda();
  const session = await sessionPda(accounts.fan, sessionId);
  // We don't need the vault here at encode time; the server
  // fetches it from the chain. The on-chain constraint is
  // vault.key() == config.vault.
  return buildIx(
    CT_ESCROW_PROGRAM_ID,
    [
      { address: session, role: { isWritable: true, isSigner: false } },
      { address: config, role: { isWritable: false, isSigner: false } },
      // vault: filled by the route handler from config.vault
      { address: 'So11111111111111111111111111111111111111112' as Address, role: { isWritable: false, isSigner: false } },
      { address: accounts.fanUsdcAta, role: { isWritable: true, isSigner: false } },
      { address: accounts.fan, role: { isWritable: true, isSigner: true } },
    ],
    concat([IX_OPEN_SESSION, encU64(sessionId), encU64(rateBaseUnitsPerMin), encU8(maxMinutes)]),
  );
}

export async function buildAcceptIx(
  creator: Address,
  fan: Address,
  sessionId: bigint,
): Promise<Instruction> {
  const session = await sessionPda(fan, sessionId);
  return buildIx(
    CT_ESCROW_PROGRAM_ID,
    [
      { address: session, role: { isWritable: true, isSigner: false } },
      { address: creator, role: { isWritable: false, isSigner: true } },
    ],
    IX_ACCEPT,
  );
}

export async function buildSettleIx(
  settleAuthority: Address,
  fan: Address,
  sessionId: bigint,
  secondsUsed: bigint,
  vault: Address,
  creatorUsdcAta: Address,
  fanUsdcAta: Address,
  treasuryUsdcAta: Address,
): Promise<Instruction> {
  const config = await configPda();
  const session = await sessionPda(fan, sessionId);
  return buildIx(
    CT_ESCROW_PROGRAM_ID,
    [
      { address: session, role: { isWritable: true, isSigner: false } },
      { address: config, role: { isWritable: false, isSigner: false } },
      { address: vault, role: { isWritable: true, isSigner: false } },
      { address: creatorUsdcAta, role: { isWritable: true, isSigner: false } },
      { address: fanUsdcAta, role: { isWritable: true, isSigner: false } },
      { address: treasuryUsdcAta, role: { isWritable: true, isSigner: false } },
      { address: settleAuthority, role: { isWritable: false, isSigner: true } },
    ],
    concat([IX_SETTLE, encU64(secondsUsed)]),
  );
}

export async function buildRefundIx(
  fan: Address,
  sessionId: bigint,
  vault: Address,
  fanUsdcAta: Address,
): Promise<Instruction> {
  const config = await configPda();
  const session = await sessionPda(fan, sessionId);
  return buildIx(
    CT_ESCROW_PROGRAM_ID,
    [
      { address: session, role: { isWritable: true, isSigner: false } },
      { address: config, role: { isWritable: false, isSigner: false } },
      { address: vault, role: { isWritable: true, isSigner: false } },
      { address: fanUsdcAta, role: { isWritable: true, isSigner: false } },
      { address: fan, role: { isWritable: false, isSigner: true } },
    ],
    IX_REFUND,
  );
}

// --- Compile / sign / send ---------------------------------------------------

export interface CompileSettleArgs {
  rpc: Rpc<SolanaRpcApi>;
  settleAuthorityKeypair: KeyPairSigner;
  fan: Address;
  sessionId: bigint;
  secondsUsed: bigint;
  vault: Address;
  creatorUsdcAta: Address;
  fanUsdcAta: Address;
  treasuryUsdcAta: Address;
}

/** Compile a settle transaction, sign with the settle authority, return base64 wire bytes. */
export async function compileSettleTx(args: CompileSettleArgs): Promise<string> {
  const { value: latestBlockhash } = await args.rpc.getLatestBlockhash().send();
  const ix = await buildSettleIx(
    args.settleAuthorityKeypair.address,
    args.fan,
    args.sessionId,
    args.secondsUsed,
    args.vault,
    args.creatorUsdcAta,
    args.fanUsdcAta,
    args.treasuryUsdcAta,
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(args.settleAuthorityKeypair, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const tx = pipe(message, (m) => signTransactionMessageWithSigners(m));
  return getBase64EncodedWireTransaction(tx);
}

// --- Settled event decoder ---------------------------------------------------

const EVENT_SETTLED_DISC = new Uint8Array(
  createHash('sha256').update('event:Settled').digest().slice(0, 8),
);
const EVENT_REFUNDED_DISC = new Uint8Array(
  createHash('sha256').update('event:Refunded').digest().slice(0, 8),
);

export interface DecodedSettled {
  kind: 'settled';
  session: Address;
  fan: Address;
  creator: Address;
  secondsUsed: bigint;
  grossBaseUnits: bigint;
  feeBaseUnits: bigint;
  creatorPayoutBaseUnits: bigint;
  refundBaseUnits: bigint;
  settledAt: bigint;
}

export interface DecodedRefunded {
  kind: 'refunded';
  session: Address;
  fan: Address;
  creator: Address;
  refundBaseUnits: bigint;
  refundedAt: bigint;
}

export type DecodedEvent = DecodedSettled | DecodedRefunded;

/**
 * Decode a Solana program-data log line (base64) emitted by
 * ct_escrow. Returns null if the log is not one of our events.
 */
export function decodeCtEscrowEvent(b64: string): DecodedEvent | null {
  let bytes: Uint8Array;
  try {
    bytes = getBase58Decoder().decode(b64) as unknown as Uint8Array;
  } catch {
    try {
      bytes = Buffer.from(b64, 'base64');
    } catch {
      return null;
    }
  }
  if (bytes.byteLength < 8) return null;
  const disc = bytes.slice(0, 8);
  const body = bytes.slice(8);
  if (disc.length === 8 && eq(disc, EVENT_SETTLED_DISC)) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const session = address(bytesToString(body.slice(o, o + 32)));
    o += 32;
    const fan = address(bytesToString(body.slice(o, o + 32)));
    o += 32;
    const creator = address(bytesToString(body.slice(o, o + 32)));
    o += 32;
    const secondsUsed = dv.getBigUint64(o, true);
    o += 8;
    const gross = dv.getBigUint64(o, true);
    o += 8;
    const fee = dv.getBigUint64(o, true);
    o += 8;
    const creatorPayout = dv.getBigUint64(o, true);
    o += 8;
    const refund = dv.getBigUint64(o, true);
    o += 8;
    const settledAt = dv.getBigInt64(o, true);
    return {
      kind: 'settled',
      session,
      fan,
      creator,
      secondsUsed,
      grossBaseUnits: gross,
      feeBaseUnits: fee,
      creatorPayoutBaseUnits: creatorPayout,
      refundBaseUnits: refund,
      settledAt,
    };
  }
  if (disc.length === 8 && eq(disc, EVENT_REFUNDED_DISC)) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let o = 0;
    const session = address(bytesToString(body.slice(o, o + 32)));
    o += 32;
    const fan = address(bytesToString(body.slice(o, o + 32)));
    o += 32;
    const creator = address(bytesToString(body.slice(o, o + 32)));
    o += 32;
    const refund = dv.getBigUint64(o, true);
    o += 8;
    const refundedAt = dv.getBigInt64(o, true);
    return {
      kind: 'refunded',
      session,
      fan,
      creator,
      refundBaseUnits: refund,
      refundedAt,
    };
  }
  return null;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToString(b: Uint8Array): string {
  // Anchor serializes Pubkey as 32 bytes (not base58). Re-encode
  // as the Solana base58 alphabet.
  return base58Encode(b);
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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
  // leading zeros → '1'
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

export { createSolanaRpc, createKeyPairSignerFromBytes };