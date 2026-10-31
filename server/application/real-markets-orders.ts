/**
 * Real Markets orders after build: the client reports the signature its wallet got from
 * MWA `sign_and_send_transactions`; the server records it and verifies it on MAINNET
 * (real-markets-chain.ts) — fee payer is the order's wallet, every built program was
 * invoked, no on-chain error — then tells the venue (Panta submit + attribution).
 * Records exist for the player's history and anti-abuse; they move no money.
 *
 *   built -> submitted -> confirmed | failed | mismatch
 *
 * Verification is lazy: `POST .../submitted` checks once, `GET .../orders/{id}` checks
 * again while the order is `submitted` (the client polls). Each transition is a
 * conditional UPDATE, so venue notifications fire once even under concurrent polls.
 *
 * Over the 300-line soft limit: the order state machine, its view and the positions
 * valuation read the same row type and are clearer together.
 */
import type { AppContext } from './context.js';
import { createLogger } from '../shared/logger/logger.js';
import { providerFor } from './real-markets-providers.js';
import { passGate, type RequestGeo } from './real-markets-gate.js';
import { verifyOrderSignature } from './real-markets-chain.js';
import { marketDetail, rateLimit } from './real-markets.js';
import { assertProviderOn } from './real-markets-providers.js';
import { NotFoundError, RealMarketsTxMismatchError } from '../shared/domain/errors.js';
import {
  ATTRIBUTION,
  baseToUsdc,
  type ProviderOrderState,
  type RealMarketProviderId,
  type RealPosition,
  type SubmittedInput,
} from '../shared/domain/real-markets.js';

interface OrderRow {
  order_id: string;
  user_id: string;
  wallet: string;
  provider: RealMarketProviderId;
  market_id: string;
  side: 'yes' | 'no';
  amount_base: string;
  est_shares: string | null;
  fee_usdc: string | null;
  provider_order_id: string | null;
  provider_quote_id: string | null;
  program_ids: string[];
  last_valid_block_height: string | null;
  status: 'built' | 'submitted' | 'confirmed' | 'failed' | 'mismatch';
  provider_state: ProviderOrderState | null;
  signature: string | null;
  error: string | null;
  created_at: Date;
  expires_at: Date;
  submitted_at: Date | null;
  confirmed_at: Date | null;
}

export interface OrderView {
  readonly orderId: string;
  readonly provider: RealMarketProviderId;
  readonly marketId: string;
  readonly side: 'yes' | 'no';
  readonly amountUsdc: string;
  readonly wallet: string;
  /** built | submitted | confirmed | failed | mismatch; `expired` = built and past expiresAt. */
  readonly status: string;
  readonly providerState: ProviderOrderState | null;
  readonly signature: string | null;
  readonly error: string | null;
  readonly estShares: string | null;
  readonly feeUsdc: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly submittedAt: string | null;
  readonly confirmedAt: string | null;
  readonly explorerUrl: string | null;
}

function view(r: OrderRow, now: Date): OrderView {
  const expired = r.status === 'built' && r.expires_at.getTime() < now.getTime();
  return {
    orderId: r.order_id,
    provider: r.provider,
    marketId: r.market_id,
    side: r.side,
    amountUsdc: baseToUsdc(BigInt(r.amount_base)),
    wallet: r.wallet,
    status: expired ? 'expired' : r.status,
    providerState: r.provider_state,
    signature: r.signature,
    error: r.error,
    estShares: r.est_shares,
    feeUsdc: r.fee_usdc,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    submittedAt: r.submitted_at?.toISOString() ?? null,
    confirmedAt: r.confirmed_at?.toISOString() ?? null,
    explorerUrl: r.signature ? `https://solscan.io/tx/${r.signature}` : null,
  };
}

async function loadOrder(
  ctx: Pick<AppContext, 'db'>,
  userId: string,
  orderId: string,
): Promise<OrderRow> {
  const r = await ctx.db.withConnection((c) =>
    c.query<OrderRow>(`SELECT * FROM real_market_orders WHERE order_id = $1 AND user_id = $2`, [
      orderId,
      userId,
    ]),
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ kind: 'real_market_order', id: orderId });
  return row;
}

function submittedInput(r: OrderRow): SubmittedInput {
  return {
    providerOrderId: r.provider_order_id,
    providerQuoteId: r.provider_quote_id,
    signature: r.signature ?? '',
    wallet: r.wallet,
    marketId: r.market_id,
  };
}

/** Run a venue call that must not fail the request; log without secrets. */
async function bestEffort<T>(what: string, r: OrderRow, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    createLogger().warn(
      {
        provider: r.provider,
        orderId: r.order_id,
        err: (e as { code?: string }).code ?? (e as Error).name,
      },
      `real markets: ${what} failed`,
    );
    return null;
  }
}

async function transition(
  ctx: Pick<AppContext, 'db'>,
  orderId: string,
  from: OrderRow['status'],
  set: string,
  params: unknown[],
): Promise<OrderRow | null> {
  const r = await ctx.db.withConnection((c) =>
    c.query<OrderRow>(
      `UPDATE real_market_orders SET ${set}, updated_at = now()
        WHERE order_id = $1 AND status = $2 RETURNING *`,
      [orderId, from, ...params],
    ),
  );
  return r.rows[0] ?? null;
}

/**
 * Advance a submitted order from chain, and a confirmed one from the venue.
 * @param ctx - The app context.
 * @param row - The order.
 * @returns The order as it is now.
 */
async function refresh(ctx: AppContext, row: OrderRow): Promise<OrderRow> {
  let r = row;
  if (r.status === 'submitted' && r.signature) {
    const v = await verifyOrderSignature(ctx, {
      signature: r.signature,
      wallet: r.wallet,
      programIds: r.program_ids,
      lastValidBlockHeight:
        r.last_valid_block_height === null ? null : Number(r.last_valid_block_height),
    });
    let next: OrderRow | null = null;
    if (v.kind === 'confirmed') {
      next = await transition(
        ctx,
        r.order_id,
        'submitted',
        `status = 'confirmed', confirmed_at = now()`,
        [],
      );
      if (next) {
        const won = next;
        await bestEffort('attribution report', won, () =>
          providerFor(ctx, won.provider).notifyConfirmed(submittedInput(won)),
        );
      }
    } else if (v.kind === 'failed' || v.kind === 'expired') {
      next = await transition(ctx, r.order_id, 'submitted', `status = 'failed', error = $3`, [
        v.kind === 'expired' ? 'expired' : `chain_error: ${v.error.slice(0, 200)}`,
      ]);
    } else if (v.kind === 'mismatch') {
      next = await transition(ctx, r.order_id, 'submitted', `status = 'mismatch', error = $3`, [
        `tx_mismatch: ${v.reason}`,
      ]);
    }
    r = next ?? (await loadOrder(ctx, r.user_id, r.order_id));
  }
  if (
    r.status === 'confirmed' &&
    (r.provider_state === null || r.provider_state === 'pending' || r.provider_state === 'unknown')
  ) {
    const cur = r;
    const state = await bestEffort('order state', cur, () =>
      providerFor(ctx, cur.provider).orderState(submittedInput(cur)),
    );
    if (state !== null && state !== cur.provider_state) {
      r = (await transition(ctx, r.order_id, 'confirmed', `provider_state = $3`, [state])) ?? r;
    }
  }
  return r;
}

/**
 * Record the signature the wallet returned for an order and verify it.
 *
 * @param ctx - The app context.
 * @param userId - The caller (must own the order).
 * @param geo - The request location.
 * @param orderId - The order.
 * @param signature - Base58 transaction signature.
 * @param now - Injectable clock.
 */
export async function orderSubmitted(
  ctx: AppContext,
  userId: string,
  geo: RequestGeo,
  orderId: string,
  signature: string,
  now: Date = new Date(),
): Promise<OrderView> {
  let row = await loadOrder(ctx, userId, orderId);
  assertProviderOn(ctx, row.provider);
  await passGate(ctx, userId, geo);
  await rateLimit(ctx, userId, 'submit');
  if (row.signature !== null && row.signature !== signature) {
    throw new RealMarketsTxMismatchError({ reason: 'order_already_submitted' });
  }
  if (row.signature === null) {
    let updated: OrderRow | null;
    try {
      updated = await transition(
        ctx,
        orderId,
        'built',
        `status = 'submitted', signature = $3, submitted_at = now()`,
        [signature],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new RealMarketsTxMismatchError({ reason: 'signature_reused' });
      }
      throw e;
    }
    row = updated ?? (await loadOrder(ctx, userId, orderId));
    if (row.signature !== signature)
      throw new RealMarketsTxMismatchError({ reason: 'order_already_submitted' });
    if (updated) {
      const u = updated;
      await bestEffort('submit', u, () =>
        providerFor(ctx, u.provider).notifySubmitted(submittedInput(u)),
      );
    }
  }
  row = await refresh(ctx, row);
  if (row.status === 'mismatch') {
    throw new RealMarketsTxMismatchError({
      reason: row.error?.replace('tx_mismatch: ', '') ?? 'mismatch',
    });
  }
  return view(row, now);
}

/**
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param geo - The request location.
 * @param orderId - The order.
 * @param now - Injectable clock.
 */
export async function getOrder(
  ctx: AppContext,
  userId: string,
  geo: RequestGeo,
  orderId: string,
  now: Date = new Date(),
): Promise<OrderView> {
  const row = await loadOrder(ctx, userId, orderId);
  assertProviderOn(ctx, row.provider);
  await passGate(ctx, userId, geo);
  await rateLimit(ctx, userId, 'read');
  return view(await refresh(ctx, row), now);
}

/**
 * The caller's recent orders, newest first (no chain calls).
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param geo - The request location.
 * @param limit - Page size.
 * @param now - Injectable clock.
 */
export async function listOrders(
  ctx: AppContext,
  userId: string,
  geo: RequestGeo,
  limit: number,
  now: Date = new Date(),
): Promise<{ orders: OrderView[] }> {
  await passGate(ctx, userId, geo);
  await rateLimit(ctx, userId, 'read');
  const r = await ctx.db.withConnection((c) =>
    c.query<OrderRow>(
      `SELECT * FROM real_market_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    ),
  );
  return { orders: r.rows.map((row) => view(row, now)) };
}

/** Distinct markets whose price is fetched to value Panta positions. */
const MAX_PRICED_MARKETS = 20;

/**
 * Open positions of the caller's linked wallet at one venue.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param geo - The request location.
 * @param id - The provider.
 */
export async function positionsFor(
  ctx: AppContext,
  userId: string,
  geo: RequestGeo,
  id: RealMarketProviderId,
): Promise<Record<string, unknown>> {
  assertProviderOn(ctx, id);
  const gate = await passGate(ctx, userId, geo);
  await rateLimit(ctx, userId, 'read');
  const p = providerFor(ctx, id);
  let positions = await p.positions(gate.wallet);
  if (id === 'panta') positions = await valuePanta(ctx, positions);
  return {
    provider: id,
    wallet: gate.wallet,
    positions,
    asOf: new Date().toISOString(),
    attribution: ATTRIBUTION[id],
  };
}

/**
 * Panta returns shares only: value open ones at the side's spot price, resolved winners
 * at 1 USDC/share and losers at 0 (Panta "Estimating position value").
 */
async function valuePanta(ctx: AppContext, positions: RealPosition[]): Promise<RealPosition[]> {
  const ids = [...new Set(positions.map((p) => p.marketId))].slice(0, MAX_PRICED_MARKETS);
  const markets = new Map<string, { title: string; yes: string | null; no: string | null }>();
  await Promise.all(
    ids.map(async (mid) => {
      try {
        const m = (await marketDetail(ctx, 'panta', mid)).data;
        markets.set(mid, { title: m.title, yes: m.yesPrice, no: m.noPrice });
      } catch {
        // Leave unpriced; the share count is still right.
      }
    }),
  );
  return positions.map((p) => {
    const m = markets.get(p.marketId);
    let est: string | null = null;
    const shares = Number(p.shares);
    if (p.outcome !== null) est = p.outcome === p.side ? shares.toFixed(2) : '0.00';
    else {
      const price = Number(p.side === 'yes' ? m?.yes : m?.no);
      if (m && Number.isFinite(price) && Number.isFinite(shares)) est = (shares * price).toFixed(2);
    }
    return { ...p, title: m?.title ?? p.title, estValueUsdc: est };
  });
}
