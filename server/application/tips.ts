/**
 * Tips service (cash + on-chain).
 *
 * Endpoints:
 *
 *   POST /v1/tips             — cash tip: writes a 'tip' ledger row
 *                                that credits the recipient's cash.
 *                                kind='cash', amount_cents.
 *   POST /v1/tips/onchain     — on-chain tip: returns a memo +
 *                                recipient + amount, marks the row
 *                                pending; the Helius webhook credits
 *                                the recipient's cash on confirmed
 *                                credit (same path as M3 cash topup).
 *   GET  /v1/tips?toUserId=&limit=50 — list recent tips to a user.
 *
 * The on-chain path reuses the M3 webhook machinery:
 * server/application/helius-webhook.ts handles the credit.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

const TIP_TEXT_MAX = 200;
const TIP_LIST_DEFAULT = 50;

export interface TipRow {
  readonly tipId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly kind: 'cash' | 'onchain';
  readonly amountCents: number | null;
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
    amountLamports: r.amount_lamports,
    mint: r.mint,
    signature: r.signature,
    message: r.message,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}

/** Send a cash tip. */
export async function sendCashTip(
  ctx: AppContext,
  fromUserId: string,
  toUserId: string,
  amountCents: number,
  message: string | null,
): Promise<TipRow> {
  if (fromUserId === toUserId) {
    throw new ValidationFailedError({ reason: 'cannot tip self' });
  }
  if (amountCents <= 0 || amountCents > 1_000_000) {
    throw new ValidationFailedError({ reason: 'amountCents 1..1_000_000' });
  }
  if (message !== null && message.length > TIP_TEXT_MAX) {
    throw new ValidationFailedError({ reason: `message length 0..${TIP_TEXT_MAX}` });
  }
  const tipId = uuidv7();
  await runInTransaction(async (client) => {
    // Lock sender's balance.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [fromUserId],
    );
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [fromUserId],
    );
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(amountCents)) {
      throw new ValidationFailedError({
        reason: 'insufficient cash',
        have: cash.toString(),
        need: amountCents.toString(),
      });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [amountCents, fromUserId],
    );
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [toUserId],
    );
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
      [amountCents, toUserId],
    );
    // Two ledger rows: a 'tip' row for the recipient and a
    // matching cash debit on the sender. The sender-side row uses
    // reason='tip_out' so the ledger is balanced (out from sender,
    // in to recipient).
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'tip_out', 'tip', $3, $4)`,
      [fromUserId, -amountCents, tipId, `tip-out:${tipId}`],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'tip', 'tip', $3, $4)`,
      [toUserId, amountCents, tipId, `tip-in:${tipId}`],
    );
    await client.query(
      `INSERT INTO tips
         (tip_id, from_user_id, to_user_id, kind, amount_cents, message, status)
       VALUES ($1, $2, $3, 'cash', $4, $5, 'confirmed')`,
      [tipId, fromUserId, toUserId, amountCents, message],
    );
  });
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<TipDbRow>(
      `SELECT tip_id, from_user_id, to_user_id, kind, amount_cents, amount_lamports,
              mint, signature, message, status, created_at
       FROM tips WHERE tip_id = $1`,
      [tipId],
    );
  });
  return rowToTip(r.rows[0] as TipDbRow);
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
      `SELECT tip_id, from_user_id, to_user_id, kind, amount_cents, amount_lamports,
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
      `SELECT tip_id, from_user_id, to_user_id, kind, amount_cents, amount_lamports,
              mint, signature, message, status, created_at
       FROM tips WHERE to_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [toUserId, lim],
    );
  });
  return r.rows.map(rowToTip);
}

void TIP_LIST_DEFAULT;
