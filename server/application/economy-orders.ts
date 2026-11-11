import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import { DomainError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { economyAsset, type EconomyAsset } from './economy-assets.js';
import { getVerifiedWalletLink, type WalletContext } from './wallet-links.js';
import {
  validatePaymentExpectation,
  type EconomyChain,
  type PaymentExpectation,
  type PaymentEvidence,
  type PreparedPayment,
} from './economy-chain.js';

export class EconomyConflict extends DomainError {
  readonly code = 'ECONOMY_CONFLICT';
  /** Report a recoverable conflict without hiding its machine-readable reason. */
  constructor(reason: string) {
    super('The economic action cannot proceed in its current state.', { reason });
    this.httpStatus = 409;
  }
}

export type EconomyOrderStatus =
  'awaiting_payment' | 'cancelled' | 'expired' | 'paid' | 'fulfilled' | 'refund_due' | 'refunded';
interface OfferRow {
  offer_id: string;
  title: string;
  chain_id: string;
  asset_id: string;
  amount: string;
  recipient: string;
  terms_version: string;
  item_id: string;
}
interface OrderRow extends Omit<OfferRow, 'title'> {
  order_id: string;
  user_id: string;
  wallet_link_id: string;
  payer: string;
  status: EconomyOrderStatus;
  created_at: Date;
  expires_at: Date;
}
interface ReceiptRow {
  receipt_id: string;
  order_id: string;
  kind: 'payment' | 'refund';
  transaction_id: string;
  disposition: string;
  evidence: PaymentEvidence;
}
export interface EconomyOrder {
  orderId: string;
  offerId: string;
  userId: string;
  walletLinkId: string;
  asset: EconomyAsset;
  payer: string;
  recipient: string;
  amount: string;
  termsVersion: string;
  fulfilment: { kind: 'cosmetic'; itemId: string };
  status: EconomyOrderStatus;
  createdAt: string;
  expiresAt: string;
  paymentTransactionId?: string;
  refundTransactionId?: string;
  refundDueReceiptIds: string[];
  paymentReceipts: { receiptId: string; transactionId: string; disposition: string }[];
}

/**
 * Immutable quotes and an append-only receipt history surround existing inventory.
 * No ledger credit, synthetic reward, signing key or client-reported balance is used.
 * Failed RPC calls leave durable attempts; GET reconciles them without re-signing.
 */
export class EconomyOrders {
  /** Compose storage and a read-only native-chain verifier. */
  constructor(
    private readonly ctx: WalletContext,
    private readonly chain: EconomyChain,
  ) {}

  /** List explicitly priced and activated economic offers. */
  async catalog(): Promise<{ offers: unknown[] }> {
    const result = await this.ctx.db.pool.query<OfferRow>(
      `SELECT o.* FROM economy_offers o JOIN cosmetic_items i USING(item_id)
       WHERE o.active AND NOT i.grant_only AND NOT i.onchain_only ORDER BY o.offer_id`,
    );
    return {
      offers: result.rows.map((r) => ({
        offerId: r.offer_id,
        title: r.title,
        asset: economyAsset(r.chain_id, r.asset_id, r.amount),
        amount: r.amount,
        recipient: r.recipient,
        termsVersion: r.terms_version,
        fulfilment: { kind: 'cosmetic', itemId: r.item_id },
      })),
    };
  }

  private transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    return runInTransaction(fn, { isolation: 'read committed' }, this.ctx.db);
  }

  /** Paginated financial history from a single database snapshot; never prompts or polls RPC. */
  async history(
    userId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ orders: EconomyOrder[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new ValidationFailedError({ reason: 'invalid_history_limit' });
    let before: [string, string] | null = null;
    if (cursor) {
      try {
        if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          typeof value[0] !== 'string' ||
          typeof value[1] !== 'string' ||
          new Date(value[0]).toISOString() !== value[0] ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value[1])
        )
          throw new Error();
        before = [value[0], value[1]];
      } catch {
        throw new ValidationFailedError({ reason: 'invalid_history_cursor' });
      }
    }
    const result = await this.ctx.db.pool.query<OrderRow & { receipts: ReceiptRow[] }>(
      `SELECT o.*, COALESCE((SELECT jsonb_agg(r ORDER BY r.recorded_at,r.receipt_id)
        FROM economy_receipts r WHERE r.order_id=o.order_id),'[]'::jsonb) AS receipts
       FROM economy_orders o WHERE o.user_id=$1
       AND ($2::timestamptz IS NULL OR (o.created_at,o.order_id) < ($2::timestamptz,$3::uuid))
       ORDER BY o.created_at DESC,o.order_id DESC LIMIT $4`,
      [userId, before?.[0] ?? null, before?.[1] ?? null, limit + 1],
    );
    const page = result.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      orders: page.map((row) => this.response(row, row.receipts)),
      nextCursor:
        result.rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.created_at.toISOString(), last.order_id])).toString(
              'base64url',
            )
          : null,
    };
  }

  /** Snapshot offer terms once, under a durable per-player idempotency key. */
  async create(
    userId: string,
    offerId: string,
    walletLinkId: string,
    key: string,
  ): Promise<EconomyOrder> {
    const orderId = await this.transaction(async (db) => {
      // Serializes a player's orders, including distinct keys for the same item.
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
      const previous = await db.query<OrderRow>(
        'SELECT * FROM economy_orders WHERE user_id=$1 AND idempotency_key=$2',
        [userId, key],
      );
      if (previous.rows[0]) {
        const old = previous.rows[0];
        if (old.offer_id !== offerId || old.wallet_link_id !== walletLinkId) {
          throw new EconomyConflict('idempotency_body_mismatch');
        }
        return old.order_id;
      }
      // Lock the proof against concurrent unlink while the quote is created.
      // Reuse the transaction connection; borrowing another can exhaust the pool.
      const link = await db.query<{ network: string; address: string }>(
        `SELECT network,address FROM economy_wallet_links WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE`,
        [walletLinkId, userId],
      );
      if (!link.rowCount) throw new NotFoundError();
      const wallet = link.rows[0]!;
      const result = await db.query<OfferRow>(
        `SELECT o.* FROM economy_offers o JOIN cosmetic_items i USING(item_id)
         WHERE o.offer_id=$1 AND o.active AND NOT i.grant_only AND NOT i.onchain_only FOR SHARE OF o,i`,
        [offerId],
      );
      const offer = result.rows[0];
      if (!offer) throw new NotFoundError();
      const asset = economyAsset(offer.chain_id, offer.asset_id, offer.amount);
      if (wallet.network !== asset.chainId) throw new EconomyConflict('wallet_network_mismatch');
      if (wallet.address === offer.recipient) throw new EconomyConflict('payer_is_recipient');
      const id = randomUUID();
      const now = Date.now();
      validatePaymentExpectation({
        chainId: asset.chainId,
        assetId: asset.assetId,
        amountBaseUnits: offer.amount,
        payer: wallet.address,
        recipient: offer.recipient,
        reference: id,
        notBeforeMs: Math.floor(now / 1000) * 1000,
        notAfterMs: now + 15 * 60_000,
      });
      const owned = await db.query(
        'SELECT 1 FROM cosmetic_inventory WHERE user_id=$1 AND item_id=$2',
        [userId, offer.item_id],
      );
      if (owned.rowCount) throw new EconomyConflict('item_already_owned');
      await db.query(
        `UPDATE economy_orders SET status='expired'
        WHERE user_id=$1 AND status='awaiting_payment' AND expires_at <= now()`,
        [userId],
      );
      const open = await db.query(
        `SELECT 1 FROM economy_orders WHERE user_id=$1 AND item_id=$2
        AND status IN ('awaiting_payment','paid')`,
        [userId, offer.item_id],
      );
      if (open.rowCount) throw new EconomyConflict('purchase_already_in_progress');
      await db.query(
        `INSERT INTO economy_orders
        (order_id,user_id,wallet_link_id,offer_id,idempotency_key,chain_id,asset_id,amount,payer,recipient,
         terms_version,item_id,status,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'awaiting_payment',$13,$14)`,
        [
          id,
          userId,
          walletLinkId,
          offerId,
          key,
          offer.chain_id,
          offer.asset_id,
          offer.amount,
          wallet.address,
          offer.recipient,
          offer.terms_version,
          offer.item_id,
          new Date(now),
          new Date(now + 15 * 60_000),
        ],
      );
      return id;
    });
    return this.snapshot(userId, orderId);
  }

  private async row(
    userId: string,
    orderId: string,
    db: Pick<Pool, 'query'> = this.ctx.db.pool,
    lock = false,
  ): Promise<OrderRow> {
    const result = await db.query<OrderRow>(
      `SELECT * FROM economy_orders WHERE order_id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [orderId, userId],
    );
    const order = result.rows[0];
    if (!order) throw new NotFoundError();
    return order;
  }

  private expectation(order: OrderRow, refund: boolean, upper = Date.now()): PaymentExpectation {
    const asset = economyAsset(order.chain_id, order.asset_id, order.amount);
    return {
      chainId: asset.chainId,
      assetId: asset.assetId,
      amountBaseUnits: order.amount,
      payer: refund ? order.recipient : order.payer,
      recipient: refund ? order.payer : order.recipient,
      reference: refund ? `refund:${order.order_id}` : order.order_id,
      notBeforeMs: Math.floor(order.created_at.getTime() / 1000) * 1000,
      notAfterMs: upper,
    };
  }

  /** Read only this player's quote and its persisted receipt obligations. */
  async snapshot(userId: string, orderId: string): Promise<EconomyOrder> {
    return this.transaction(async (db) => {
      const order = await this.row(userId, orderId, db, true);
      const { rows } = await db.query<ReceiptRow>(
        'SELECT * FROM economy_receipts WHERE order_id=$1 ORDER BY recorded_at,receipt_id',
        [orderId],
      );
      return this.response(order, rows);
    });
  }

  private response(order: OrderRow, rows: ReceiptRow[]): EconomyOrder {
    return {
      orderId: order.order_id,
      offerId: order.offer_id,
      userId: order.user_id,
      walletLinkId: order.wallet_link_id,
      asset: economyAsset(order.chain_id, order.asset_id, order.amount),
      payer: order.payer,
      recipient: order.recipient,
      amount: order.amount,
      termsVersion: order.terms_version,
      fulfilment: { kind: 'cosmetic', itemId: order.item_id },
      status:
        order.status === 'awaiting_payment' && order.expires_at.getTime() <= Date.now()
          ? 'expired'
          : order.status,
      createdAt: order.created_at.toISOString(),
      expiresAt: order.expires_at.toISOString(),
      paymentTransactionId: rows.find((r) => r.kind === 'payment')?.transaction_id,
      refundTransactionId: rows.find((r) => r.kind === 'refund')?.transaction_id,
      refundDueReceiptIds: rows
        .filter((r) => r.disposition === 'refund_due')
        .map((r) => r.receipt_id),
      paymentReceipts: rows
        .filter((r) => r.kind === 'payment')
        .map((r) => ({
          receiptId: r.receipt_id,
          transactionId: r.transaction_id,
          disposition: r.disposition,
        })),
    };
  }

  /** Reconcile one pending attempt per poll; never prompt or broadcast a payment. */
  async get(userId: string, orderId: string): Promise<EconomyOrder> {
    await this.row(userId, orderId);
    const { rows } = await this.ctx.db.pool.query<{
      transaction_id: string;
      kind: 'payment' | 'refund';
    }>(
      `SELECT transaction_id,kind FROM economy_payment_attempts WHERE order_id=$1 AND state='pending' ORDER BY last_checked_at,submitted_at LIMIT 1`,
      [orderId],
    );
    for (const attempt of rows) {
      try {
        await this.record(userId, orderId, attempt.transaction_id, attempt.kind);
      } catch (error) {
        if (!(error instanceof DomainError) || error.httpStatus >= 500) throw error;
        // A rejected hash must not permanently poison recovery of a valid attempt.
        await this.rejectAttempt(orderId, attempt.transaction_id, attempt.kind);
      }
    }
    return this.snapshot(userId, orderId);
  }

  /** Return a narrow unsigned transfer for a still-payable quote. */
  async prepare(userId: string, orderId: string): Promise<PreparedPayment> {
    const order = await this.row(userId, orderId);
    if (order.status !== 'awaiting_payment' || order.expires_at.getTime() <= Date.now()) {
      throw new EconomyConflict('order_not_payable');
    }
    await getVerifiedWalletLink(this.ctx, userId, order.wallet_link_id);
    return this.chain.preparePayment(this.expectation(order, false, order.expires_at.getTime()));
  }

  /** Cancel delivery eligibility; a subsequently discovered payment remains owed. */
  async cancel(userId: string, orderId: string): Promise<EconomyOrder> {
    await this.transaction(async (db) => {
      const order = await this.row(userId, orderId, db, true);
      if (['cancelled', 'refund_due', 'refunded'].includes(order.status)) return;
      if (!['awaiting_payment', 'expired'].includes(order.status))
        throw new EconomyConflict('order_not_cancellable');
      await db.query(`UPDATE economy_orders SET status='cancelled' WHERE order_id=$1`, [orderId]);
    });
    return this.snapshot(userId, orderId);
  }

  /** Persist the hash before verification, then atomically claim and deliver/refund. */
  async record(
    userId: string,
    orderId: string,
    transactionId: string,
    kind: 'payment' | 'refund' = 'payment',
  ): Promise<EconomyOrder> {
    const order = await this.row(userId, orderId);
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(transactionId))
      throw new ValidationFailedError({ reason: 'invalid_transaction_id' });
    await this.transaction(async (db) => {
      await this.row(userId, orderId, db, true);
      const count = await db.query<{ n: number }>(
        `SELECT count(*)::int n FROM economy_payment_attempts WHERE order_id=$1 AND state='pending'`,
        [orderId],
      );
      const existing = await db.query(
        'SELECT 1 FROM economy_payment_attempts WHERE order_id=$1 AND transaction_id=$2 AND kind=$3',
        [orderId, transactionId, kind],
      );
      if (!existing.rowCount && count.rows[0]!.n >= 16)
        throw new EconomyConflict('too_many_pending_transactions');
      await db.query(
        `INSERT INTO economy_payment_attempts(order_id,transaction_id,kind) VALUES($1,$2,$3)
        ON CONFLICT(order_id,transaction_id,kind) DO UPDATE SET last_checked_at=now()`,
        [orderId, transactionId, kind],
      );
    });
    // Accept late incoming money as a refund liability; never grant an expired quote.
    const expected = this.expectation(order, kind === 'refund');
    const result = await this.chain.verifyPayment(expected, transactionId);
    if (result.state === 'pending') return this.snapshot(userId, orderId);
    if (result.state === 'rejected') {
      await this.rejectAttempt(orderId, transactionId, kind);
      throw new ValidationFailedError({ reason: result.reason });
    }
    const evidence = result.evidence;
    if (
      evidence.chainId !== expected.chainId ||
      evidence.assetId !== expected.assetId ||
      evidence.payer !== expected.payer ||
      evidence.recipient !== expected.recipient ||
      evidence.amountBaseUnits !== expected.amountBaseUnits ||
      evidence.transactionId !== transactionId ||
      evidence.blockTimestampMs < expected.notBeforeMs ||
      evidence.blockTimestampMs > expected.notAfterMs ||
      (expected.chainId === 'solana:mainnet' && evidence.reference !== expected.reference)
    ) {
      throw new ValidationFailedError({ reason: 'receipt_expectation_mismatch' });
    }
    await this.transaction(async (db) => {
      const current = await this.row(userId, orderId, db, true);
      const duplicate = await db.query<ReceiptRow>(
        'SELECT * FROM economy_receipts WHERE chain_id=$1 AND event_id=$2',
        [evidence.chainId, evidence.eventId],
      );
      if (duplicate.rows[0]) {
        if (duplicate.rows[0].order_id !== orderId || duplicate.rows[0].kind !== kind)
          throw new EconomyConflict('receipt_already_used');
      } else if (kind === 'refund') {
        const due = await db.query<ReceiptRow>(
          `SELECT * FROM economy_receipts WHERE order_id=$1 AND disposition='refund_due' ORDER BY recorded_at,receipt_id LIMIT 1 FOR UPDATE`,
          [orderId],
        );
        const payment = due.rows[0];
        if (!payment) throw new EconomyConflict('no_refund_due');
        if (evidence.blockTimestampMs < payment.evidence.blockTimestampMs)
          throw new EconomyConflict('refund_predates_payment');
        await this.insertReceipt(db, orderId, evidence, 'refund', 'refund', payment.receipt_id);
        await db.query(`UPDATE economy_receipts SET disposition='refunded' WHERE receipt_id=$1`, [
          payment.receipt_id,
        ]);
        const remaining = await db.query(
          `SELECT 1 FROM economy_receipts WHERE order_id=$1 AND disposition='refund_due'`,
          [orderId],
        );
        if (!remaining.rowCount && current.status !== 'fulfilled') {
          await db.query(`UPDATE economy_orders SET status='refunded' WHERE order_id=$1`, [
            orderId,
          ]);
        }
      } else {
        const timely = evidence.blockTimestampMs <= current.expires_at.getTime();
        const eligible = timely && ['awaiting_payment', 'expired'].includes(current.status);
        const receiptId = await this.insertReceipt(
          db,
          orderId,
          evidence,
          'payment',
          eligible ? 'applied' : 'refund_due',
        );
        let delivered = false;
        if (eligible) {
          // 'shop' means a purchased wearable. It never grants NFT mint eligibility.
          const grant = await db.query(
            `INSERT INTO cosmetic_inventory(inventory_id,user_id,item_id,source)
            SELECT $1,$2,item_id,'shop' FROM cosmetic_items WHERE item_id=$3 AND NOT grant_only AND NOT onchain_only
            ON CONFLICT(user_id,item_id) DO NOTHING RETURNING inventory_id`,
            [randomUUID(), userId, current.item_id],
          );
          delivered = !!grant.rowCount;
        }
        if (!delivered)
          await db.query(
            `UPDATE economy_receipts SET disposition='refund_due' WHERE receipt_id=$1`,
            [receiptId],
          );
        if (current.status !== 'fulfilled') {
          await db.query('UPDATE economy_orders SET status=$2 WHERE order_id=$1', [
            orderId,
            delivered ? 'fulfilled' : 'refund_due',
          ]);
        }
      }
      await db.query(
        `UPDATE economy_payment_attempts SET state='verified' WHERE order_id=$1 AND transaction_id=$2 AND kind=$3`,
        [orderId, transactionId, kind],
      );
    });
    return this.snapshot(userId, orderId);
  }

  private async insertReceipt(
    db: PoolClient,
    orderId: string,
    evidence: PaymentEvidence,
    kind: 'payment' | 'refund',
    disposition: string,
    refundsId: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    const result = await db.query(
      `INSERT INTO economy_receipts
      (receipt_id,order_id,chain_id,event_id,transaction_id,kind,disposition,refunds_receipt_id,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(chain_id,event_id) DO NOTHING RETURNING receipt_id`,
      [
        id,
        orderId,
        evidence.chainId,
        evidence.eventId,
        evidence.transactionId,
        kind,
        disposition,
        refundsId,
        JSON.stringify(evidence),
      ],
    );
    if (!result.rowCount) throw new EconomyConflict('receipt_already_used');
    return id;
  }

  private async rejectAttempt(orderId: string, transactionId: string, kind: string): Promise<void> {
    await this.ctx.db.pool.query(
      `UPDATE economy_payment_attempts SET state='rejected'
      WHERE order_id=$1 AND transaction_id=$2 AND kind=$3 AND state='pending'`,
      [orderId, transactionId, kind],
    );
  }
}
