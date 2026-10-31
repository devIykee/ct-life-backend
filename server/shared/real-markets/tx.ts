/**
 * Transaction helpers for Real Markets. The server only ever produces UNSIGNED
 * transactions for the player's wallet; these helpers enforce that the wallet is the fee
 * payer and the only required signer, so no provider answer can make CT Life a signer,
 * a custodian or a fee payer.
 */
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { RealMarketsProviderError } from '../domain/errors.js';
import type { RealMarketProviderId } from '../domain/real-markets.js';

export interface WireInstruction {
  readonly programId: string;
  /** Base64 instruction data. */
  readonly data: string;
  readonly accounts: ReadonlyArray<{
    readonly pubkey: string;
    readonly isSigner: boolean;
    readonly isWritable: boolean;
  }>;
}

export interface UnsignedTx {
  readonly txBase64: string;
  readonly programIds: string[];
}

function bad(provider: RealMarketProviderId, reason: string): RealMarketsProviderError {
  return new RealMarketsProviderError({ provider, reason });
}

function key(provider: RealMarketProviderId, v: string): PublicKey {
  try {
    return new PublicKey(v);
  } catch {
    throw bad(provider, 'invalid_pubkey');
  }
}

/**
 * Compile a provider's instruction list (Panta primary-buy build) into an unsigned v0
 * transaction with `wallet` as fee payer. Accounts, data and order are copied unchanged
 * (Panta verifies fail-closed against the quote).
 *
 * @param provider - Venue (for errors).
 * @param wallet - The player's linked wallet (base58).
 * @param instructions - The venue's instructions.
 * @param recentBlockhash - The venue's blockhash.
 * @returns Base64 of the unsigned transaction and the programs it invokes.
 */
export function compileUnsignedV0(
  provider: RealMarketProviderId,
  wallet: string,
  instructions: readonly WireInstruction[],
  recentBlockhash: string,
): UnsignedTx {
  if (instructions.length === 0) throw bad(provider, 'no_instructions');
  const payer = key(provider, wallet);
  const ixs = instructions.map((ix) => {
    for (const a of ix.accounts) {
      // Non-custodial: the wallet is the only signer we will ever hand to MWA.
      if (a.isSigner && a.pubkey !== wallet) throw bad(provider, 'unexpected_signer');
    }
    return new TransactionInstruction({
      programId: key(provider, ix.programId),
      data: Buffer.from(ix.data, 'base64'),
      keys: ix.accounts.map((a) => ({
        pubkey: key(provider, a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
    });
  });
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return {
    txBase64: Buffer.from(tx.serialize()).toString('base64'),
    programIds: [...new Set(instructions.map((i) => i.programId))],
  };
}

/**
 * Check a ready-made unsigned transaction (Jupiter `POST /orders`): it must parse, have
 * `wallet` as fee payer and only required signer, and carry no signature yet.
 *
 * @param provider - Venue (for errors).
 * @param wallet - The player's linked wallet (base58).
 * @param txBase64 - The venue's transaction.
 * @returns The same bytes and the programs it invokes.
 */
export function inspectUnsignedTx(
  provider: RealMarketProviderId,
  wallet: string,
  txBase64: string,
): UnsignedTx {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  } catch {
    throw bad(provider, 'unparseable_transaction');
  }
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (msg.header.numRequiredSignatures !== 1 || keys[0]?.toBase58() !== wallet) {
    throw bad(provider, 'unexpected_signer');
  }
  if (tx.signatures.some((s) => s.some((b) => b !== 0))) {
    throw bad(provider, 'already_signed');
  }
  const programIds = new Set<string>();
  for (const ix of msg.compiledInstructions) {
    const p = keys[ix.programIdIndex];
    if (p) programIds.add(p.toBase58());
  }
  return { txBase64, programIds: [...programIds] };
}
