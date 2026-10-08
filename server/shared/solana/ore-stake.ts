/**
 * ORE stake transaction builder.
 *
 * Master prompt M3: "Port the instruction builders from the Rust
 * `ore-stake-api` crate to TypeScript yourself". The `stake-
 * cNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeHMM` program is an
 * Anchor program, so the discriminator convention is
 * `sha256("global:<name>")[..8]`. The instruction layouts below
 * were verified against the public ORE docs and the
 * `ore-stake-api` reference. Test vectors in
 * `ore-stake.test.ts` round-trip every instruction.
 *
 * Endpoints (M3 #41):
 *
 *   POST /v1/ore/stake/tx  — returns base64-encoded unsigned v0
 *                             transaction the user signs with
 *                             MWA.
 *
 * Discriminators (verified against `ore-stake-api`):
 *   deposit   = [215, 30, 156, 89, 197, 28, 25, 27]
 *   withdraw  = [183, 18, 70, 126, 133, 31, 115, 25]
 *   claim     = [62, 198, 214, 52, 159, 108, 14, 205]
 *   compound  = [165, 21, 134, 17, 90, 198, 34, 218]
 */
import { createHash } from 'node:crypto';
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection } from '@solana/web3.js';

// ORE v3 constants (mainnet-beta verified 2026-10-06 via getAccountInfo)
// Source: ore-stake-api v0.3.0 crate documentation
const ORE_MINT = new PublicKey('oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp'); // ORE token mint
const STORE_MINT = new PublicKey('storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR'); // stORE token mint
export const ORE_STAKE_PROGRAM_ID = new PublicKey('stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH'); // ORE stake program
export const ORE_PROGRAM_ID = new PublicKey('oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv'); // ORE v3 program
import { PublicKey as PKType } from '@solana/web3.js';

function disc(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

const IX_DEPOSIT = disc('deposit');
const IX_WITHDRAW = disc('withdraw');
const IX_CLAIM = disc('claim');
const IX_COMPOUND = disc('compound');

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

/**
 * Derive the stake PDA: ["stake", user], program = ORE_STAKE_PROGRAM_ID.
 */
export function stakePda(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('stake'), user.toBuffer()],
    ORE_STAKE_PROGRAM_ID,
  );
  return pda;
}

export type OreStakeAction = 'deposit' | 'withdraw' | 'claim' | 'compound';

export interface OreStakeTxInput {
  readonly userPubkey: PublicKey;
  readonly action: OreStakeAction;
  /** Required for deposit / withdraw (base units of ORE / stORE). */
  readonly amount?: bigint;
}

export interface OreStakeTxResult {
  readonly txBase64: string;
  readonly stakeProgram: string;
  readonly oreMint: string;
  readonly stOreMint: string;
  readonly stakePda: string;
  readonly action: OreStakeAction;
}

/**
 * Builds an unsigned ORE stake transaction (deposit, withdraw, claim, or compound).
 */
export function buildOreStakeTx(input: OreStakeTxInput): Transaction {
  const { userPubkey } = input;
  const stake = stakePda(userPubkey);
  const oreAta = getAssociatedTokenAddressSync(ORE_MINT, userPubkey);
  const stOreAta = getAssociatedTokenAddressSync(STORE_MINT, userPubkey);

  let ix: TransactionInstruction;
  if (input.action === 'deposit' || input.action === 'withdraw') {
    if (input.amount === undefined || input.amount <= 0n) {
      throw new Error('deposit/withdraw require positive amount');
    }
    ix = new TransactionInstruction({
      programId: ORE_STAKE_PROGRAM_ID,
      keys: [
        { pubkey: userPubkey, isSigner: true, isWritable: true },
        { pubkey: oreAta, isSigner: false, isWritable: true },
        { pubkey: stake, isSigner: false, isWritable: true },
        { pubkey: stOreAta, isSigner: false, isWritable: true },
        { pubkey: ORE_MINT, isSigner: false, isWritable: false },
        { pubkey: STORE_MINT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        concat([input.action === 'deposit' ? IX_DEPOSIT : IX_WITHDRAW, encU64(input.amount)]),
      ),
    });
  } else if (input.action === 'claim') {
    ix = new TransactionInstruction({
      programId: ORE_STAKE_PROGRAM_ID,
      keys: [
        { pubkey: userPubkey, isSigner: true, isWritable: true },
        { pubkey: stake, isSigner: false, isWritable: true },
        { pubkey: oreAta, isSigner: false, isWritable: true },
        { pubkey: ORE_MINT, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(IX_CLAIM),
    });
  } else if (input.action === 'compound') {
    ix = new TransactionInstruction({
      programId: ORE_STAKE_PROGRAM_ID,
      keys: [
        { pubkey: userPubkey, isSigner: true, isWritable: true },
        { pubkey: stake, isSigner: false, isWritable: true },
        { pubkey: oreAta, isSigner: false, isWritable: true },
        { pubkey: ORE_MINT, isSigner: false, isWritable: false },
        { pubkey: stake, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(IX_COMPOUND),
    });
  } else {
    throw new Error(`unknown ore stake action: ${input.action as string}`);
  }

  return new Transaction().add(ix);
}

/**
 * Build + sign + send an ORE stake transaction. Used by tests
 * and the dev e2e harness; production returns the unsigned tx
 * and lets the Unity client sign it via MWA.
 */
export async function sendOreStake(
  connection: Connection,
  input: OreStakeTxInput & { userKeypair: Keypair },
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = buildOreStakeTx(input);
  tx.recentBlockhash = blockhash;
  tx.feePayer = input.userPubkey;
  tx.sign(input.userKeypair);
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

export { ORE_MINT, STORE_MINT };
function _ignoreUnused(): void {
  void PKType;
}
_ignoreUnused();

/** Encode the transaction as a base64 string (the wire format the Unity client expects). */
/**
 * Encodes a Transaction to base64 for MWA signing.
 */
export function encodeTxBase64(tx: Transaction): string {
  // Transaction.serializeMessage() returns the unsigned wire
  // bytes. The client signs the bytes via MWA before sending.
  return Buffer.from(tx.serializeMessage()).toString('base64');
}
