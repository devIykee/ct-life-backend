/**
 * Real Markets reconciliation: find the transaction of an order whose signature the app
 * never reported (it was killed after MWA `sign_and_send_transactions` broadcast, before
 * `POST /order/submitted`).
 *
 * How it works, on demand (`GET /orders`, and `GET /orders/{id}` for a built order):
 *
 *   1. Load the player's unsigned (`built`) orders of the last RECONCILE_WINDOW_MS that
 *      carry instruction fingerprints. None -> no RPC call at all.
 *   2. Per wallet, `getSignaturesForAddress(wallet, {limit: SIGNATURE_PAGE})` on the
 *      isolated Real Markets mainnet RPC, after the mainnet genesis check.
 *   3. Skip signatures already attached to an order, without a block time, or older than
 *      the oldest pending order. Fetch at most MAX_TX_FETCH transactions.
 *   4. A landed transaction matches an order when its fee payer is the order's wallet,
 *      it contains EVERY instruction fingerprint of the built transaction (programId plus
 *      exact data; wallets may add compute-budget or guard instructions), and its block
 *      time falls inside the order's life. If two orders match (two identical builds), the
 *      one with the same recent blockhash wins, else the newest one built before it landed.
 *   5. Attach the signature (`built -> submitted`, conditional, unique signature), tell
 *      the venue, then run the normal verification (real-markets-orders.ts `refresh`),
 *      which alone decides `confirmed` or `failed`.
 *
 * Safety: only signatures the RPC returned as landed at `confirmed` commitment are ever
 * attached, and confirmation still goes through `verifyOrderSignature`. An order whose
 * transaction is not found stays `built` (shown `expired` once past `expiresAt`); nothing
 * here marks a trade that did not land. The built transaction is not changed (no memo is
 * added): Panta's and Jupiter's instructions are signed exactly as the venue built them.
 *
 * Cost bounds: one reconcile per player per RECONCILE_THROTTLE_SEC (Redis NX key), and a
 * deployment-wide token bucket on the reconcile RPC calls (RPC_BUCKET), so a crowd of
 * polling clients cannot exhaust the Real Markets RPC. Any failure is logged and skipped:
 * reconciliation never fails the request that triggered it.
 */
import { VersionedTransaction } from '@solana/web3.js';
import type { AppContext } from './context.js';
import { createLogger } from '../shared/logger/logger.js';
import { perUserTokenBucket } from '../shared/infra/rate-limit.js';
import { assertMainnetRpc, realMarketsRpc } from './real-markets-chain.js';
import { txFingerprints } from '../shared/real-markets/tx.js';
import { providerFor } from './real-markets-providers.js';
import { isCapabilityOn } from './capabilities.js';
import {
  bestEffort,
  refresh,
  submittedInput,
  transition,
  type OrderRow,
} from './real-markets-orders.js';

/** Unsigned orders older than this are not looked for. */
export const RECONCILE_WINDOW_MS = 24 * 3600 * 1000;
/** One reconcile per player per this many seconds. */
export const RECONCILE_THROTTLE_SEC = 20;
/** Signatures read per wallet per reconcile (newest first). */
export const SIGNATURE_PAGE = 25;
/** Transactions fetched per reconcile. */
export const MAX_TX_FETCH = 8;
/** Unsigned orders considered per reconcile. */
const MAX_ORDERS = 20;
/** Deployment-wide bucket for reconcile RPC calls: burst 120, 2 per second. */
const RPC_BUCKET = { key: 'rl:rm:reconcile-rpc', capacity: 120, perSec: 2 };
/** Clock slack around an order's life when comparing block times (seconds). */
const BEFORE_SLACK_SEC = 30;
const AFTER_SLACK_SEC = 150;

interface SignatureInfo {
  readonly signature: string;
  readonly blockTime?: number | null;
  readonly err?: unknown;
}

interface Base64Tx {
  readonly blockTime?: number | null;
  readonly transaction?: readonly [string, string] | null;
}

/** A landed transaction, reduced to what matching needs. */
export interface LandedTx {
  readonly signature: string;
  readonly feePayer: string;
  readonly recentBlockhash: string;
  readonly fingerprints: ReadonlySet<string>;
  /** Unix seconds. */
  readonly blockTime: number;
}

/**
 * Pick the order a landed transaction belongs to (pure).
 *
 * @param tx - The landed transaction.
 * @param orders - Unsigned orders of the transaction's wallet.
 * @returns The matching order, or null.
 */
export function matchOrder(tx: LandedTx, orders: readonly OrderRow[]): OrderRow | null {
  const t = tx.blockTime * 1000;
  const fits = orders.filter(
    (o) =>
      o.wallet === tx.feePayer &&
      o.ix_fingerprints.length > 0 &&
      o.ix_fingerprints.every((f) => tx.fingerprints.has(f)) &&
      t >= o.created_at.getTime() - BEFORE_SLACK_SEC * 1000 &&
      t <= o.expires_at.getTime() + AFTER_SLACK_SEC * 1000,
  );
  if (fits.length <= 1) return fits[0] ?? null;
  const sameHash = fits.find((o) => o.recent_blockhash === tx.recentBlockhash);
  if (sameHash) return sameHash;
  return [...fits].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null;
}

/**
 * Spend one call from the deployment-wide reconcile RPC budget.
 * @param ctx - The app context.
 * @returns False when the budget is empty (stop for now).
 */
async function spend(ctx: Pick<AppContext, 'redis'>): Promise<boolean> {
  const d = await perUserTokenBucket(
    ctx.redis.main,
    RPC_BUCKET.key,
    RPC_BUCKET.capacity,
    RPC_BUCKET.perSec,
    1,
  );
  return d.allowed;
}

async function pendingOrders(
  ctx: Pick<AppContext, 'db'>,
  userId: string,
  now: Date,
): Promise<OrderRow[]> {
  const r = await ctx.db.withConnection((c) =>
    c.query<OrderRow>(
      `SELECT * FROM real_market_orders
        WHERE user_id = $1 AND status = 'built' AND signature IS NULL
          AND created_at > $2 AND cardinality(ix_fingerprints) > 0
        ORDER BY created_at DESC LIMIT $3`,
      [userId, new Date(now.getTime() - RECONCILE_WINDOW_MS), MAX_ORDERS],
    ),
  );
  return r.rows;
}

async function knownSignatures(
  ctx: Pick<AppContext, 'db'>,
  signatures: readonly string[],
): Promise<Set<string>> {
  if (signatures.length === 0) return new Set();
  const r = await ctx.db.withConnection((c) =>
    c.query<{ signature: string }>(
      `SELECT signature FROM real_market_orders WHERE signature = ANY($1::text[])`,
      [signatures],
    ),
  );
  return new Set(r.rows.map((x) => x.signature));
}

/**
 * @param ctx - The app context.
 * @param signature - A signature the RPC listed as landed.
 * @returns The decoded transaction, or null when it cannot be read.
 */
async function loadLanded(
  ctx: Pick<AppContext, 'config'>,
  signature: string,
): Promise<LandedTx | null> {
  const r = await realMarketsRpc(ctx).rpc<Base64Tx | null>('getTransaction', [
    signature,
    { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]);
  const raw = r?.transaction?.[0];
  if (!r || typeof raw !== 'string' || typeof r.blockTime !== 'number') return null;
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(raw, 'base64'));
  } catch {
    return null;
  }
  const payer = tx.message.staticAccountKeys[0]?.toBase58();
  if (!payer) return null;
  return {
    signature,
    feePayer: payer,
    recentBlockhash: tx.message.recentBlockhash,
    fingerprints: new Set(txFingerprints(tx)),
    blockTime: r.blockTime,
  };
}

/**
 * Attach a found signature to its order and run the normal verification.
 * @returns True when this call attached it.
 */
async function attach(ctx: AppContext, order: OrderRow, signature: string): Promise<boolean> {
  let row: OrderRow | null;
  try {
    row = await transition(
      ctx,
      order.order_id,
      'built',
      `status = 'submitted', signature = $3, submitted_at = now(), reconciled_at = now()`,
      [signature],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return false; // signature already used
    throw e;
  }
  if (!row) return false; // the client reported it meanwhile
  const u = row;
  await bestEffort('submit (reconciled)', u, () =>
    providerFor(ctx, u.provider).notifySubmitted(submittedInput(u)),
  );
  await refresh(ctx, u);
  return true;
}

async function reconcileWallet(
  ctx: AppContext,
  wallet: string,
  orders: OrderRow[],
  budget: { tx: number },
): Promise<number> {
  if (!(await spend(ctx))) return 0;
  const listed = await realMarketsRpc(ctx).rpc<SignatureInfo[] | null>('getSignaturesForAddress', [
    wallet,
    { limit: SIGNATURE_PAGE, commitment: 'confirmed' },
  ]);
  const sigs = Array.isArray(listed) ? listed : [];
  const oldest = Math.min(...orders.map((o) => o.created_at.getTime()));
  const known = await knownSignatures(
    ctx,
    sigs.map((s) => s.signature),
  );
  const candidates = sigs.filter(
    (s) =>
      typeof s.blockTime === 'number' &&
      s.blockTime * 1000 >= oldest - BEFORE_SLACK_SEC * 1000 &&
      !known.has(s.signature),
  );
  let attached = 0;
  const open = [...orders];
  for (const s of candidates) {
    if (open.length === 0 || budget.tx <= 0) break;
    if (!(await spend(ctx))) break;
    budget.tx--;
    const landed = await loadLanded(ctx, s.signature);
    if (!landed) continue;
    const order = matchOrder(landed, open);
    if (!order) continue;
    if (await attach(ctx, order, landed.signature)) attached++;
    open.splice(open.indexOf(order), 1);
  }
  return attached;
}

/**
 * Look for the transactions of the caller's unsigned orders on chain and attach them.
 * Throttled per player, bounded per call, never throws.
 *
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param now - Injectable clock.
 * @returns How many orders were attached.
 */
export async function reconcileUnsignedOrders(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  try {
    if (!isCapabilityOn(ctx, 'realMarkets')) return 0;
    const orders = await pendingOrders(ctx, userId, now);
    if (orders.length === 0) return 0;
    const first = await ctx.redis.main.set(
      `rm:reconcile:${userId}`,
      '1',
      'EX',
      RECONCILE_THROTTLE_SEC,
      'NX',
    );
    if (first === null) return 0;
    await assertMainnetRpc(ctx);
    const byWallet = new Map<string, OrderRow[]>();
    for (const o of orders) byWallet.set(o.wallet, [...(byWallet.get(o.wallet) ?? []), o]);
    const budget = { tx: MAX_TX_FETCH };
    let attached = 0;
    for (const [wallet, list] of byWallet) {
      attached += await reconcileWallet(ctx, wallet, list, budget);
    }
    return attached;
  } catch (e) {
    createLogger().warn(
      { userId, err: (e as { code?: string }).code ?? (e as Error).name },
      'real markets: reconcile skipped',
    );
    return 0;
  }
}
