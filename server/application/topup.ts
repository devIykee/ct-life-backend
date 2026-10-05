/**
 * Cash top-up service.
 *
 * Implements the M3 #38 contract:
 *
 *   POST /v1/payments/intents     — create a topup intent
 *   POST /v1/payments/intents/{id}/submitted — client confirms the on-chain tx
 *   POST /v1/webhooks/helius      — Helius webhook (signed) — in helius-webhook.ts
 *
 * The flow:
 *
 *   1. Client calls POST /v1/payments/intents with kind=topup,
 *      currency, sku, and optional amountCents. The server
 *      resolves a target USDC amount from the top-up pack config
 *      and creates a `payment_intents` row with a unique
 *      `reference` (UUIDv7-derived) and `memo` (intentId).
 *   2. The server returns a `solanaPayUrl` for the client to
 *      consume. The client builds, signs and sends the transfer
 *      from their wallet to the treasury. Once sent, the client
 *      posts the signature to /submitted.
 *   3. The Helius webhook fires (or the polling reconciler
 *      picks the intent up after 30 s) and credits the ledger.
 *   4. The intent moves to status='confirmed'. If the user
 *      overpaid, the bonus bps is added to the cash credit.
 *      If they underpaid, the intent moves to 'failed'.
 *
 * Topup cap:
 *
 *   Each wallet may top up at most `topUpCapCentsPerDay` of value
 *   per day (computed from the day's confirmed topups; the
 *   `topup` reason in the ledger is the source). The cap is
 *   enforced at intent creation.
 */
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  TopupCapReachedError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

export type Currency = 'USDC' | 'SOL' | 'SKR' | 'ORE';
export type TopupSku = 'ramen' | 'bag' | 'whale' | 'cabal' | 'custom';
export type TopupKind = 'topup' | 'cosmetic' | 'ad' | 'season_pass';

interface TopupPack {
  readonly id: TopupSku;
  readonly priceUsdc: number;
  readonly cashCents: number;
  readonly bestValue?: boolean;
}

interface CurrencyBonusBps {
  readonly USDC: number;
  readonly SOL: number;
  readonly SKR: number;
  readonly ORE: number;
}

interface EconomyConfig {
  readonly topUpCapCentsPerDay: number;
  readonly topUpPacks: readonly TopupPack[];
  readonly currencyBonusBps: CurrencyBonusBps;
  readonly currencies: Record<
    Currency,
    {
      readonly decimals: number;
      readonly mint: string | null;
      readonly devnetMint: string | null;
      readonly mainnetOnly?: boolean;
    }
  >;
}

export interface CreateIntentInput {
  readonly userId: string;
  readonly kind: TopupKind;
  readonly currency: Currency;
  readonly sku: TopupSku;
  readonly amountCents?: number;
}

export interface IntentResult {
  readonly intentId: string;
  readonly recipient: string;
  readonly mint: string | null;
  readonly amount: string;
  readonly reference: string;
  readonly memo: string;
  readonly solanaPayUrl: string;
  readonly expiresAt: string;
}

const INTENT_TTL_SEC = 15 * 60;

/**
 * Create a payment intent. Returns the recipient, mint, amount,
 * and a `solanaPayUrl` ready for the client to consume.
 *
 * @param ctx - The application context.
 * @param input - The topup request.
 */
export async function createTopupIntent(
  ctx: AppContext,
  input: CreateIntentInput,
): Promise<IntentResult> {
  const cfg = ctx.configCache.load<EconomyConfig>('economy');
  const pack = input.sku === 'custom' ? null : cfg.topUpPacks.find((p) => p.id === input.sku);
  if (pack === undefined && input.sku !== 'custom') {
    throw new ValidationFailedError({ sku: input.sku });
  }
  const cashCents = input.sku === 'custom' ? (input.amountCents ?? 0) : (pack?.cashCents ?? 0);
  if (cashCents <= 0) {
    throw new ValidationFailedError({ reason: 'cashCents must be > 0' });
  }
  const currency = cfg.currencies[input.currency];
  if (currency === undefined) {
    throw new ValidationFailedError({ currency: input.currency });
  }
  if (input.currency === 'SKR' && currency.devnetMint === null) {
    throw new ValidationFailedError({ reason: 'SKR devnet mint unverified' });
  }
  if (input.currency === 'ORE' && currency.mainnetOnly && ctx.config.solana.cluster !== 'mainnet') {
    throw new ValidationFailedError({ reason: 'ORE is mainnet-only' });
  }
  // Topup cap.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayTotal = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ sum: string | null }>(
      `SELECT COALESCE(SUM(delta_cents), 0)::text AS sum
       FROM ledger_entries
       WHERE user_id = $1 AND account = 'cash' AND reason = 'topup' AND created_at >= $2`,
      [input.userId, dayStart.toISOString()],
    );
    return BigInt(r.rows[0]?.sum ?? '0');
  });
  if (dayTotal + BigInt(cashCents) > BigInt(cfg.topUpCapCentsPerDay)) {
    throw new TopupCapReachedError({
      capCents: cfg.topUpCapCentsPerDay,
      dayTotal: dayTotal.toString(),
    });
  }
  const usdcAmount = cashCents / 100; // 1 USDC = 1 dollar; cashCents is in cents
  const amount = formatBaseUnits(BigInt(usdcAmount), currency.decimals);
  const mint = input.currency === 'SOL' ? null : (currency.devnetMint ?? currency.mint);
  const reference = uuidv7().replace(/-/g, '').slice(0, 32);
  const memo = uuidv7();
  const intentId = uuidv7();
  const expiresAt = new Date(Date.now() + INTENT_TTL_SEC * 1000).toISOString();
  await ctx.db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO payment_intents
       (intent_id, user_id, kind, currency, amount, recipient, mint, reference, memo, cash_cents, bonus_bps, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)`,
      [
        intentId,
        input.userId,
        input.kind,
        input.currency,
        amount,
        ctx.config.solana.treasuryPubkey,
        mint,
        reference,
        memo,
        cashCents,
        cfg.currencyBonusBps[input.currency],
        expiresAt,
      ],
    );
  });
  const solanaPayUrl = buildSolanaPayUrl({
    recipient: ctx.config.solana.treasuryPubkey,
    amount,
    splToken: mint,
    reference,
    memo,
    label: 'CT Life',
    message: 'Cash top-up',
  });
  return {
    intentId,
    recipient: ctx.config.solana.treasuryPubkey,
    mint,
    amount,
    reference,
    memo,
    solanaPayUrl,
    expiresAt,
  };
}

/**
 * Mark a topup intent as submitted by the client. The webhook
 * and the poller are the actual crediting paths; this endpoint
 * only updates the local record so the UI can show "submitted".
 */
export async function markSubmitted(
  ctx: AppContext,
  userId: string,
  intentId: string,
  signature: string,
): Promise<void> {
  await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ user_id: string; status: string; signature: string | null }>(
      `SELECT user_id, status, signature FROM payment_intents WHERE intent_id = $1`,
      [intentId],
    );
    if ((r.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'intent', id: intentId });
    const row = r.rows[0]!;
    if (row.user_id !== userId) throw new NotFoundError({ kind: 'intent', id: intentId });
    if (row.status !== 'pending') return;
    if (row.signature === null) {
      await c.query(
        `UPDATE payment_intents SET signature = $1 WHERE intent_id = $2 AND signature IS NULL`,
        [signature, intentId],
      );
    }
  });
}

/**
 * Mark all pending intents past their expires_at as 'expired'.
 * The poller runs this every 30 s.
 */
export async function expirePendingIntents(ctx: AppContext): Promise<number> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<{ count: string }>(
      `WITH expired AS (
         UPDATE payment_intents
         SET status = 'expired'
         WHERE status = 'pending' AND expires_at < now()
         RETURNING intent_id
       )
       SELECT COUNT(*)::text AS count FROM expired`,
    );
    return Number(r.rows[0]?.count ?? '0');
  });
}

function buildSolanaPayUrl(args: {
  recipient: string;
  amount: string;
  splToken: string | null;
  reference: string;
  memo: string;
  label: string;
  message: string;
}): string {
  const params = new URLSearchParams();
  params.set('amount', args.amount);
  if (args.splToken !== null) params.set('spl-token', args.splToken);
  params.set('reference', args.reference);
  params.set('memo', args.memo);
  params.set('label', args.label);
  params.set('message', args.message);
  return `solana:${args.recipient}?${params.toString()}`;
}

function formatBaseUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = units % base;
  return `${whole.toString()}.${frac.toString().padStart(decimals, '0')}`;
}
