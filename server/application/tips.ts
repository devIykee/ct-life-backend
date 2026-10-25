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
import { recordEvent } from './analytics.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  recordQuestEvent,
  TIP_PINGPONG_DAYS,
  TIP_QUEST_MIN_CENTS,
  TIP_RECIPIENT_COOLDOWN_DAYS,
} from './quests.js';
import type { AppContext } from './context.js';

const TIP_TEXT_MAX = 200;
const TIP_MAX_CENTS = 1_000_000;

/**
 * The burned fee on a Cash tip: ceil(amount * feeBps / 10000), at least 1 cent
 * while the rate is above 0. The sender pays the whole amount, the recipient
 * gets amount - fee, nobody is credited the fee.
 * @param amountCents - The tip, in cents.
 * @param feeBps - Basis points (300 = 3%).
 */
export function tipFeeCents(amountCents: number, feeBps: number): number {
  if (feeBps <= 0) return 0;
  return Math.max(1, Math.ceil((amountCents * feeBps) / 10_000));
}
const TIP_LIST_DEFAULT = 50;

export interface TipRow {
  readonly tipId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly kind: 'cash' | 'onchain';
  /** What the sender paid. */
  readonly amountCents: number | null;
  /** The part burned (cash tips); 0 for tips sent before the fee. */
  readonly feeCents: number | null;
  /** What the recipient got: amountCents - feeCents (cash tips). */
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

/** Whether `fromUserId` sent `toUserId` a confirmed Cash tip within the ping-pong window. */
async function tippedRecently(
  ctx: AppContext,
  fromUserId: string,
  toUserId: string,
): Promise<boolean> {
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `SELECT 1 FROM tips
        WHERE from_user_id = $1 AND to_user_id = $2 AND kind = 'cash' AND status = 'confirmed'
          AND created_at > now() - make_interval(days => $3::int) LIMIT 1`,
      [fromUserId, toUserId, TIP_PINGPONG_DAYS],
    ),
  );
  return r.rows.length > 0;
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
  const feeBps = ctx.config.tips.feeBps;
  const feeCents = tipFeeCents(amountCents, feeBps);
  if (amountCents <= 0 || amountCents > TIP_MAX_CENTS) {
    throw new ValidationFailedError({ reason: `amountCents 1..${TIP_MAX_CENTS}` });
  }
  if (amountCents - feeCents < 1) {
    // The fee would take the whole tip (1 cent at 3%): nothing would reach the recipient.
    throw new ValidationFailedError({
      reason: 'tip too small: the fee would take all of it',
      feeCents,
    });
  }
  const receivedCents = amountCents - feeCents;
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
      [receivedCents, toUserId],
    );
    // Ledger: the sender is debited the full amount as two rows that add up to it
    // (tip_out = what the recipient gets, tip_fee_burn = the burned fee); the
    // recipient gets a 'tip' row for amount - fee. Nobody is credited the fee.
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'tip_out', 'tip', $3, $4)`,
      [fromUserId, -receivedCents, tipId, `tip-out:${tipId}`],
    );
    if (feeCents > 0) {
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'tip_fee_burn', 'tip', $3, $4)`,
        [fromUserId, -feeCents, tipId, `tip-fee:${tipId}`],
      );
    }
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'tip', 'tip', $3, $4)`,
      [toUserId, receivedCents, tipId, `tip-in:${tipId}`],
    );
    await client.query(
      `INSERT INTO tips
         (tip_id, from_user_id, to_user_id, kind, amount_cents, fee_cents, message, status)
       VALUES ($1, $2, $3, 'cash', $4, $5, $6, 'confirmed')`,
      [tipId, fromUserId, toUserId, amountCents, feeCents, message],
    );
    // The recipient is not recorded: the sender's id is the only identifier.
    await recordEvent(client, fromUserId, {
      name: 'tip_sent',
      props: { feeCents },
      amountCents,
    });
  });
  // Quest rules against two accounts looping tips: the amount must be at least the minimum,
  // each recipient counts once per window, and a tip to someone who tipped the sender
  // recently (ping-pong) never counts.
  if (amountCents >= TIP_QUEST_MIN_CENTS && !(await tippedRecently(ctx, toUserId, fromUserId))) {
    await recordQuestEvent(ctx, fromUserId, 'tip_send', tipId, new Date(), {
      key: `tip:${toUserId}`,
      cooldownDays: TIP_RECIPIENT_COOLDOWN_DAYS,
    });
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
