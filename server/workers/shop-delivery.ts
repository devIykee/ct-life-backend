/**
 * Duo Shop delivery worker.
 *
 * Moves an order `placed -> out_for_delivery -> delivered` and tells the
 * player:
 *
 *   out      about 60 s before the ETA   -> realtime `delivery_out`
 *            (the client spawns the courier van)
 *   deliver  at the ETA                  -> items become `player_items`,
 *            realtime `delivery_arrived` (the client drops the parcel)
 *
 * Each step runs in a transaction that locks the order row and checks its
 * status first, so a cancelled order is never delivered, a job that runs
 * twice does nothing the second time, and cancel and delivery cannot both
 * win. The realtime push happens after the commit.
 *
 * BullMQ delayed jobs (`server/application/shop-queue.ts`) are the clock;
 * a sweep every minute picks up any due order whose job was lost (Redis
 * flush, API down while ordering). All step functions take `now` so tests
 * can drive them directly.
 */
import type { Job } from 'bullmq';
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from '../application/context.js';
import { publishToUser } from '../application/realtime-bus.js';
import type { ShopJobData, ShopJobName } from '../application/shop-queue.js';

export type StepResult = 'done' | 'skipped' | 'not_due';

interface LockedOrder {
  order_id: string;
  user_id: string;
  status: string;
  destination: 'door' | 'locker';
  unit_id: string | null;
  out_at: Date;
  eta_at: Date;
}

interface Push {
  readonly userId: string;
  readonly type: 'delivery_out' | 'delivery_arrived';
  readonly payload: Record<string, unknown>;
}

async function lockOrder(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  orderId: string,
): Promise<LockedOrder | null> {
  const r = await client.query(
    `SELECT order_id, user_id, status, destination, unit_id, out_at, eta_at
       FROM shop_orders WHERE order_id = $1 FOR UPDATE`,
    [orderId],
  );
  return (r.rows[0] as LockedOrder | undefined) ?? null;
}

/**
 * Send the courier out: `placed -> out_for_delivery`, then push
 * `delivery_out`. Does nothing for an order that is cancelled, already out
 * or delivered, or not yet due.
 * @param ctx - The app context.
 * @param orderId - The order.
 * @param now - The current time (injectable for tests).
 */
export async function markOutForDelivery(
  ctx: AppContext,
  orderId: string,
  now: Date = new Date(),
): Promise<StepResult> {
  let push: Push | null = null;
  const result = await runInTransaction(async (client) => {
    const o = await lockOrder(client, orderId);
    if (!o || o.status !== 'placed') return 'skipped' as const;
    if (o.out_at.getTime() > now.getTime()) return 'not_due' as const;
    await client.query(`UPDATE shop_orders SET status = 'out_for_delivery' WHERE order_id = $1`, [
      orderId,
    ]);
    push = {
      userId: o.user_id,
      type: 'delivery_out',
      payload: {
        orderId,
        destination: o.destination,
        unitId: o.destination === 'door' ? o.unit_id : null,
        etaAt: o.eta_at.getTime(),
      },
    };
    return 'done' as const;
  });
  const p = push as Push | null;
  if (p) await publishToUser(ctx, p.userId, p.type, p.payload);
  return result;
}

/**
 * Deliver the order: the items become the player's `player_items`, one row
 * per unit, then `delivery_arrived` is pushed. An order whose `out` step was
 * lost (still `placed`) is delivered all the same, once its ETA has passed.
 * Does nothing for a cancelled or already delivered order, or before the ETA.
 * @param ctx - The app context.
 * @param orderId - The order.
 * @param now - The current time (injectable for tests).
 */
export async function deliverOrder(
  ctx: AppContext,
  orderId: string,
  now: Date = new Date(),
): Promise<StepResult> {
  let push: Push | null = null;
  const result = await runInTransaction(async (client) => {
    const o = await lockOrder(client, orderId);
    if (!o || (o.status !== 'placed' && o.status !== 'out_for_delivery')) {
      return 'skipped' as const;
    }
    if (o.eta_at.getTime() > now.getTime()) return 'not_due' as const;
    const lines = await client.query<{ item_id: string; qty: number }>(
      `SELECT item_id, qty FROM shop_order_items WHERE order_id = $1`,
      [orderId],
    );
    for (const l of lines.rows) {
      for (let n = 0; n < l.qty; n++) {
        await client.query(
          `INSERT INTO player_items (instance_id, user_id, item_id, order_id, acquired_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv7(), o.user_id, l.item_id, orderId, now],
        );
      }
    }
    await client.query(
      `UPDATE shop_orders SET status = 'delivered', delivered_at = $2 WHERE order_id = $1`,
      [orderId, now],
    );
    push = {
      userId: o.user_id,
      type: 'delivery_arrived',
      payload: {
        orderId,
        destination: o.destination,
        unitId: o.destination === 'door' ? o.unit_id : null,
      },
    };
    return 'done' as const;
  });
  const p = push as Push | null;
  if (p) await publishToUser(ctx, p.userId, p.type, p.payload);
  return result;
}

/**
 * Advance every order whose time has come. A failure on one order is logged
 * and does not stop the others; the next sweep tries it again.
 * @param ctx - The app context.
 * @param now - The current time (injectable for tests).
 * @returns How many orders were sent out and how many delivered.
 */
export async function sweepShopOrders(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<{ out: number; delivered: number }> {
  const due = await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ order_id: string; status: string; eta_at: Date }>(
      `SELECT order_id, status, eta_at FROM shop_orders
        WHERE (status = 'placed' AND out_at <= $1) OR (status = 'out_for_delivery' AND eta_at <= $1)
        ORDER BY eta_at ASC
        LIMIT 200`,
      [now],
    );
    return r.rows;
  });
  let out = 0;
  let delivered = 0;
  for (const row of due) {
    try {
      if (row.status === 'placed' && row.eta_at.getTime() > now.getTime()) {
        if ((await markOutForDelivery(ctx, row.order_id, now)) === 'done') out += 1;
      } else if ((await deliverOrder(ctx, row.order_id, now)) === 'done') {
        delivered += 1;
      }
    } catch (e) {
      console.error(`[shop-delivery] order ${row.order_id} failed:`, (e as Error).message);
    }
  }
  return { out, delivered };
}

/**
 * BullMQ handler for `jobs-shop-delivery`. Errors are caught per job: the
 * minute sweep is the retry, so the queue never needs to.
 * @param job - The job: `out`, `deliver` (with an order id) or `sweep`.
 * @param ctx - The app context.
 */
export async function handleShopDelivery(
  job: Job<ShopJobData, unknown, string>,
  ctx: AppContext,
): Promise<void> {
  const name = job.name as ShopJobName;
  try {
    if (name === 'sweep') {
      await sweepShopOrders(ctx);
    } else if (job.data.orderId) {
      if (name === 'out') await markOutForDelivery(ctx, job.data.orderId);
      else if (name === 'deliver') await deliverOrder(ctx, job.data.orderId);
    }
  } catch (e) {
    console.error(`[shop-delivery] ${name} job ${job.id ?? '?'} failed:`, (e as Error).message);
  }
}
