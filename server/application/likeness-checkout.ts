/** Server-priced USDC quote, owner receipt and finalized one-payment/one-entitlement issuance. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { z } from 'zod';
import type { Db } from '../shared/db/pool.js';
import { runInTransaction } from '../shared/db/uow.js';
import {
  NotFoundError,
  ValidationFailedError,
  ForbiddenError,
  ConflictError,
} from '../shared/domain/errors.js';
import { LikenessUnavailableError } from '../shared/domain/likeness.js';
import {
  verifyLikenessPayment,
  type LikenessPaymentProof,
} from '../shared/solana/likeness-payment.js';
import { likenessActionReceipt } from './likeness-actions.js';
import { recordLikenessAction } from '../shared/db/likeness-receipts.js';

export interface LikenessCheckoutConfig {
  enabled: boolean;
  priceUsdcCents: number;
  cluster: 'mainnet' | 'devnet';
  mint: string;
  recipient: string;
  models: Readonly<Record<string, unknown>>;
}
export interface LikenessCheckoutRpc {
  rpc<T>(method: string, params: unknown[]): Promise<T>;
}
interface Intent extends LikenessPaymentProof {
  id: string;
  user_id: string;
  request_hash: string;
  model_id: string;
  cluster: 'mainnet' | 'devnet';
  transaction_base64: string;
  last_valid_block_height: string;
  signature: string | null;
  status: 'pending' | 'confirmed' | 'expired' | 'manual_review';
  entitlement_id: string | null;
}
const Input = z.strictObject({
  modelId: z.enum(['head_snow', 'head_rain', 'head_ubc_m', 'head_ubc_f']),
});
const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
/** Integer six-decimal USDC value, serialized without floating-point arithmetic. */
export function likenessPrice(cents: number) {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 100_000) return null;
  const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  return { amount, currency: 'USDC' as const, display: `${amount} USDC` };
}
function quote(row: Intent) {
  return {
    intentId: row.id,
    modelId: row.model_id,
    currency: 'USDC',
    amountBaseUnits: row.amount_base_units,
    amount: `${BigInt(row.amount_base_units) / 1_000_000n}.${(BigInt(row.amount_base_units) % 1_000_000n).toString().padStart(6, '0')}`,
    cluster: row.cluster,
    mint: row.mint,
    recipient: row.recipient,
    reference: row.reference,
    transactionBase64: row.transaction_base64,
    expiresAt: row.expires_at.toISOString(),
  };
}
function status(row: Intent) {
  return {
    intentId: row.id,
    modelId: row.model_id,
    status: row.status,
    entitlementId: row.entitlement_id,
  };
}

export class LikenessCheckoutService {
  /** Bind the configured cluster RPC and immutable product settings. */
  constructor(
    private readonly db: Db,
    private readonly config: LikenessCheckoutConfig,
    private readonly rpc: LikenessCheckoutRpc,
    private readonly now: () => Date = () => new Date(),
  ) {}
  /** Create or replay an owner-bound quote without signing or sending funds. */
  async create(userId: string, key: unknown, raw: unknown) {
    const input = Input.safeParse(raw);
    likenessActionReceipt(key, 'checkout');
    if (!input.success) throw new ValidationFailedError({ reason: 'invalid_likeness_checkout' });
    const hash = createHash('sha256').update(JSON.stringify(input.data)).digest('hex');
    const existing = await this.db.withConnection((c) =>
      c.query<Intent>(
        'SELECT * FROM likeness_payment_intents WHERE user_id=$1 AND request_key=$2',
        [userId, key],
      ),
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== hash)
        throw new ValidationFailedError({ reason: 'idempotency_body_mismatch' });
      return quote(existing.rows[0]);
    }
    if (
      !this.config.enabled ||
      !likenessPrice(this.config.priceUsdcCents) ||
      !this.config.models[input.data.modelId]
    )
      throw new LikenessUnavailableError();
    // Recover a payment broadcast before the app could submit its signature.
    const pending = await this.db.withConnection((c) =>
      c.query<{ id: string }>(
        "SELECT id FROM likeness_payment_intents WHERE user_id=$1 AND status='pending'",
        [userId],
      ),
    );
    for (const intent of pending.rows) await this.get(userId, intent.id);
    const user = await this.db.withConnection((c) =>
      c.query<{ wallet: string }>('SELECT wallet FROM users WHERE id=$1', [userId]),
    );
    if (!user.rows[0]) throw new NotFoundError({ kind: 'user' });
    const payer = new PublicKey(user.rows[0].wallet),
      recipient = new PublicKey(this.config.recipient),
      mint = new PublicKey(this.config.mint),
      reference = new PublicKey(randomBytes(32));
    const id = randomUUID(),
      memo = `CTLife:likeness:${id}`,
      now = this.now(),
      expiresAt = new Date(now.getTime() + 120_000);
    const amount = BigInt(this.config.priceUsdcCents) * 10_000n;
    const latest = z
      .object({
        value: z.object({
          blockhash: z.string(),
          lastValidBlockHeight: z.number().int().positive(),
        }),
      })
      .parse(await this.rpc.rpc('getLatestBlockhash', [{ commitment: 'finalized' }])).value;
    const source = getAssociatedTokenAddressSync(mint, payer),
      destination = getAssociatedTokenAddressSync(mint, recipient);
    const transfer = createTransferCheckedInstruction(source, mint, destination, payer, amount, 6);
    // Solana Pay reference is an extra read-only transfer account, not a memo signer.
    transfer.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: latest.blockhash,
      instructions: [
        createAssociatedTokenAccountIdempotentInstruction(payer, destination, recipient, mint),
        transfer,
        new TransactionInstruction({
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [],
          data: Buffer.from(memo),
        }),
      ],
    }).compileToV0Message();
    const transaction = Buffer.from(new VersionedTransaction(message).serialize()).toString(
      'base64',
    );
    return runInTransaction(
      async (c) => {
        await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
        const replay = await c.query<Intent>(
          'SELECT * FROM likeness_payment_intents WHERE user_id=$1 AND request_key=$2',
          [userId, key],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== hash)
            throw new ValidationFailedError({ reason: 'idempotency_body_mismatch' });
          return quote(replay.rows[0]);
        }
        if (
          (
            await c.query(
              "SELECT id FROM likeness_payment_intents WHERE user_id=$1 AND status IN ('pending','manual_review')",
              [userId],
            )
          ).rowCount
        )
          throw new ConflictError({ reason: 'likeness_payment_already_pending' });
        if (
          (
            await c.query(
              `SELECT id FROM likeness_entitlements WHERE user_id=$1
          AND payment_source IN ('solana_devnet','solana_mainnet') AND revoked_at IS NULL
          AND fulfillment_status IN ('delivery_owed','manual_review')`,
              [userId],
            )
          ).rowCount
        )
          throw new ConflictError({ reason: 'likeness_delivery_already_owed' });
        const rows = await c.query<Intent>(
          `INSERT INTO likeness_payment_intents(id,user_id,request_key,request_hash,model_id,amount_base_units,cluster,mint,payer,recipient,reference,memo,transaction_base64,created_at,expires_at,last_valid_block_height)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)RETURNING *`,
          [
            id,
            userId,
            key,
            hash,
            input.data.modelId,
            amount.toString(),
            this.config.cluster,
            mint.toBase58(),
            payer.toBase58(),
            recipient.toBase58(),
            reference.toBase58(),
            memo,
            transaction,
            now,
            expiresAt,
            latest.lastValidBlockHeight,
          ],
        );
        return quote(rows.rows[0]!);
      },
      {},
      this.db,
    );
  }
  /** Resume the latest unresolved owned checkout, including interrupted broadcasts. */
  async current(userId: string) {
    const rows = await this.db.withConnection((c) =>
      c.query<{ id: string }>(
        `SELECT p.id FROM likeness_payment_intents p LEFT JOIN likeness_entitlements e ON e.id=p.entitlement_id WHERE p.user_id=$1 AND (p.status IN ('pending','manual_review') OR (p.status='confirmed' AND e.revoked_at IS NULL AND e.fulfillment_status IN ('delivery_owed','manual_review'))) ORDER BY p.created_at DESC LIMIT 1`,
        [userId],
      ),
    );
    return { checkout: rows.rows[0] ? await this.get(userId, rows.rows[0].id) : null };
  }
  private async owned(userId: string, id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new ValidationFailedError({ reason: 'invalid_likeness_checkout_id' });
    const rows = await this.db.withConnection((c) =>
      c.query<Intent>('SELECT * FROM likeness_payment_intents WHERE id=$1 AND user_id=$2', [
        id,
        userId,
      ]),
    );
    if (!rows.rows[0]) throw new NotFoundError({ kind: 'likeness_checkout' });
    return rows.rows[0];
  }
  /** Record a wallet receipt then verify it against finalized chain data. */
  async submitted(userId: string, id: string, key: unknown, raw: unknown) {
    const body = z.strictObject({ signature: Signature }).safeParse(raw);
    if (!body.success) throw new ValidationFailedError({ reason: 'invalid_payment_signature' });
    const receipt = likenessActionReceipt(key, `likeness-payment/${id}/${body.data.signature}`);
    await this.owned(userId, id);
    try {
      await runInTransaction(
        async (c) => {
          const rows = await c.query<Intent>(
            'SELECT * FROM likeness_payment_intents WHERE id=$1 AND user_id=$2 FOR UPDATE',
            [id, userId],
          );
          const row = rows.rows[0]!;
          if (row.signature && row.signature !== body.data.signature)
            throw new ConflictError({ reason: 'payment_signature_already_recorded' });
          if (await recordLikenessAction(c, userId, receipt, this.now())) return;
          await c.query('UPDATE likeness_payment_intents SET signature=$2 WHERE id=$1', [
            id,
            body.data.signature,
          ]);
        },
        {},
        this.db,
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ConflictError({ reason: 'payment_signature_already_used' });
      throw e;
    }
    return this.get(userId, id);
  }
  /** Reconcile finalized payment and atomically issue one dedicated entitlement. */
  async get(userId: string, id: string) {
    let row = await this.owned(userId, id);
    if (row.status === 'confirmed') {
      const fulfillment = await this.db.withConnection((c) =>
        c.query<{ fulfillment_status: string }>(
          'SELECT fulfillment_status FROM likeness_entitlements WHERE id=$1',
          [row.entitlement_id],
        ),
      );
      return {
        ...status(row),
        resolution: fulfillment.rows[0]?.fulfillment_status ?? 'delivery_owed',
      };
    }
    if (row.status === 'manual_review')
      return {
        ...status(row),
        resolution: row.entitlement_id ? 'delivery_owed' : 'payment_review',
      };
    if (row.cluster !== this.config.cluster)
      throw new ForbiddenError({ reason: 'payment_cluster_mismatch' });
    if (!row.signature) {
      // Check finalized block height BEFORE history, so a payment finalizing at expiry
      // is visible in the subsequent finalized reference scan.
      const height = z
        .number()
        .int()
        .nonnegative()
        .parse(await this.rpc.rpc('getBlockHeight', [{ commitment: 'finalized' }]));
      const signatures = z
        .array(z.object({ signature: Signature }))
        .parse(
          await this.rpc.rpc('getSignaturesForAddress', [
            row.reference,
            { commitment: 'finalized', limit: 20 },
          ]),
        );
      for (const candidate of signatures) {
        const raw = await this.rpc.rpc('getTransaction', [
          candidate.signature,
          { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
        ]);
        const identity = z
          .object({
            transaction: z.object({
              message: z.object({
                accountKeys: z.array(z.object({ pubkey: z.string(), signer: z.boolean() })),
                instructions: z.array(
                  z.object({ programId: z.string(), parsed: z.unknown().optional() }),
                ),
              }),
            }),
          })
          .safeParse(raw);
        if (
          !identity.success ||
          identity.data.transaction.message.accountKeys[0]?.pubkey !== row.payer ||
          !identity.data.transaction.message.accountKeys[0]?.signer ||
          !identity.data.transaction.message.instructions.some(
            (i) =>
              i.programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' &&
              i.parsed === row.memo,
          )
        )
          continue;
        await this.db.withConnection((c) =>
          c.query(
            'UPDATE likeness_payment_intents SET signature=$2 WHERE id=$1 AND signature IS NULL',
            [id, candidate.signature],
          ),
        );
        row = await this.owned(userId, id);
        break;
      }
      if (!row.signature) {
        if (signatures.length === 20) {
          await this.db.withConnection((c) =>
            c.query(
              "UPDATE likeness_payment_intents SET status='manual_review',failure_reason='reference_history_requires_review' WHERE id=$1 AND status='pending'",
              [id],
            ),
          );
          return { ...status(row), status: 'manual_review', resolution: 'payment_review' };
        }
        if (BigInt(height) > BigInt(row.last_valid_block_height)) {
          await this.db.withConnection((c) =>
            c.query(
              "UPDATE likeness_payment_intents SET status='expired' WHERE id=$1 AND signature IS NULL AND status='pending'",
              [id],
            ),
          );
          return status(await this.owned(userId, id));
        }
        return status(row);
      }
    }
    // Receipt verification is permitted while new checkout/generation is disabled.
    const tx = await this.rpc.rpc('getTransaction', [
      row.signature,
      { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
    ]);
    if (tx === null) return status(row);
    const failure = verifyLikenessPayment(tx, row);
    return runInTransaction(
      async (c) => {
        const locked = await c.query<Intent>(
          'SELECT * FROM likeness_payment_intents WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [id, userId],
        );
        const current = locked.rows[0]!;
        if (current.status === 'confirmed' || current.status === 'manual_review')
          return status(current);
        if (failure) {
          const updated = await c.query<Intent>(
            "UPDATE likeness_payment_intents SET status='manual_review',failure_reason=$2 WHERE id=$1 RETURNING *",
            [id, failure],
          );
          return status(updated.rows[0]!);
        }
        const entitlement = randomUUID();
        await c.query(
          `INSERT INTO likeness_entitlements(id,user_id,product_id,payment_source,payment_reference,amount_base_units,currency,verified_at,credit_budget)
        VALUES($1,$2,'likeness_3d_v1',$3,$4,$5,'USDC',$6,85)`,
          [
            entitlement,
            userId,
            `solana_${row.cluster}`,
            row.signature,
            row.amount_base_units,
            this.now(),
          ],
        );
        const updated = await c.query<Intent>(
          "UPDATE likeness_payment_intents SET status='confirmed',entitlement_id=$2 WHERE id=$1 RETURNING *",
          [id, entitlement],
        );
        return status(updated.rows[0]!);
      },
      {},
      this.db,
    );
  }
}
