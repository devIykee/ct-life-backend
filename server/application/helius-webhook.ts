/**
 * Helius webhook handler.
 *
 * The Helius Enhanced Webhooks payload is JSON; the signature
 * is `base64(HMAC_SHA256(HELIUS_WEBHOOK_SECRET, raw_body))` in
 * the `x-helius-signature` header. We verify the signature,
 * record the event idempotently on (source, signature), look up
 * the intent by `memo`, then hand the signature to the top-up
 * reconciler, which verifies the finalized transaction itself and
 * credits once (the payload is never trusted for amounts).
 */
import { createHmac } from 'node:crypto';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import type { HeliusClient } from '../shared/solana/helius.js';
import type { AppContext } from './context.js';
import { reconcilePaymentIntent } from './topup.js';

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
  const intent = await ctx.db.withConnection((c) =>
    c.query<{ intent_id: string }>(`SELECT intent_id FROM payment_intents WHERE memo = $1`, [memo]),
  );
  const intentId = intent.rows[0]?.intent_id;
  if (!intentId) return { ok: true, status: 'ignored' };
  // The payload only names the transaction; crediting re-reads and verifies
  // it from finalized chain data (same path as the poller).
  const credited = (await reconcilePaymentIntent(ctx, intentId, payload.signature)) === 'confirmed';
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
