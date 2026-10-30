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
import { randomBytes } from 'node:crypto';
import { uuidv7 } from '../shared/domain/uuid.js';
import { TokenAmount } from '../shared/domain/token-amount.js';
import {
  TopupCapReachedError,
  NotFoundError,
  ValidationFailedError,
  PaymentExpiredError,
  ConflictError,
} from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import { runInTransaction } from '../shared/db/uow.js';
import { verifyUsdcTransfer } from '../shared/solana/likeness-payment.js';
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  Connection,
} from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { assertCapabilityOn, isCapabilityOn } from './capabilities.js';
import { assertDevnetChain, clusterRpc } from './chain-rpc.js';
import { publishToUser } from './realtime-bus.js';
import { grantSeasonPass, SEASON_PASS_PRICE_USDC_BASE } from './season-pass.js';
import { currentSeason, hasLivePass } from './season-tracks.js';

export type Currency = 'USDC' | 'SOL' | 'SKR' | 'ORE';
export type TopupSku = 'ramen' | 'bag' | 'whale' | 'cabal' | 'custom' | 'season_pass';
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
  readonly amount: string; // B19: base units as integer string
  readonly reference: string;
  readonly memo: string;
  readonly tx: string; // B19: add unsigned transaction base64
  readonly currency: Currency; // B19: add currency
  readonly cashCents: number; // B19: add cashCents
  readonly bonusBps: number; // B19: add bonusBps
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

  // The season pass has its own sku, price and settlement (no Cash).
  if (input.kind === 'season_pass' || input.sku === 'season_pass') {
    if (input.kind !== 'season_pass' || input.sku !== 'season_pass') {
      throw new ValidationFailedError({ reason: 'sku_kind_mismatch' });
    }
    if (input.currency !== 'USDC') {
      throw new ValidationFailedError({ reason: 'season_pass_usdc_only' });
    }
    return createSeasonPassIntent(ctx, input.userId);
  }

  // B19 fix: Reject 'custom' until pricing rules are defined
  if (input.sku === 'custom') {
    throw new ValidationFailedError({ reason: 'custom sku not yet supported' });
  }

  const pack = cfg.topUpPacks.find((p) => p.id === input.sku);
  if (pack === undefined) {
    throw new ValidationFailedError({ sku: input.sku });
  }

  const cashCents = pack.cashCents;
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

  // B19 fix: Compute amount from pack.priceUsdc in base units (integer)
  // For non-USDC currencies, would need a price feed (not implemented, return 503)
  if (input.currency !== 'USDC') {
    // B19: For SOL/SKR/ORE, need price feed to convert from USDC price
    throw new ValidationFailedError({ reason: `${input.currency} requires price feed (degraded)` });
  }
  // priceUsdc is in dollars (e.g., 1 for ramen pack)
  // USDC has 6 decimals, so 1 USDC = 1_000_000 base units
  const priceUsdc = pack.priceUsdc;
  const amountBaseUnits = BigInt(priceUsdc) * 1_000_000n;

  // Topup cap: check against USDC value paid, not Cash cents
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayTotal = await ctx.db.withConnection(async (c) => {
    // B19 fix: Sum the actual USDC cents paid (amount * 100 / 10^6), not cash credited
    const r = await c.query<{ sum: string | null }>(
      `SELECT COALESCE(SUM((amount::numeric * 100 / 1000000)::bigint), 0)::text AS sum
       FROM payment_intents
       WHERE user_id = $1 AND kind = 'topup' AND status = 'confirmed' AND created_at >= $2`,
      [input.userId, dayStart.toISOString()],
    );
    return BigInt(r.rows[0]?.sum ?? '0');
  });
  const priceUsdcCents = pack.priceUsdc * 100; // Convert dollars to cents
  if (dayTotal + BigInt(priceUsdcCents) > BigInt(cfg.topUpCapCentsPerDay)) {
    throw new TopupCapReachedError({
      capCents: cfg.topUpCapCentsPerDay,
      dayTotal: dayTotal.toString(),
    });
  }

  const prepared = await prepareUsdcIntent(ctx, {
    userId: input.userId,
    kind: input.kind,
    amountBaseUnits,
    cashCents,
    bonusBps: cfg.currencyBonusBps[input.currency],
    message: 'Cash top-up',
  });
  await ctx.db.withConnection((c) => insertPreparedIntent(c, prepared));
  return prepared.result;
}

/** A built, unsigned USDC intent that has not been stored yet. */
export interface PreparedIntent {
  readonly userId: string;
  readonly kind: TopupKind;
  readonly result: IntentResult;
}

/**
 * Build a USDC payment intent for `amountBaseUnits` to the treasury: a fresh
 * reference key, memo and unsigned v0 transfer the owner's wallet signs.
 * Call insertPreparedIntent (possibly inside a larger transaction) to keep it.
 */
export async function prepareUsdcIntent(
  ctx: AppContext,
  args: {
    userId: string;
    kind: TopupKind;
    amountBaseUnits: bigint;
    cashCents: number;
    bonusBps: number;
    message: string;
  },
): Promise<PreparedIntent> {
  const cfg = ctx.configCache.load<EconomyConfig>('economy');
  const currency = cfg.currencies.USDC;
  const { amountBaseUnits } = args;
  const amount = amountBaseUnits.toString(); // B19: integer string, not decimal
  const mintAddress = currency.devnetMint ?? currency.mint;
  if (!mintAddress) {
    throw new ValidationFailedError({ reason: 'USDC mint address not configured' });
  }
  // Solana Pay wants the reference to be a pubkey: it rides along as a
  // read-only key so the payment can be found on chain later.
  const referencePubkey = new PublicKey(randomBytes(32));
  const reference = referencePubkey.toBase58();
  const memo = uuidv7();
  const intentId = uuidv7();
  const expiresAt = new Date(Date.now() + INTENT_TTL_SEC * 1000).toISOString();

  // input.userId is the users.id UUID, never an on-chain address, so the
  // payer has to be looked up.
  const walletRow = await ctx.db.withConnection((c) =>
    c.query<{ wallet: string }>('SELECT wallet FROM users WHERE id = $1', [args.userId]),
  );
  const wallet = walletRow.rows[0]?.wallet;
  if (wallet === undefined) throw new NotFoundError({ kind: 'user', id: args.userId });
  let userPubkey: PublicKey;
  try {
    userPubkey = new PublicKey(wallet);
  } catch {
    throw new ValidationFailedError({ reason: 'user wallet is not a valid pubkey' });
  }
  const recipient = new PublicKey(ctx.config.solana.treasuryPubkey);

  const connection = new Connection(ctx.config.solana.rpcUrl, 'confirmed');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const mintPubkey = new PublicKey(mintAddress);
  const userAta = getAssociatedTokenAddressSync(mintPubkey, userPubkey);
  const recipientAta = getAssociatedTokenAddressSync(mintPubkey, recipient);

  const instructions = [
    createTransferCheckedInstruction(
      userAta,
      mintPubkey,
      recipientAta,
      userPubkey,
      amountBaseUnits,
      currency.decimals,
    ),
    // Memo instruction with reference as read-only key
    new TransactionInstruction({
      keys: [{ pubkey: referencePubkey, isSigner: false, isWritable: false }],
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      data: Buffer.from(memo, 'utf-8'),
    }),
  ];

  const messageV0 = new TransactionMessage({
    payerKey: userPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const versionedTx = new VersionedTransaction(messageV0);
  const tx = Buffer.from(versionedTx.serialize()).toString('base64');

  // Solana Pay's `amount` is in user units ("1" USDC), not base units;
  // the intent's `amount` field and the tx stay in base units.
  const solanaPayUrl = buildSolanaPayUrl({
    recipient: ctx.config.solana.treasuryPubkey,
    amount: TokenAmount.of(amountBaseUnits, {
      symbol: 'USDC',
      decimals: currency.decimals,
      mint: mintAddress,
    }).toDecimalString(),
    splToken: mintAddress,
    reference,
    memo,
    label: 'CT Life',
    message: args.message,
  });

  return {
    userId: args.userId,
    kind: args.kind,
    result: {
      intentId,
      recipient: ctx.config.solana.treasuryPubkey,
      mint: mintAddress,
      amount,
      reference,
      memo,
      tx, // B19: add unsigned transaction
      currency: 'USDC',
      cashCents: args.cashCents,
      bonusBps: args.bonusBps,
      solanaPayUrl,
      expiresAt,
    },
  };
}

/** Store a prepared intent as 'pending'. */
export async function insertPreparedIntent(
  c: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  p: PreparedIntent,
): Promise<void> {
  const r = p.result;
  await c.query(
    `INSERT INTO payment_intents
     (intent_id, user_id, kind, currency, amount, recipient, mint, reference, memo, cash_cents, bonus_bps, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)`,
    [
      r.intentId,
      p.userId,
      p.kind,
      r.currency,
      r.amount,
      r.recipient,
      r.mint,
      r.reference,
      r.memo,
      r.cashCents,
      r.bonusBps,
      r.expiresAt,
    ],
  );
}

/**
 * Get a payment intent by id (for the owner only). Status wins over the
 * clock: a confirmed intent stays confirmed after its expiry, and a pending
 * intent with a reported signature stays pending while it is reconciled.
 * 410 only for an intent that expired with nothing on chain.
 */
export async function getPaymentIntent(
  ctx: AppContext,
  userId: string,
  intentId: string,
): Promise<{ status: string; signature?: string }> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ status: string; signature: string | null; expires_at: Date }>(
      `SELECT status, signature, expires_at FROM payment_intents WHERE intent_id = $1 AND user_id = $2`,
      [intentId, userId],
    );
  });
  if (r.rowCount === 0) {
    throw new NotFoundError({ kind: 'payment_intent', id: intentId });
  }
  const intent = r.rows[0]!;
  const unsignedPastExpiry =
    intent.status === 'pending' &&
    intent.signature === null &&
    Date.now() > new Date(intent.expires_at).getTime();
  if (intent.status === 'expired' || unsignedPastExpiry) {
    throw new PaymentExpiredError({ intentId });
  }
  return {
    status: intent.status,
    signature: intent.signature ?? undefined,
  };
}

/**
 * Record the wallet's signature for an intent and try to reconcile it at
 * once. Reporting never credits by itself: only a finalized, verified
 * transfer does. The first reported signature is kept; a different one
 * is ignored (reconciliation also scans the intent's reference).
 */
export async function markSubmitted(
  ctx: AppContext,
  userId: string,
  intentId: string,
  signature: string,
): Promise<void> {
  const record = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ user_id: string; status: string; signature: string | null }>(
      `SELECT user_id, status, signature FROM payment_intents WHERE intent_id = $1`,
      [intentId],
    );
    if ((r.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'intent', id: intentId });
    const row = r.rows[0]!;
    if (row.user_id !== userId) throw new NotFoundError({ kind: 'intent', id: intentId });
    if (row.status === 'confirmed' || row.status === 'failed') return false;
    if (row.signature === null) {
      try {
        await c.query(
          `UPDATE payment_intents SET signature = $1 WHERE intent_id = $2 AND signature IS NULL`,
          [signature, intentId],
        );
      } catch (e) {
        // Another intent already holds this signature; it cannot be ours.
        if ((e as { code?: string }).code !== '23505') throw e;
      }
    }
    return true;
  });
  if (record) {
    try {
      await reconcilePaymentIntent(ctx, intentId);
    } catch {
      // RPC trouble: the poller retries.
    }
  }
}

export type ReconcileOutcome = 'confirmed' | 'pending' | 'expired' | 'failed' | 'unchanged';

/**
 * Intent kinds settled from chain data: top-ups credit Cash, ads advance a booking,
 * season passes grant the pass (no Cash).
 */
const RECONCILED_KINDS: readonly string[] = ['topup', 'ad', 'season_pass'];

/** How long a reported-but-unfinalized payment keeps being reconciled. */
const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Grace past expiry before an unsigned intent with no chain activity expires. */
const EXPIRY_GRACE_MS = 5 * 60 * 1000;

interface OpenIntent {
  intent_id: string;
  user_id: string;
  kind: string;
  status: string;
  signature: string | null;
  reference: string;
  memo: string;
  mint: string;
  recipient: string;
  amount: string;
  cash_cents: string;
  bonus_bps: number;
  expires_at: Date;
  wallet: string;
}

/**
 * Reconcile one top-up or ad intent against finalized chain data. Candidates are
 * the reported signature (or `signatureHint`, e.g. from the webhook) plus
 * the reference's finalized history, so a missed webhook or a missing report
 * still credits. Each candidate must be a successful transfer of the exact
 * amount, mint and recipient with this intent's reference and memo, signed
 * by the owner's wallet. Settles once, even after the displayed expiry.
 */
export async function reconcilePaymentIntent(
  ctx: AppContext,
  intentId: string,
  signatureHint?: string,
): Promise<ReconcileOutcome> {
  const r = await ctx.db.withConnection((c) =>
    c.query<OpenIntent>(
      `SELECT p.intent_id, p.user_id, p.kind, p.status, p.signature, p.reference, p.memo,
              p.mint, p.recipient, p.amount, p.cash_cents, p.bonus_bps, p.expires_at, u.wallet
       FROM payment_intents p JOIN users u ON u.id = p.user_id
       WHERE p.intent_id = $1`,
      [intentId],
    ),
  );
  const intent = r.rows[0];
  if (!intent || !RECONCILED_KINDS.includes(intent.kind) || intent.status === 'confirmed') {
    return 'unchanged';
  }
  if (intent.kind === 'season_pass') {
    // A season_pass intent at any other price (e.g. one made before unlock C1, priced
    // from a top-up pack) never grants a pass: it fails here and is refunded by hand.
    if (!isSeasonPassPrice(intent.amount))
      return failLegacySeasonPass(ctx, intent.intent_id, intent.amount);
    // While the capability is off nothing is granted, but an abandoned intent (never
    // signed, nothing on chain, past expiry + grace) still expires so none pile up.
    if (!isCapabilityOn(ctx, 'seasonPassPurchase')) return expireIfAbandoned(ctx, intent);
  }

  const candidates = new Set<string>();
  if (signatureHint) candidates.add(signatureHint);
  if (intent.signature) candidates.add(intent.signature);
  const rpc = clusterRpc(ctx);
  const history = await rpc.rpc<Array<{ signature: string; err: unknown }> | null>(
    'getSignaturesForAddress',
    [intent.reference, { commitment: 'finalized', limit: 20 }],
  );
  for (const h of history ?? []) candidates.add(h.signature);

  let reportedFailed = false;
  for (const signature of candidates) {
    const raw = await rpc.rpc<unknown>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
    ]);
    if (raw === null || raw === undefined) continue; // not finalized (yet)
    const error = verifyUsdcTransfer(raw, {
      payer: intent.wallet,
      recipient: intent.recipient,
      mint: intent.mint,
      reference: intent.reference,
      memo: intent.memo,
      amount_base_units: intent.amount,
    });
    if (error === null) return settleVerifiedIntent(ctx, intent.intent_id, signature);
    if (signature === intent.signature && error === 'transaction_failed') reportedFailed = true;
  }

  const now = Date.now();
  const expiresAt = new Date(intent.expires_at).getTime();
  if (reportedFailed && (history ?? []).length === 0) {
    // The wallet's own transfer failed on chain and nothing else paid it.
    await ctx.db.withConnection((c) =>
      c.query(
        `UPDATE payment_intents SET status = 'failed' WHERE intent_id = $1 AND status = 'pending'`,
        [intent.intent_id],
      ),
    );
    return 'failed';
  }
  if (
    intent.status === 'pending' &&
    intent.signature === null &&
    (history ?? []).length === 0 &&
    now > expiresAt + EXPIRY_GRACE_MS
  ) {
    await ctx.db.withConnection((c) =>
      c.query(
        `UPDATE payment_intents SET status = 'expired' WHERE intent_id = $1 AND status = 'pending'`,
        [intent.intent_id],
      ),
    );
    return 'expired';
  }
  return 'pending';
}

/**
 * Expire an intent that was never signed and has nothing on chain, once past its expiry
 * plus grace; otherwise leave it pending. Grants nothing.
 */
async function expireIfAbandoned(ctx: AppContext, intent: OpenIntent): Promise<ReconcileOutcome> {
  if (intent.status !== 'pending') return 'unchanged';
  if (intent.signature !== null) return 'pending';
  if (Date.now() <= new Date(intent.expires_at).getTime() + EXPIRY_GRACE_MS) return 'pending';
  const history = await clusterRpc(ctx).rpc<Array<{ signature: string }> | null>(
    'getSignaturesForAddress',
    [intent.reference, { commitment: 'finalized', limit: 1 }],
  );
  if ((history ?? []).length > 0) return 'pending';
  await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE payment_intents SET status = 'expired' WHERE intent_id = $1 AND status = 'pending'`,
      [intent.intent_id],
    ),
  );
  return 'expired';
}

function isSeasonPassPrice(amount: string): boolean {
  return amount === SEASON_PASS_PRICE_USDC_BASE.toString();
}

async function failLegacySeasonPass(
  ctx: AppContext,
  intentId: string,
  amount: string,
): Promise<ReconcileOutcome> {
  console.error(
    `[payments] ALERT season_pass intent ${intentId} priced ${amount}, not ${SEASON_PASS_PRICE_USDC_BASE}: ` +
      'no pass granted; refund any payment by hand',
  );
  await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE payment_intents SET status = 'failed'
        WHERE intent_id = $1 AND status IN ('pending', 'expired')`,
      [intentId],
    ),
  );
  return 'failed';
}

async function settleVerifiedIntent(
  ctx: AppContext,
  intentId: string,
  signature: string,
): Promise<ReconcileOutcome> {
  let passFor: string | null = null;
  const outcome = await runInTransaction(async (client): Promise<ReconcileOutcome> => {
    const r = await client.query<{
      user_id: string;
      kind: string;
      status: string;
      cash_cents: string;
      bonus_bps: number;
      created_at: Date;
      amount: string;
    }>(
      `SELECT user_id, kind, status, cash_cents, bonus_bps, created_at, amount FROM payment_intents
       WHERE intent_id = $1 FOR UPDATE`,
      [intentId],
    );
    const intent = r.rows[0];
    if (!intent || intent.status === 'confirmed') return 'unchanged';
    // An unverified report elsewhere must not block the verified owner.
    await client.query(
      `UPDATE payment_intents SET signature = NULL
       WHERE signature = $1 AND intent_id <> $2 AND status <> 'confirmed'`,
      [signature, intentId],
    );
    if (intent.kind === 'season_pass') {
      // Re-checked under the row lock: only a 5 USDC intent, only while the capability is on.
      if (!isSeasonPassPrice(intent.amount) || !isCapabilityOn(ctx, 'seasonPassPurchase')) {
        return 'unchanged';
      }
      // The pass for the season the intent was bought in. No Cash moves.
      const season = currentSeason(intent.created_at);
      if (season !== null) {
        await grantSeasonPass(client, intent.user_id, season);
        passFor = intent.user_id;
      }
    } else if (intent.kind === 'ad') {
      // Paid in time: on to review. Paid after the hold lapsed or the owner
      // cancelled: the money is owed back.
      await client.query(
        `UPDATE ad_bookings SET
           paid_at = now(),
           status = CASE WHEN status = 'awaiting_payment' THEN 'pending_review' ELSE status END,
           refund_status = CASE WHEN status = 'awaiting_payment' THEN refund_status ELSE 'due' END,
           refund_cents = CASE WHEN status = 'awaiting_payment' THEN refund_cents ELSE price_cents END
         WHERE intent_id = $1 AND paid_at IS NULL`,
        [intentId],
      );
    } else {
      const bonus = (BigInt(intent.cash_cents) * BigInt(intent.bonus_bps)) / 10_000n;
      const total = BigInt(intent.cash_cents) + bonus;
      const ledger = await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'topup', 'payment_intent', $3, $4)
         ON CONFLICT (idempotency_ref) DO NOTHING`,
        [intent.user_id, total.toString(), intentId, `topup:${intentId}`],
      );
      if ((ledger.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
          [intent.user_id, total.toString()],
        );
      }
    }
    await client.query(
      `UPDATE payment_intents SET status = 'confirmed', signature = $1 WHERE intent_id = $2`,
      [signature, intentId],
    );
    return 'confirmed';
  });
  if (passFor !== null) {
    await publishToUser(ctx, passFor, 'payment_confirmed', {
      intentId,
      cashCents: 0,
      kind: 'season_pass',
    });
  }
  return outcome;
}

/**
 * Create a season-pass payment intent (unlock C1): 5 USDC to the treasury, same
 * Solana Pay shape as a top-up. Settlement grants the pass for the current season and
 * never credits Cash.
 *
 * @param ctx - The app context.
 * @param userId - The buyer.
 * @returns The intent (amount '5000000', unsigned v0 `tx`, `solanaPayUrl`).
 * @throws CapabilityOffError while `seasonPassPurchase` is off or off devnet.
 * @throws ConflictError `already_active` with a live pass, `no_active_season`, or
 *   `intent_pending` while an earlier signed intent is still being reconciled.
 */
export async function createSeasonPassIntent(
  ctx: AppContext,
  userId: string,
): Promise<IntentResult> {
  assertCapabilityOn(ctx, 'seasonPassPurchase');
  assertDevnetChain(ctx, 'seasonPassPurchase');
  const now = new Date();
  const season = currentSeason(now);
  if (season === null) throw new ConflictError({ reason: 'no_active_season' });
  const blocked = await ctx.db.withConnection(async (c) => {
    if (await hasLivePass(c, userId, now)) return { reason: 'already_active' };
    const p = await c.query<{ intent_id: string }>(
      `SELECT intent_id FROM payment_intents
       WHERE user_id = $1 AND kind = 'season_pass' AND status = 'pending' AND signature IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const pending = p.rows[0];
    return pending ? { reason: 'intent_pending', intentId: pending.intent_id } : null;
  });
  if (blocked !== null) throw new ConflictError(blocked);
  const prepared = await prepareUsdcIntent(ctx, {
    userId,
    kind: 'season_pass',
    amountBaseUnits: SEASON_PASS_PRICE_USDC_BASE,
    cashCents: 0,
    bonusBps: 0,
    message: `CT Life ${season.name} pass`,
  });
  await ctx.db.withConnection((c) => insertPreparedIntent(c, prepared));
  return prepared.result;
}

/**
 * Poller pass: reconcile open top-up, ad and season-pass intents (pending, or expired within the
 * reconcile window in case a payment landed late) and expire the rest.
 * Returns per-outcome counts.
 */
export async function reconcileOpenIntents(
  ctx: AppContext,
  limit = 50,
): Promise<Record<ReconcileOutcome, number>> {
  // One bounded batch per kind, so a backlog of one kind never starves the others.
  const since = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const rows: Array<{ intent_id: string }> = [];
  for (const kind of RECONCILED_KINDS) {
    const r = await ctx.db.withConnection((c) =>
      c.query<{ intent_id: string }>(
        `SELECT intent_id FROM payment_intents
         WHERE kind = $1
           AND (status = 'pending' OR (status = 'expired' AND expires_at > $2))
         ORDER BY created_at ASC LIMIT $3`,
        [kind, since, limit],
      ),
    );
    rows.push(...r.rows);
  }
  const r = { rows };
  const counts: Record<ReconcileOutcome, number> = {
    confirmed: 0,
    pending: 0,
    expired: 0,
    failed: 0,
    unchanged: 0,
  };
  for (const row of r.rows) {
    try {
      counts[await reconcilePaymentIntent(ctx, row.intent_id)] += 1;
    } catch {
      counts.pending += 1; // RPC trouble: try again next pass
    }
  }
  return counts;
}

/**
 * Expire unsigned intents of other kinds past their expires_at. Top-up, ad and
 * season-pass intents expire only in reconcileOpenIntents, after a chain check.
 */
export async function expirePendingIntents(ctx: AppContext): Promise<number> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<{ count: string }>(
      `WITH expired AS (
         UPDATE payment_intents
         SET status = 'expired'
         WHERE status = 'pending' AND kind NOT IN ('topup', 'ad', 'season_pass') AND signature IS NULL
           AND expires_at < now()
         RETURNING intent_id
       )
       SELECT COUNT(*)::text AS count FROM expired`,
    );
    return Number(r.rows[0]?.count ?? '0');
  });
}

/**
 * Build a Solana Pay transfer request URL. `amount` must already be in
 * user units (a decimal string such as "1" or "0.5"), per the spec.
 */
export function buildSolanaPayUrl(args: {
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
