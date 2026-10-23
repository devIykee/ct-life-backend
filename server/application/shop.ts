/**
 * Duo Shop: Cash goods and furniture, ordered on the phone and delivered
 * to the doorstep (or a lobby locker) at a scheduled time.
 *
 *   GET  /v1/shop/catalog?category=      — the catalogue
 *   POST /v1/shop/orders                 — place an order; debits Cash
 *   GET  /v1/shop/orders                 — my orders
 *   GET  /v1/shop/orders/{id}            — one of my orders
 *   POST /v1/shop/orders/{id}/cancel     — cancel while `placed`; full refund
 *
 * The catalogue is the FE-owned `contract/ids/shop_items.json`, upserted
 * into `shop_items`. Prices always come from there: the client sends item
 * ids and quantities, never an amount.
 *
 * An order moves `placed -> out_for_delivery -> delivered` (the delivery
 * worker, `server/workers/shop-delivery.ts`) or `placed -> cancelled`.
 * Items are bought with game Cash and are off-chain: when delivered they
 * become `player_items`, owned by the player and never tradable.
 *
 * Windows: asap is about 10 minutes, then 30 and 60. They are real time and
 * cost nothing extra; nothing, least of all real money, shortens the wait.
 * The lobby locker costs a flat Cash fee; the door needs a home with a door.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Db } from '../shared/db/pool.js';
import { runInTransaction } from '../shared/db/uow.js';
import {
  InsufficientCashError,
  NoHomeDoorError,
  NotFoundError,
  OrderNotCancellableError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import { scheduleShopDelivery, unscheduleShopDelivery } from './shop-queue.js';

export type ShopCategory = 'furniture' | 'decor' | 'appliance' | 'food' | 'clothing';
export type ShopWindow = 'asap' | '30m' | '1h';
export type ShopDestination = 'door' | 'locker';
export type ShopOrderStatus = 'placed' | 'out_for_delivery' | 'delivered' | 'cancelled';

export const SHOP_CATEGORIES: readonly ShopCategory[] = [
  'furniture',
  'decor',
  'appliance',
  'food',
  'clothing',
];

/** Minutes from the order to the ETA. [Inference: tuning values] */
export const WINDOW_MINUTES: Record<ShopWindow, number> = { asap: 10, '30m': 30, '1h': 60 };

/** The courier leaves this long before the ETA, so the client can spawn the van. */
export const OUT_LEAD_MS = 60_000;

/** Cash fee for the lobby locker. [Inference: tuning value] */
export const LOCKER_FEE_CENTS = 300;

export const MAX_QTY_PER_LINE = 10;
export const MAX_LINES_PER_ORDER = 10;
export const MAX_UNITS_PER_ORDER = 20;
/** Orders in flight (placed or out for delivery) per player. */
export const MAX_OPEN_ORDERS = 5;

export interface Footprint {
  readonly w: number;
  readonly d: number;
  readonly h: number;
}

export interface ShopItem {
  readonly itemId: string;
  readonly category: ShopCategory;
  readonly name: string;
  readonly priceCents: number;
  readonly deliverable: boolean;
  readonly placeable: boolean;
  /** Metres; null for items that cannot be placed. */
  readonly footprint: Footprint | null;
  readonly modelKey: string;
}

export interface ShopCatalog {
  readonly items: ShopItem[];
  readonly lockerFeeCents: number;
  readonly windows: Array<{ id: ShopWindow; minutes: number }>;
}

export interface OrderLine {
  readonly itemId: string;
  readonly name: string;
  readonly qty: number;
  readonly unitPriceCents: number;
}

export interface ShopOrder {
  readonly orderId: string;
  readonly status: ShopOrderStatus;
  readonly window: ShopWindow;
  readonly destination: ShopDestination;
  /** The door the order goes to; null for a locker. */
  readonly unitId: string | null;
  readonly items: OrderLine[];
  readonly itemsCents: number;
  readonly feeCents: number;
  readonly totalCents: number;
  readonly placedAt: string;
  readonly etaAt: string;
  readonly deliveredAt: string | null;
  readonly cancelledAt: string | null;
}

export interface OrderInput {
  readonly items: ReadonlyArray<{ itemId: string; qty: number }>;
  readonly window: ShopWindow;
  readonly destination: ShopDestination;
}

interface ItemDbRow {
  item_id: string;
  category: ShopCategory;
  name: string;
  price_cents: string;
  deliverable: boolean;
  placeable: boolean;
  footprint_w: string | null;
  footprint_d: string | null;
  footprint_h: string | null;
  model_key: string;
}

interface OrderDbRow {
  order_id: string;
  user_id: string;
  status: ShopOrderStatus;
  delivery_window: ShopWindow;
  destination: ShopDestination;
  unit_id: string | null;
  items_cents: string;
  fee_cents: string;
  total_cents: string;
  placed_at: Date;
  out_at: Date;
  eta_at: Date;
  delivered_at: Date | null;
  cancelled_at: Date | null;
}

const ITEM_COLUMNS = `item_id, category, name, price_cents, deliverable, placeable,
       footprint_w, footprint_d, footprint_h, model_key`;

const CatalogFile = z.object({
  items: z.array(
    z.object({
      itemId: z.string().regex(/^[a-z0-9_]+$/),
      category: z.enum(['furniture', 'decor', 'appliance', 'food', 'clothing']),
      name: z.string().min(1),
      priceCents: z.number().int().positive(),
      deliverable: z.literal(true),
      placeable: z.boolean(),
      footprint: z.object({ w: z.number(), d: z.number(), h: z.number() }).optional(),
      modelKey: z.string().min(1),
    }),
  ),
});

let synced: Promise<number> | null = null;

/**
 * Upsert `contract/ids/shop_items.json` into `shop_items`, once per process.
 * @param db - The database handle.
 */
export async function ensureShopItemsSynced(db: Db): Promise<void> {
  synced ??= syncShopItems(db).catch((e: unknown) => {
    synced = null; // retry on the next call
    throw e;
  });
  await synced;
}

/**
 * Re-read the file on the next call (tests, and after the file changes).
 */
export function _resetShopSyncForTests(): void {
  synced = null;
}

/**
 * Upsert the catalogue file into `shop_items`. Items dropped from the file
 * stay in the table, because orders and owned items point at them, but
 * leave the catalogue (`active = false`).
 * @param db - The database handle.
 * @returns How many items the file lists.
 */
export async function syncShopItems(db: Db): Promise<number> {
  const raw: unknown = JSON.parse(
    readFileSync(join(process.cwd(), 'contract', 'ids', 'shop_items.json'), 'utf8'),
  );
  const file = CatalogFile.parse(raw);
  await db.withConnection(async (c) => {
    for (const i of file.items) {
      await c.query(
        `INSERT INTO shop_items
           (item_id, category, name, price_cents, deliverable, placeable,
            footprint_w, footprint_d, footprint_h, model_key, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
         ON CONFLICT (item_id) DO UPDATE
           SET category = EXCLUDED.category, name = EXCLUDED.name,
               price_cents = EXCLUDED.price_cents, deliverable = EXCLUDED.deliverable,
               placeable = EXCLUDED.placeable, footprint_w = EXCLUDED.footprint_w,
               footprint_d = EXCLUDED.footprint_d, footprint_h = EXCLUDED.footprint_h,
               model_key = EXCLUDED.model_key, active = true`,
        [
          i.itemId,
          i.category,
          i.name,
          i.priceCents,
          i.deliverable,
          i.placeable,
          i.footprint?.w ?? null,
          i.footprint?.d ?? null,
          i.footprint?.h ?? null,
          i.modelKey,
        ],
      );
    }
    await c.query(`UPDATE shop_items SET active = false WHERE item_id <> ALL($1::text[])`, [
      file.items.map((i) => i.itemId),
    ]);
  });
  return file.items.length;
}

/**
 * Map a `shop_items` row to the contract shape.
 * @param r - The row.
 */
export function toShopItem(r: ItemDbRow): ShopItem {
  return {
    itemId: r.item_id,
    category: r.category,
    name: r.name,
    priceCents: Number(r.price_cents),
    deliverable: r.deliverable,
    placeable: r.placeable,
    footprint:
      r.placeable && r.footprint_w !== null && r.footprint_d !== null && r.footprint_h !== null
        ? { w: Number(r.footprint_w), d: Number(r.footprint_d), h: Number(r.footprint_h) }
        : null,
    modelKey: r.model_key,
  };
}

/**
 * The catalogue, optionally one category, with the locker fee and windows.
 * @param ctx - The app context.
 * @param category - Filter, or null for everything.
 */
export async function listCatalog(
  ctx: AppContext,
  category: ShopCategory | null,
): Promise<ShopCatalog> {
  await ensureShopItemsSynced(ctx.db);
  const items = await ctx.db.withConnection(async (c) => {
    const r = await c.query<ItemDbRow>(
      `SELECT ${ITEM_COLUMNS} FROM shop_items
        WHERE active AND deliverable AND ($1::text IS NULL OR category = $1)
        ORDER BY category ASC, price_cents ASC, item_id ASC`,
      [category],
    );
    return r.rows.map(toShopItem);
  });
  return {
    items,
    lockerFeeCents: LOCKER_FEE_CENTS,
    windows: (Object.keys(WINDOW_MINUTES) as ShopWindow[]).map((id) => ({
      id,
      minutes: WINDOW_MINUTES[id],
    })),
  };
}

const ORDER_COLUMNS = `order_id, user_id, status, delivery_window, destination, unit_id, items_cents,
       fee_cents, total_cents, placed_at, out_at, eta_at, delivered_at, cancelled_at`;

async function loadLines(
  c: Pick<PoolClient, 'query'>,
  orderIds: string[],
): Promise<Map<string, OrderLine[]>> {
  const out = new Map<string, OrderLine[]>();
  if (orderIds.length === 0) return out;
  const r = await c.query<{
    order_id: string;
    item_id: string;
    name: string;
    qty: number;
    unit_price_cents: string;
  }>(
    `SELECT l.order_id, l.item_id, i.name, l.qty, l.unit_price_cents
       FROM shop_order_items l JOIN shop_items i ON i.item_id = l.item_id
      WHERE l.order_id = ANY($1::uuid[])
      ORDER BY l.item_id`,
    [orderIds],
  );
  for (const l of r.rows) {
    const list = out.get(l.order_id) ?? [];
    list.push({
      itemId: l.item_id,
      name: l.name,
      qty: l.qty,
      unitPriceCents: Number(l.unit_price_cents),
    });
    out.set(l.order_id, list);
  }
  return out;
}

function toOrder(r: OrderDbRow, lines: OrderLine[]): ShopOrder {
  return {
    orderId: r.order_id,
    status: r.status,
    window: r.delivery_window,
    destination: r.destination,
    unitId: r.destination === 'door' ? r.unit_id : null,
    items: lines,
    itemsCents: Number(r.items_cents),
    feeCents: Number(r.fee_cents),
    totalCents: Number(r.total_cents),
    placedAt: r.placed_at.toISOString(),
    etaAt: r.eta_at.toISOString(),
    deliveredAt: r.delivered_at ? r.delivered_at.toISOString() : null,
    cancelledAt: r.cancelled_at ? r.cancelled_at.toISOString() : null,
  };
}

async function orderById(
  c: Pick<PoolClient, 'query'>,
  orderId: string,
  userId: string,
): Promise<ShopOrder | null> {
  const r = await c.query<OrderDbRow>(
    `SELECT ${ORDER_COLUMNS} FROM shop_orders WHERE order_id = $1 AND user_id = $2`,
    [orderId, userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const lines = await loadLines(c, [orderId]);
  return toOrder(row, lines.get(orderId) ?? []);
}

/**
 * Place an order and pay for it, in one transaction.
 *
 * The amount is computed here from the catalogue (never from the client):
 * the sum of price times quantity, plus the locker fee for a locker. A
 * door needs a live home with a door (`NO_HOME_DOOR` otherwise).
 *
 * The Idempotency-Key is folded into the ledger's unique `idempotency_ref`,
 * so a replay that outlives the 24 h response cache still cannot charge
 * twice: it finds its own ledger row and returns that order.
 * @param ctx - The app context.
 * @param userId - The buyer.
 * @param input - The lines, window and destination.
 * @param idempotencyKey - The request's Idempotency-Key.
 * @param now - The current time (injectable for tests).
 */
export async function placeOrder(
  ctx: AppContext,
  userId: string,
  input: OrderInput,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<ShopOrder> {
  validateLines(input.items);
  await ensureShopItemsSynced(ctx.db);
  const ref = `shop-order:${userId}:${idempotencyKey}`;
  const orderId = uuidv7();
  const etaAt = new Date(now.getTime() + WINDOW_MINUTES[input.window] * 60_000);
  const outAt = new Date(etaAt.getTime() - OUT_LEAD_MS);

  const placed = await runInTransaction(async (client) => {
    // Lock the balance first: it serialises this player's orders, so the
    // open-order cap and the cash check below cannot race.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );

    const prior = await client.query<{ ref_id: string }>(
      `SELECT ref_id FROM ledger_entries WHERE idempotency_ref = $1`,
      [ref],
    );
    if (prior.rows[0]) {
      const existing = await orderById(client, prior.rows[0].ref_id, userId);
      if (existing) return { order: existing, fresh: false };
    }

    const ids = input.items.map((i) => i.itemId);
    const found = await client.query<ItemDbRow>(
      `SELECT ${ITEM_COLUMNS} FROM shop_items
        WHERE item_id = ANY($1::text[]) AND active AND deliverable`,
      [ids],
    );
    const byId = new Map(found.rows.map((r) => [r.item_id, r]));
    let itemsCents = 0;
    const lines: Array<{ itemId: string; qty: number; unitPriceCents: number }> = [];
    for (const line of input.items) {
      const item = byId.get(line.itemId);
      if (!item) throw new NotFoundError({ resource: 'shop_item', itemId: line.itemId });
      const unitPriceCents = Number(item.price_cents);
      itemsCents += unitPriceCents * line.qty;
      lines.push({ itemId: line.itemId, qty: line.qty, unitPriceCents });
    }

    let unitId: string | null = null;
    if (input.destination === 'door') {
      const home = await client.query<{ unit_id: string }>(
        `SELECT unit_id FROM homes
          WHERE owner_user_id = $1 AND status IN ('active', 'overdue') AND unit_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      unitId = home.rows[0]?.unit_id ?? null;
      if (unitId === null) throw new NoHomeDoorError({});
    }

    const open = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM shop_orders
        WHERE user_id = $1 AND status IN ('placed', 'out_for_delivery')`,
      [userId],
    );
    if (Number(open.rows[0]?.n ?? '0') >= MAX_OPEN_ORDERS) {
      throw new ValidationFailedError({
        reason: 'too many open orders',
        max: MAX_OPEN_ORDERS,
      });
    }

    const feeCents = input.destination === 'locker' ? LOCKER_FEE_CENTS : 0;
    const totalCents = itemsCents + feeCents;
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(totalCents)) {
      throw new InsufficientCashError({ have: cash.toString(), need: totalCents.toString() });
    }

    await client.query(
      `INSERT INTO shop_orders
         (order_id, user_id, status, delivery_window, destination, unit_id, items_cents,
          fee_cents, total_cents, placed_at, out_at, eta_at)
       VALUES ($1, $2, 'placed', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        orderId,
        userId,
        input.window,
        input.destination,
        unitId,
        itemsCents,
        feeCents,
        totalCents,
        now,
        outAt,
        etaAt,
      ],
    );
    for (const l of lines) {
      await client.query(
        `INSERT INTO shop_order_items (order_id, item_id, qty, unit_price_cents)
         VALUES ($1, $2, $3, $4)`,
        [orderId, l.itemId, l.qty, l.unitPriceCents],
      );
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [totalCents, userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'shop_order', 'shop_order', $3, $4)`,
      [userId, -totalCents, orderId, ref],
    );
    const order = await orderById(client, orderId, userId);
    if (!order) throw new NotFoundError({ resource: 'order', id: orderId });
    return { order, fresh: true };
  });

  // Schedule only after the commit, and only for a new order.
  if (placed.fresh) await scheduleShopDelivery({ orderId, outAt, etaAt }, now);
  return placed.order;
}

function validateLines(items: ReadonlyArray<{ itemId: string; qty: number }>): void {
  if (items.length === 0 || items.length > MAX_LINES_PER_ORDER) {
    throw new ValidationFailedError({
      reason: 'an order needs between 1 and the maximum number of lines',
      max: MAX_LINES_PER_ORDER,
    });
  }
  const seen = new Set<string>();
  let units = 0;
  for (const i of items) {
    if (seen.has(i.itemId)) {
      throw new ValidationFailedError({ reason: 'duplicate item line', itemId: i.itemId });
    }
    seen.add(i.itemId);
    if (!Number.isInteger(i.qty) || i.qty < 1 || i.qty > MAX_QTY_PER_LINE) {
      throw new ValidationFailedError({
        reason: 'quantity out of range',
        itemId: i.itemId,
        max: MAX_QTY_PER_LINE,
      });
    }
    units += i.qty;
  }
  if (units > MAX_UNITS_PER_ORDER) {
    throw new ValidationFailedError({
      reason: 'too many units in one order',
      max: MAX_UNITS_PER_ORDER,
    });
  }
}

/**
 * The caller's orders, newest first.
 * @param ctx - The app context.
 * @param userId - The owner.
 * @param limit - At most this many (default 50).
 */
export async function listOrders(
  ctx: AppContext,
  userId: string,
  limit = 50,
): Promise<ShopOrder[]> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<OrderDbRow>(
      `SELECT ${ORDER_COLUMNS} FROM shop_orders
        WHERE user_id = $1 ORDER BY placed_at DESC, order_id DESC LIMIT $2`,
      [userId, limit],
    );
    const lines = await loadLines(
      c,
      r.rows.map((o) => o.order_id),
    );
    return r.rows.map((o) => toOrder(o, lines.get(o.order_id) ?? []));
  });
}

/**
 * One order. Someone else's order is indistinguishable from none (404).
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param orderId - The order.
 */
export async function getOrder(
  ctx: AppContext,
  userId: string,
  orderId: string,
): Promise<ShopOrder> {
  const order = await ctx.db.withConnection((c) => orderById(c, orderId, userId));
  if (!order) throw new NotFoundError({ resource: 'order', id: orderId });
  return order;
}

/**
 * Cancel an order that is still `placed`, with a full refund (items and
 * locker fee). The row lock orders this against the delivery worker: one of
 * the two wins, and a cancelled order is never delivered. Cancelling an
 * order that is already cancelled returns it without refunding again.
 * @param _ctx - The app context.
 * @param userId - The caller; must own the order.
 * @param orderId - The order.
 */
export async function cancelOrder(
  _ctx: AppContext,
  userId: string,
  orderId: string,
): Promise<ShopOrder> {
  const out = await runInTransaction(async (client) => {
    const r = await client.query<OrderDbRow>(
      `SELECT ${ORDER_COLUMNS} FROM shop_orders WHERE order_id = $1 AND user_id = $2 FOR UPDATE`,
      [orderId, userId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundError({ resource: 'order', id: orderId });
    if (row.status !== 'cancelled') {
      if (row.status !== 'placed') throw new OrderNotCancellableError({ status: row.status });
      const total = Number(row.total_cents);
      // The balance is locked after the order, the same order the worker takes.
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      await client.query(`SELECT 1 FROM balances WHERE user_id = $1 FOR UPDATE`, [userId]);
      await client.query(
        `UPDATE shop_orders SET status = 'cancelled', cancelled_at = now() WHERE order_id = $1`,
        [orderId],
      );
      await client.query(
        `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
        [total, userId],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'shop_refund', 'shop_order', $3, $4)`,
        [userId, total, orderId, `shop-refund:${orderId}`],
      );
    }
    const order = await orderById(client, orderId, userId);
    if (!order) throw new NotFoundError({ resource: 'order', id: orderId });
    return order;
  });
  await unscheduleShopDelivery(orderId);
  return out;
}
