/**
 * Helius webhook handler.
 *
 * The Helius Enhanced Webhooks payload is JSON; the signature
 * is `base64(HMAC_SHA256(HELIUS_WEBHOOK_SECRET, raw_body))` in
 * the `x-helius-signature` header. We verify the signature,
 * record the event idempotently on (source, signature), then
 * look up the intent by `memo` and credit the ledger.
 *
 * The handler is the only writer of the user's cash balance
 * via the topup ledger path. Conservation is preserved because
 * the ledger is append-only and the UoW is SERIALIZABLE.
 */
import { createHmac } from 'node:crypto';
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  PaymentExpiredError,
  PaymentUnderpaidError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import type { HeliusClient } from '../shared/solana/helius.js';
import type { AppContext } from './context.js';
import type { Currency } from './topup.js';

export interface HeliusWebhookPayload {
  readonly signature: string;
  readonly accountData?: ReadonlyArray<{
    readonly account: string;
    readonly nativeBalanceChange?: number;
    readonly tokenBalanceChanges?: ReadonlyArray<{
      readonly mint: string;
      readonly rawTokenAmount?: { readonly tokenAmount: string; readonly decimals: number };
      readonly userAccount?: string;
    }>;
  }>;
  readonly memo?: string;
}

export interface WebhookResult {
  readonly ok: true;
  readonly status: 'credited' | 'replay' | 'ignored';
}

/**
 * Verify the Helius signature header against the raw body.
 * @param ctx - The application context (carries the secret).
 * @param signatureHeader - The `x-helius-signature` value.
 * @param rawBody - The raw request body string.
 */
export function verifyHeliusSignature(
  ctx: AppContext,
  signatureHeader: string | undefined,
  rawBody: string,
): void {
  if (signatureHeader === undefined || signatureHeader === '') {
    throw new ValidationFailedError({ reason: 'missing signature header' });
  }
  const secret = ctx.config.helius.webhookSecret;
  if (secret === '') {
    throw new ValidationFailedError({ reason: 'webhook secret not configured' });
  }
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  if (expected !== signatureHeader) {
    throw new ValidationFailedError({ reason: 'invalid webhook signature' });
  }
}

/**
 * Handle a Helius webhook delivery. Idempotent on
 * (source='helius', signature).
 *
 * @param ctx - The application context.
 * @param signatureHeader - The signature header.
 * @param rawBody - The raw request body.
 * @param payload - The parsed JSON.
 */
export async function handleHeliusWebhook(
  ctx: AppContext,
  signatureHeader: string | undefined,
  rawBody: string,
  payload: HeliusWebhookPayload,
): Promise<WebhookResult> {
  verifyHeliusSignature(ctx, signatureHeader, rawBody);
  // Idempotency: insert into webhook_events; SQLSTATE 23505
  // means we've already seen this signature.
  const eventId = uuidv7();
  const inserted = await ctx.db.withConnection(async (c) => {
    try {
      await c.query(
        `INSERT INTO webhook_events (event_id, source, payload, processed_at, signature)
         VALUES ($1, 'helius', $2::jsonb, now(), $3)`,
        [eventId, JSON.stringify(payload), payload.signature],
      );
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return false;
      throw e;
    }
  });
  if (!inserted) return { ok: true, status: 'replay' };
  const memo = payload.memo ?? (await fetchMemoFromTx(ctx.helius, payload.signature));
  if (memo === null) return { ok: true, status: 'ignored' };
  const credited = await creditIntentByMemo(ctx, memo, payload);
  return { ok: true, status: credited ? 'credited' : 'ignored' };
}

async function fetchMemoFromTx(helius: HeliusClient, signature: string): Promise<string | null> {
  try {
    const tx = await helius.rpc<{
      transaction?: {
        message?: {
          instructions?: Array<{ parsed?: { type?: string; info?: { memo?: string } } }>;
        };
      };
    }>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
    for (const ix of tx.transaction?.message?.instructions ?? []) {
      const m = ix.parsed?.info?.memo;
      if (typeof m === 'string') return m;
    }
    return null;
  } catch {
    return null;
  }
}

async function creditIntentByMemo(
  ctx: AppContext,
  memo: string,
  payload: HeliusWebhookPayload,
): Promise<boolean> {
  return runInTransaction(async (client) => {
    const r = await client.query<{
      intent_id: string;
      user_id: string;
      cash_cents: string;
      bonus_bps: number;
      amount: string;
      currency: Currency;
      status: string;
      expires_at: Date;
      kind: string;
    }>(
      `SELECT intent_id, user_id, cash_cents, bonus_bps, amount, currency, status, expires_at, kind
       FROM payment_intents WHERE memo = $1 FOR UPDATE`,
      [memo],
    );
    if ((r.rowCount ?? 0) === 0) return false;
    const intent = r.rows[0]!;
    if (intent.status === 'confirmed') return false;

    // B32: Only credit topup intents (not custom/other)
    if (intent.kind !== 'topup') {
      return false;
    }

    if (new Date(intent.expires_at).getTime() < Date.now()) {
      await client.query(`UPDATE payment_intents SET status = 'expired' WHERE intent_id = $1`, [
        intent.intent_id,
      ]);
      throw new PaymentExpiredError({ intentId: intent.intent_id });
    }

    // B32: Verify mint, recipient, and base-unit amount
    const validation = validatePaymentTransfer(ctx, intent.currency, intent.amount, payload);
    if (!validation.valid) {
      await client.query(`UPDATE payment_intents SET status = 'failed' WHERE intent_id = $1`, [
        intent.intent_id,
      ]);
      throw new ValidationFailedError({
        reason: 'payment_validation_failed',
        intentId: intent.intent_id,
        error: validation.error,
      });
    }

    const receivedCents = computeReceivedCents(intent.currency, payload);
    if (receivedCents < BigInt(intent.cash_cents)) {
      await client.query(`UPDATE payment_intents SET status = 'failed' WHERE intent_id = $1`, [
        intent.intent_id,
      ]);
      throw new PaymentUnderpaidError({
        intentId: intent.intent_id,
        expectedCents: intent.cash_cents,
        receivedCents: receivedCents.toString(),
      });
    }
    const bonus = (BigInt(intent.cash_cents) * BigInt(intent.bonus_bps)) / 10_000n;
    const total = BigInt(intent.cash_cents) + bonus;
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
      [intent.user_id, total.toString()],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'topup', 'payment_intent', $3, $4)`,
      [intent.user_id, total.toString(), intent.intent_id, `topup:${intent.intent_id}`],
    );
    await client.query(
      `UPDATE payment_intents SET status = 'confirmed', signature = $1 WHERE intent_id = $2`,
      [payload.signature, intent.intent_id],
    );
    return true;
  });
}

/**
 * B32: Validate payment transfer matches expected recipient and amount.
 */
function validatePaymentTransfer(
  ctx: AppContext,
  currency: Currency,
  expectedAmount: string,
  payload: HeliusWebhookPayload,
): { valid: boolean; error?: string } {
  const expectedRecipient = ctx.config.solana.treasuryPubkey;

  for (const acct of payload.accountData ?? []) {
    for (const chg of acct.tokenBalanceChanges ?? []) {
      // B32: Verify recipient account
      if (chg.userAccount !== expectedRecipient) {
        return {
          valid: false,
          error: `recipient_mismatch: expected ${expectedRecipient}, got ${chg.userAccount}`,
        };
      }

      // B32: Verify base-unit amount
      const receivedAmount = chg.rawTokenAmount?.tokenAmount;
      if (receivedAmount !== expectedAmount) {
        return {
          valid: false,
          error: `amount_mismatch: expected ${expectedAmount}, got ${receivedAmount}`,
        };
      }

      return { valid: true };
    }

    // SOL native balance (no mint check needed)
    if (currency === 'SOL' && acct.nativeBalanceChange !== undefined) {
      if (acct.account !== expectedRecipient) {
        return {
          valid: false,
          error: `recipient_mismatch: expected ${expectedRecipient}, got ${acct.account}`,
        };
      }
      return { valid: true };
    }
  }

  return { valid: false, error: 'no_matching_transfer_found' };
}

/**
 * Compute the received amount in USDC-cents from the Helius
 * balance-change deltas. Dev approximation: 1:1 for SOL/SKR/ORE
 * against the requested amount.
 */
function computeReceivedCents(currency: Currency, payload: HeliusWebhookPayload): bigint {
  for (const acct of payload.accountData ?? []) {
    for (const chg of acct.tokenBalanceChanges ?? []) {
      const raw = chg.rawTokenAmount?.tokenAmount;
      if (raw === undefined) continue;
      const units = BigInt(raw);
      const decimals = chg.rawTokenAmount?.decimals ?? 6;
      if (currency === 'USDC') return (units * 100n) / 10n ** BigInt(decimals);
      if (currency === 'SKR' || currency === 'ORE') return units;
    }
    if (currency === 'SOL' && acct.nativeBalanceChange !== undefined) {
      // 1 SOL ≈ 100 cents (dev approximation).
      return BigInt(acct.nativeBalanceChange) / 10_000_000n;
    }
  }
  return 0n;
}
