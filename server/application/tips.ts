/**
 * Tips.
 *
 * Cash is purchasable but NON-transferable: it never moves between players.
 *
 *   POST /v1/tips             — GONE (410 CASH_NOT_TRANSFERABLE). Cash tips were removed.
 *   POST /v1/tips/onchain     — records a note that the caller sent an on-chain transfer
 *                                (USDC/SOL) from their wallet to another player's wallet.
 *                                The value moves wallet to wallet, outside the game. This
 *                                row is informational and stays 'pending': nothing here, and
 *                                no webhook, verifies it or credits ANY Cash to anyone.
 *   GET  /v1/tips?toUserId=&limit=50 — list recent tips to a user (old Cash tips and notes).
 */
import { runInTransaction } from '../shared/db/uow.js';
import { CashNotTransferableError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

const TIP_TEXT_MAX = 200;
const TIP_LIST_DEFAULT = 50;

export interface TipRow {
  readonly tipId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly kind: 'cash' | 'onchain';
  /** Old Cash tips only (removed): what the sender paid. */
  readonly amountCents: number | null;
  /** Old Cash tips only: the part that was burned. */
  readonly feeCents: number | null;
  /** Old Cash tips only: what the recipient got. */
  readonly receivedCents: number | null;
  readonly amountLamports: string | null;
  readonly mint: string | null;
  readonly signature: string | null;
  readonly message: string | null;
  readonly status: 'pending' | 'confirmed' | 'failed';
  readonly createdAt: string;
}

interface TipDbRow {
  tip_id: string;
  from_user_id: string;
  to_user_id: string;
  kind: 'cash' | 'onchain';
  amount_cents: string | null;
  fee_cents: string;
  amount_lamports: string | null;
  mint: string | null;
  signature: string | null;
  message: string | null;
  status: 'pending' | 'confirmed' | 'failed';
  created_at: Date;
}

function rowToTip(r: TipDbRow): TipRow {
  return {
    tipId: r.tip_id,
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    kind: r.kind,
    amountCents: r.amount_cents !== null ? Number(r.amount_cents) : null,
    feeCents: r.amount_cents !== null ? Number(r.fee_cents) : null,
    receivedCents: r.amount_cents !== null ? Number(r.amount_cents) - Number(r.fee_cents) : null,
    amountLamports: r.amount_lamports,
    mint: r.mint,
    signature: r.signature,
    message: r.message,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Cash tips were removed: Cash is purchasable but never moves between players. Always
 * refuses. (The route calls this so the refusal and its code live in one place.)
 * @throws CashNotTransferableError always.
 */
export function sendCashTip(): never {
  throw new CashNotTransferableError({ reason: 'cash_tips_removed' });
}

/**
 * Record an on-chain tip. The client already sent the on-chain
 * transfer; we record the row as 'pending' until the Helius
 * webhook (server/application/helius-webhook.ts) credits the
 * recipient's cash via the existing topup path.
 */
export async function recordOnchainTip(
  ctx: AppContext,
  fromUserId: string,
  toUserId: string,
  signature: string,
  amountLamports: string,
  mint: string | null,
  message: string | null,
): Promise<TipRow> {
  if (fromUserId === toUserId) {
    throw new ValidationFailedError({ reason: 'cannot tip self' });
  }
  if (BigInt(amountLamports) <= 0n) {
    throw new ValidationFailedError({ reason: 'amountLamports must be > 0' });
  }
  if (message !== null && message.length > TIP_TEXT_MAX) {
    throw new ValidationFailedError({ reason: `message length 0..${TIP_TEXT_MAX}` });
  }
  const tipId = uuidv7();
  try {
    await runInTransaction(async (client) => {
      await client.query(
        `INSERT INTO tips
           (tip_id, from_user_id, to_user_id, kind, amount_lamports, mint, signature, message, status)
         VALUES ($1, $2, $3, 'onchain', $4, $5, $6, $7, 'pending')`,
        [tipId, fromUserId, toUserId, amountLamports, mint, signature, message],
      );
    });
  } catch (e) {
    // 23505 = duplicate signature.
    if ((e as { code?: string }).code === '23505') {
      throw new ValidationFailedError({ reason: 'signature already used' });
    }
    throw e;
  }
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<TipDbRow>(
      `SELECT tip_id, from_user_id, to_user_id, kind, amount_cents, fee_cents, amount_lamports,
              mint, signature, message, status, created_at
       FROM tips WHERE tip_id = $1`,
      [tipId],
    );
  });
  return rowToTip(r.rows[0] as TipDbRow);
}

/** List recent tips to a user. */
export async function listTipsTo(
  ctx: AppContext,
  toUserId: string,
  limit: number,
): Promise<TipRow[]> {
  const lim = Math.min(Math.max(1, limit), 200);
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<TipDbRow>(
      `SELECT tip_id, from_user_id, to_user_id, kind, amount_cents, fee_cents, amount_lamports,
              mint, signature, message, status, created_at
       FROM tips WHERE to_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [toUserId, lim],
    );
  });
  return r.rows.map(rowToTip);
}

void TIP_LIST_DEFAULT;
