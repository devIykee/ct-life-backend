/** Verify the exact dedicated USDC transfer from finalized parsed chain data. */
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { z } from 'zod';

export interface LikenessPaymentProof {
  payer: string;
  recipient: string;
  mint: string;
  reference: string;
  memo: string;
  amount_base_units: string;
  created_at: Date;
  expires_at: Date;
}
const ParsedTransaction = z.object({
  blockTime: z.number().int(),
  meta: z.object({
    err: z.unknown(),
    preTokenBalances: z
      .array(
        z.object({
          accountIndex: z.number().int(),
          mint: z.string(),
          owner: z.string().optional(),
          uiTokenAmount: z.object({ amount: z.string(), decimals: z.number() }),
        }),
      )
      .default([]),
    postTokenBalances: z
      .array(
        z.object({
          accountIndex: z.number().int(),
          mint: z.string(),
          owner: z.string().optional(),
          uiTokenAmount: z.object({ amount: z.string(), decimals: z.number() }),
        }),
      )
      .default([]),
  }),
  transaction: z.object({
    message: z.object({
      accountKeys: z.array(z.object({ pubkey: z.string(), signer: z.boolean() })),
      instructions: z.array(z.object({ programId: z.string(), parsed: z.unknown().optional() })),
    }),
  }),
});
const MemoProgram = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** Caller MUST request finalized commitment from its configured cluster RPC. */
export function verifyLikenessPayment(raw: unknown, expected: LikenessPaymentProof): string | null {
  const parsed = ParsedTransaction.safeParse(raw);
  if (!parsed.success) return 'invalid_finalized_transaction';
  const tx = parsed.data;
  if (tx.meta.err !== null) return 'transaction_failed';
  if (
    tx.blockTime * 1000 < expected.created_at.getTime() - 30_000 ||
    tx.blockTime * 1000 > expected.expires_at.getTime()
  )
    return 'payment_outside_quote_window';
  return verifyUsdcTransfer(raw, expected);
}

export type UsdcTransferProof = Omit<LikenessPaymentProof, 'created_at' | 'expires_at'>;

/**
 * Verify one exact USDC transferChecked from payer to recipient carrying the
 * reference and memo, with a matching recipient balance increase. No time
 * window: callers that quote a deadline check it themselves. Caller MUST
 * request finalized commitment.
 */
export function verifyUsdcTransfer(raw: unknown, expected: UsdcTransferProof): string | null {
  const parsed = ParsedTransaction.safeParse(raw);
  if (!parsed.success) return 'invalid_finalized_transaction';
  const tx = parsed.data;
  if (tx.meta.err !== null) return 'transaction_failed';
  const accounts = tx.transaction.message.accountKeys;
  if (accounts[0]?.pubkey !== expected.payer || accounts[0]?.signer !== true)
    return 'payer_mismatch';
  if (!accounts.some((a) => a.pubkey === expected.reference && !a.signer))
    return 'payment_reference_missing';
  const instructions = tx.transaction.message.instructions;
  if (
    instructions.filter((i) => i.programId === MemoProgram && i.parsed === expected.memo).length !==
    1
  )
    return 'payment_memo_mismatch';
  const payerAta = getAssociatedTokenAddressSync(
    new PublicKey(expected.mint),
    new PublicKey(expected.payer),
  ).toBase58();
  const recipientAta = getAssociatedTokenAddressSync(
    new PublicKey(expected.mint),
    new PublicKey(expected.recipient),
  ).toBase58();
  const Transfer = z.object({
    type: z.literal('transferChecked'),
    info: z.object({
      source: z.string(),
      destination: z.string(),
      authority: z.string(),
      mint: z.string(),
      tokenAmount: z.object({ amount: z.string(), decimals: z.literal(6) }),
    }),
  });
  const matches = instructions
    .filter((i) => i.programId === TOKEN_PROGRAM_ID.toBase58())
    .flatMap((i) => {
      const t = Transfer.safeParse(i.parsed);
      return t.success ? [t.data.info] : [];
    })
    .filter(
      (t) =>
        t.source === payerAta &&
        t.destination === recipientAta &&
        t.authority === expected.payer &&
        t.mint === expected.mint &&
        t.tokenAmount.amount === expected.amount_base_units,
    );
  if (matches.length !== 1) return 'usdc_transfer_mismatch';
  const destinationIndex = accounts.findIndex((a) => a.pubkey === recipientAta);
  const before = tx.meta.preTokenBalances.find((b) => b.accountIndex === destinationIndex);
  const after = tx.meta.postTokenBalances.find((b) => b.accountIndex === destinationIndex);
  if (
    !after ||
    after.owner !== expected.recipient ||
    after.mint !== expected.mint ||
    after.uiTokenAmount.decimals !== 6 ||
    (before &&
      (before.owner !== expected.recipient ||
        before.mint !== expected.mint ||
        before.uiTokenAmount.decimals !== 6))
  )
    return 'recipient_balance_mismatch';
  if (
    !/^\d+$/.test(after.uiTokenAmount.amount) ||
    (before && !/^\d+$/.test(before.uiTokenAmount.amount))
  )
    return 'invalid_token_amount';
  if (
    BigInt(after.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? '0') !==
    BigInt(expected.amount_base_units)
  )
    return 'received_amount_mismatch';
  return null;
}
