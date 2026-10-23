/**
 * Duo Shop service tests: catalogue, orders (debit, ledger, door and locker,
 * limits, idempotency), cancel and refund, the delivery worker steps, owned
 * items and home placements.
 *
 * The delivery queue and the realtime push are stubbed; the worker steps are
 * driven directly with an injected `now`.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';

vi.mock('./shop-queue.js', () => ({
  scheduleShopDelivery: vi.fn(async () => undefined),
  unscheduleShopDelivery: vi.fn(async () => undefined),
  closeShopQueue: vi.fn(async () => undefined),
}));
vi.mock('./realtime-bus.js', async (orig) => ({
  ...(await orig<typeof import('./realtime-bus.js')>()),
  publishToUser: vi.fn(async () => undefined),
}));

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  ForbiddenError,
  InsufficientCashError,
  ItemAlreadyPlacedError,
  ItemNotOwnedError,
  ItemNotPlaceableError,
  NoHomeDoorError,
  NotFoundError,
  NotHomeOwnerError,
  OrderNotCancellableError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import {
  cancelOrder,
  getOrder,
  listCatalog,
  listOrders,
  LOCKER_FEE_CENTS,
  OUT_LEAD_MS,
  placeOrder,
  type ShopOrder,
} from './shop.js';
import { getPlacements, listMyItems, setPlacements } from './player-items.js';
import { scheduleShopDelivery, unscheduleShopDelivery } from './shop-queue.js';
import { publishToUser } from './realtime-bus.js';
import { deliverOrder, markOutForDelivery, sweepShopOrders } from '../workers/shop-delivery.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const UNIT = 'test:shop_svc:0';
const T0 = new Date('2026-10-23T12:00:00.000Z');
const min = (n: number): Date => new Date(T0.getTime() + n * 60_000);

let buyer: string;
let stranger: string;
let homeId: string;

async function newUser(cashCents: number): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `shop-${id}`]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = 0`,
    [id, cashCents],
  );
  return id;
}

async function cashOf(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? '0');
}

async function ledgerOf(userId: string): Promise<Array<{ reason: string; delta: number }>> {
  const r = await pool.query<{ reason: string; delta_cents: string }>(
    `SELECT reason, delta_cents FROM ledger_entries
      WHERE user_id = $1 AND reason LIKE 'shop_%' ORDER BY id`,
    [userId],
  );
  return r.rows.map((x) => ({ reason: x.reason, delta: Number(x.delta_cents) }));
}

async function priceOf(itemId: string): Promise<number> {
  const r = await pool.query<{ price_cents: string }>(
    `SELECT price_cents FROM shop_items WHERE item_id = $1`,
    [itemId],
  );
  return Number(r.rows[0]?.price_cents);
}

const order = (
  userId: string,
  items: Array<{ itemId: string; qty: number }>,
  opts: { window?: 'asap' | '30m' | '1h'; destination?: 'door' | 'locker' } = {},
  now = T0,
): Promise<ShopOrder> =>
  placeOrder(
    ctx,
    userId,
    { items, window: opts.window ?? 'asap', destination: opts.destination ?? 'door' },
    uuidv7(),
    now,
  );

beforeAll(async () => {
  await pool.query(
    `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents, capacity)
     VALUES ($1, 'residences', 'penthouse', 'test_room', 150000, 3)
     ON CONFLICT (unit_id) DO NOTHING`,
    [UNIT],
  );
  await listCatalog(ctx, null); // seeds shop_items
});

afterAll(async () => {
  await pool.query(`DELETE FROM homes WHERE unit_id = $1`, [UNIT]);
  await pool.query(
    `DELETE FROM player_items WHERE order_id IN (SELECT order_id FROM shop_orders WHERE unit_id = $1)`,
    [UNIT],
  );
  await pool.query(`DELETE FROM shop_orders WHERE unit_id = $1`, [UNIT]);
  await pool.query(`DELETE FROM home_units WHERE unit_id = $1`, [UNIT]);
  await pool.end();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(`DELETE FROM homes WHERE unit_id = $1`, [UNIT]);
  buyer = await newUser(1_000_000);
  stranger = await newUser(1_000_000);
  homeId = `home:${uuidv7()}`;
  await pool.query(
    `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, last_rent_paid_at, unit_id)
     VALUES ($1, $2, 'penthouse', 150000, now(), $3)`,
    [homeId, buyer, UNIT],
  );
});

describe('catalogue', () => {
  it('lists the seeded items with footprints for placeables, by category', async () => {
    const all = await listCatalog(ctx, null);
    expect(all.items.length).toBeGreaterThanOrEqual(18);
    expect(all.lockerFeeCents).toBe(LOCKER_FEE_CENTS);
    expect(all.windows).toEqual([
      { id: 'asap', minutes: 10 },
      { id: '30m', minutes: 30 },
      { id: '1h', minutes: 60 },
    ]);
    const categories = new Set(all.items.map((i) => i.category));
    for (const c of ['furniture', 'decor', 'appliance', 'food']) {
      expect(categories.has(c as never)).toBe(true);
    }
    for (const i of all.items) {
      expect(i.deliverable).toBe(true);
      expect(i.priceCents).toBeGreaterThan(0);
      if (i.placeable) expect(i.footprint).not.toBeNull();
      else expect(i.footprint).toBeNull();
    }
    const furniture = await listCatalog(ctx, 'furniture');
    expect(furniture.items.length).toBeGreaterThan(0);
    expect(furniture.items.every((i) => i.category === 'furniture' && i.placeable)).toBe(true);
    expect((await listCatalog(ctx, 'food')).items.every((i) => !i.placeable)).toBe(true);
  });

  it('hides an item that is no longer in the file', async () => {
    await pool.query(`UPDATE shop_items SET active = false WHERE item_id = 'plant_zebra'`);
    try {
      const decor = await listCatalog(ctx, 'decor');
      expect(decor.items.some((i) => i.itemId === 'plant_zebra')).toBe(false);
      await expect(order(buyer, [{ itemId: 'plant_zebra', qty: 1 }])).rejects.toBeInstanceOf(
        NotFoundError,
      );
    } finally {
      await pool.query(`UPDATE shop_items SET active = true WHERE item_id = 'plant_zebra'`);
    }
  });
});

describe('placing an order', () => {
  it('debits Cash from the catalogue price, writes the ledger and schedules delivery', async () => {
    const sofa = await priceOf('sofa_linen');
    const lamp = await priceOf('lamp_pipe');
    const o = await order(buyer, [
      { itemId: 'sofa_linen', qty: 1 },
      { itemId: 'lamp_pipe', qty: 2 },
    ]);
    const total = sofa + 2 * lamp;
    expect(o).toMatchObject({
      status: 'placed',
      window: 'asap',
      destination: 'door',
      unitId: UNIT,
      itemsCents: total,
      feeCents: 0,
      totalCents: total,
      etaAt: min(10).toISOString(),
    });
    expect(o.items.map((l) => [l.itemId, l.qty, l.unitPriceCents])).toEqual([
      ['lamp_pipe', 2, lamp],
      ['sofa_linen', 1, sofa],
    ]);
    expect(await cashOf(buyer)).toBe(1_000_000 - total);
    expect(await ledgerOf(buyer)).toEqual([{ reason: 'shop_order', delta: -total }]);
    expect(scheduleShopDelivery).toHaveBeenCalledWith(
      { orderId: o.orderId, outAt: new Date(min(10).getTime() - OUT_LEAD_MS), etaAt: min(10) },
      T0,
    );
  });

  it('uses the window to set the ETA', async () => {
    expect((await order(buyer, [{ itemId: 'pantry_restock', qty: 1 }], { window: '30m' })).etaAt).toBe(
      min(30).toISOString(),
    );
    expect((await order(buyer, [{ itemId: 'pantry_restock', qty: 1 }], { window: '1h' })).etaAt).toBe(
      min(60).toISOString(),
    );
  });

  it('refuses the door without a home, and for a home without a door', async () => {
    const street = await newUser(100_000);
    await expect(order(street, [{ itemId: 'pantry_restock', qty: 1 }])).rejects.toBeInstanceOf(
      NoHomeDoorError,
    );
    await pool.query(
      `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, last_rent_paid_at)
       VALUES ($1, $2, 'parents_basement', 2000, now())`,
      [`home:${uuidv7()}`, street],
    );
    const err = await order(street, [{ itemId: 'pantry_restock', qty: 1 }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoHomeDoorError);
    expect((err as NoHomeDoorError).code).toBe('NO_HOME_DOOR');
    expect((err as NoHomeDoorError).httpStatus).toBe(409);
    expect(await cashOf(street)).toBe(100_000);
  });

  it('charges the locker fee, and a street player can order to the locker', async () => {
    const street = await newUser(100_000);
    const price = await priceOf('side_table_oak');
    const o = await order(street, [{ itemId: 'side_table_oak', qty: 2 }], { destination: 'locker' });
    expect(o).toMatchObject({
      destination: 'locker',
      unitId: null,
      itemsCents: 2 * price,
      feeCents: LOCKER_FEE_CENTS,
      totalCents: 2 * price + LOCKER_FEE_CENTS,
    });
    expect(await cashOf(street)).toBe(100_000 - 2 * price - LOCKER_FEE_CENTS);
    expect(await ledgerOf(street)).toEqual([
      { reason: 'shop_order', delta: -(2 * price + LOCKER_FEE_CENTS) },
    ]);
  });

  it('refuses with INSUFFICIENT_CASH and changes nothing', async () => {
    const poor = await newUser(1_000);
    await pool.query(
      `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, last_rent_paid_at)
       VALUES ($1, $2, 'parents_basement', 2000, now())`,
      [`home:${uuidv7()}`, poor],
    );
    const err = await order(poor, [{ itemId: 'sofa_linen', qty: 1 }], {
      destination: 'locker',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientCashError);
    expect((err as InsufficientCashError).code).toBe('INSUFFICIENT_CASH');
    expect(await cashOf(poor)).toBe(1_000);
    expect(await ledgerOf(poor)).toEqual([]);
    expect((await listOrders(ctx, poor)).length).toBe(0);
    expect(scheduleShopDelivery).not.toHaveBeenCalled();
  });

  it('enforces quantity and line limits and rejects unknown items', async () => {
    const bad = (items: Array<{ itemId: string; qty: number }>): Promise<unknown> =>
      order(buyer, items).catch((e: unknown) => e);
    expect(await bad([])).toBeInstanceOf(ValidationFailedError);
    expect(await bad([{ itemId: 'pantry_restock', qty: 0 }])).toBeInstanceOf(ValidationFailedError);
    expect(await bad([{ itemId: 'pantry_restock', qty: 11 }])).toBeInstanceOf(ValidationFailedError);
    expect(await bad([{ itemId: 'pantry_restock', qty: 1.5 }])).toBeInstanceOf(ValidationFailedError);
    expect(
      await bad([
        { itemId: 'pantry_restock', qty: 1 },
        { itemId: 'pantry_restock', qty: 1 },
      ]),
    ).toBeInstanceOf(ValidationFailedError);
    expect(
      await bad([
        { itemId: 'pantry_restock', qty: 10 },
        { itemId: 'side_table_oak', qty: 10 },
        { itemId: 'vase_stoneware', qty: 1 },
      ]),
    ).toBeInstanceOf(ValidationFailedError);
    expect(await bad([{ itemId: 'no_such_item', qty: 1 }])).toBeInstanceOf(NotFoundError);
    expect(await cashOf(buyer)).toBe(1_000_000);
  });

  it('caps the orders in flight', async () => {
    for (let i = 0; i < 5; i++) await order(buyer, [{ itemId: 'pantry_restock', qty: 1 }]);
    await expect(order(buyer, [{ itemId: 'pantry_restock', qty: 1 }])).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('replaying the same Idempotency-Key returns the order and charges once', async () => {
    const input = {
      items: [{ itemId: 'sofa_linen', qty: 1 }],
      window: 'asap' as const,
      destination: 'door' as const,
    };
    const key = uuidv7();
    const a = await placeOrder(ctx, buyer, input, key, T0);
    const b = await placeOrder(ctx, buyer, input, key, min(1));
    expect(b.orderId).toBe(a.orderId);
    expect(await ledgerOf(buyer)).toHaveLength(1);
    expect(await cashOf(buyer)).toBe(1_000_000 - a.totalCents);
    expect(scheduleShopDelivery).toHaveBeenCalledTimes(1);
  });
});

describe('reading orders', () => {
  it('lists my orders newest first and hides other players orders (no IDOR)', async () => {
    const a = await order(buyer, [{ itemId: 'pantry_restock', qty: 1 }], {}, T0);
    const b = await order(buyer, [{ itemId: 'vase_stoneware', qty: 1 }], {}, min(1));
    expect((await listOrders(ctx, buyer)).map((o) => o.orderId)).toEqual([b.orderId, a.orderId]);
    expect(await listOrders(ctx, stranger)).toEqual([]);
    expect((await getOrder(ctx, buyer, a.orderId)).orderId).toBe(a.orderId);
    await expect(getOrder(ctx, stranger, a.orderId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getOrder(ctx, buyer, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('cancel', () => {
  it('refunds in full (locker fee included), once, and unschedules', async () => {
    const o = await order(buyer, [{ itemId: 'sofa_linen', qty: 1 }], { destination: 'locker' });
    expect(await cashOf(buyer)).toBe(1_000_000 - o.totalCents);
    const c = await cancelOrder(ctx, buyer, o.orderId);
    expect(c.status).toBe('cancelled');
    expect(c.cancelledAt).not.toBeNull();
    expect(await cashOf(buyer)).toBe(1_000_000);
    expect(await ledgerOf(buyer)).toEqual([
      { reason: 'shop_order', delta: -o.totalCents },
      { reason: 'shop_refund', delta: o.totalCents },
    ]);
    expect(unscheduleShopDelivery).toHaveBeenCalledWith(o.orderId);
    // Again: same answer, no second refund.
    expect((await cancelOrder(ctx, buyer, o.orderId)).status).toBe('cancelled');
    expect(await cashOf(buyer)).toBe(1_000_000);
  });

  it("cannot cancel someone else's order, or one that is out for delivery", async () => {
    const o = await order(buyer, [{ itemId: 'pantry_restock', qty: 1 }]);
    await expect(cancelOrder(ctx, stranger, o.orderId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getOrder(ctx, buyer, o.orderId)).status).toBe('placed');
    await markOutForDelivery(ctx, o.orderId, min(9));
    const err = await cancelOrder(ctx, buyer, o.orderId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderNotCancellableError);
    expect((err as OrderNotCancellableError).code).toBe('ORDER_NOT_CANCELLABLE');
    expect(await cashOf(buyer)).toBe(1_000_000 - o.totalCents);
  });

  it('is never delivered after a cancel', async () => {
    const o = await order(buyer, [{ itemId: 'sofa_linen', qty: 1 }]);
    await cancelOrder(ctx, buyer, o.orderId);
    expect(await markOutForDelivery(ctx, o.orderId, min(9))).toBe('skipped');
    expect(await deliverOrder(ctx, o.orderId, min(11))).toBe('skipped');
    await sweepShopOrders(ctx, min(30)); // the cancelled order is not picked up
    expect(await listMyItems(ctx, buyer)).toEqual([]);
    expect((await getOrder(ctx, buyer, o.orderId)).status).toBe('cancelled');
    const pushed = vi.mocked(publishToUser).mock.calls.map((c) => c[3]);
    expect(pushed.some((p) => p.orderId === o.orderId)).toBe(false);
  });
});

describe('delivery worker', () => {
  it('goes placed -> out_for_delivery -> delivered with the pushes', async () => {
    const o = await order(buyer, [
      { itemId: 'sofa_linen', qty: 1 },
      { itemId: 'plant_zebra', qty: 2 },
    ]);
    // Too early for both steps.
    expect(await markOutForDelivery(ctx, o.orderId, min(8))).toBe('not_due');
    expect(await deliverOrder(ctx, o.orderId, min(8))).toBe('not_due');
    expect((await getOrder(ctx, buyer, o.orderId)).status).toBe('placed');

    // 60 s before the ETA the van leaves.
    expect(await markOutForDelivery(ctx, o.orderId, min(9))).toBe('done');
    expect((await getOrder(ctx, buyer, o.orderId)).status).toBe('out_for_delivery');
    expect(publishToUser).toHaveBeenCalledWith(ctx, buyer, 'delivery_out', {
      orderId: o.orderId,
      destination: 'door',
      unitId: UNIT,
      etaAt: min(10).getTime(),
    });
    expect(await markOutForDelivery(ctx, o.orderId, min(9))).toBe('skipped'); // twice: no-op
    expect(await deliverOrder(ctx, o.orderId, min(9.5))).toBe('not_due');

    // At the ETA it arrives.
    expect(await deliverOrder(ctx, o.orderId, min(10))).toBe('done');
    const done = await getOrder(ctx, buyer, o.orderId);
    expect(done.status).toBe('delivered');
    expect(done.deliveredAt).toBe(min(10).toISOString());
    expect(publishToUser).toHaveBeenCalledWith(ctx, buyer, 'delivery_arrived', {
      orderId: o.orderId,
      destination: 'door',
      unitId: UNIT,
    });
    expect(await deliverOrder(ctx, o.orderId, min(11))).toBe('skipped'); // twice: no duplicates
    expect(publishToUser).toHaveBeenCalledTimes(2);
  });

  it('puts delivered items in /me/items, one row per unit', async () => {
    const o = await order(buyer, [
      { itemId: 'sofa_linen', qty: 1 },
      { itemId: 'plant_zebra', qty: 2 },
    ]);
    expect(await listMyItems(ctx, buyer)).toEqual([]); // nothing before delivery
    await deliverOrder(ctx, o.orderId, min(10));
    await deliverOrder(ctx, o.orderId, min(12));
    const items = await listMyItems(ctx, buyer);
    expect(items.map((i) => i.itemId).sort()).toEqual([
      'plant_zebra',
      'plant_zebra',
      'sofa_linen',
    ]);
    expect(new Set(items.map((i) => i.itemInstanceId)).size).toBe(3);
    expect(items.every((i) => i.orderId === o.orderId && i.placedHomeId === null)).toBe(true);
    const sofa = items.find((i) => i.itemId === 'sofa_linen')!;
    expect(sofa).toMatchObject({ placeable: true, category: 'furniture' });
    expect(sofa.footprint).not.toBeNull();
    expect(sofa.modelKey).toBe('fu_sofa_linen');
    expect(await listMyItems(ctx, stranger)).toEqual([]);
  });

  it('delivers to the locker with unitId null', async () => {
    const street = await newUser(100_000);
    const o = await order(street, [{ itemId: 'pantry_restock', qty: 1 }], { destination: 'locker' });
    await markOutForDelivery(ctx, o.orderId, min(9));
    await deliverOrder(ctx, o.orderId, min(10));
    expect(publishToUser).toHaveBeenCalledWith(ctx, street, 'delivery_out', {
      orderId: o.orderId,
      destination: 'locker',
      unitId: null,
      etaAt: min(10).getTime(),
    });
    expect(publishToUser).toHaveBeenCalledWith(ctx, street, 'delivery_arrived', {
      orderId: o.orderId,
      destination: 'locker',
      unitId: null,
    });
    expect(await listMyItems(ctx, street)).toHaveLength(1);
  });

  it('the sweep recovers orders whose delayed jobs were lost', async () => {
    // The sweep is global, so other tests' leftover orders may be swept too.
    const early = await order(buyer, [{ itemId: 'pantry_restock', qty: 1 }]); // asap
    const late = await order(buyer, [{ itemId: 'vase_stoneware', qty: 1 }], { window: '1h' });
    expect((await sweepShopOrders(ctx, min(9.5))).out).toBeGreaterThanOrEqual(1);
    expect((await getOrder(ctx, buyer, early.orderId)).status).toBe('out_for_delivery');
    expect((await getOrder(ctx, buyer, late.orderId)).status).toBe('placed');
    expect((await sweepShopOrders(ctx, min(11))).delivered).toBeGreaterThanOrEqual(1);
    expect((await getOrder(ctx, buyer, early.orderId)).status).toBe('delivered');
    expect((await getOrder(ctx, buyer, late.orderId)).status).toBe('placed');
    // A job that never ran at all: past the ETA straight from placed to delivered.
    expect((await sweepShopOrders(ctx, min(61))).delivered).toBeGreaterThanOrEqual(1);
    expect((await getOrder(ctx, buyer, late.orderId)).status).toBe('delivered');
    expect(await listMyItems(ctx, buyer)).toHaveLength(2);
  });

  it('one failing order does not stop the sweep', async () => {
    const bad = await newUser(100_000);
    const a = await order(bad, [{ itemId: 'pantry_restock', qty: 1 }], { destination: 'locker' });
    const b = await order(buyer, [{ itemId: 'vase_stoneware', qty: 1 }]);
    // Make the delivery of the first player's items fail.
    await pool.query(
      `CREATE OR REPLACE FUNCTION shop_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.user_id = '${bad}'::uuid THEN RAISE EXCEPTION 'shop test failure'; END IF;
         RETURN NEW;
       END $$`,
    );
    await pool.query(
      `CREATE TRIGGER shop_test_fail BEFORE INSERT ON player_items
         FOR EACH ROW EXECUTE FUNCTION shop_test_fail()`,
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await sweepShopOrders(ctx, min(11));
      expect((await getOrder(ctx, buyer, b.orderId)).status).toBe('delivered');
      expect((await getOrder(ctx, bad, a.orderId)).status).not.toBe('delivered');
      expect(await listMyItems(ctx, bad)).toEqual([]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await pool.query(`DROP TRIGGER IF EXISTS shop_test_fail ON player_items`);
      await pool.query(`DROP FUNCTION IF EXISTS shop_test_fail()`);
    }
  });
});

describe('placements', () => {
  async function delivered(
    items: Array<{ itemId: string; qty: number }>,
    userId = buyer,
  ): Promise<void> {
    const o = await order(userId, items, {
      destination: userId === buyer ? 'door' : 'locker',
    });
    await deliverOrder(ctx, o.orderId, min(10));
  }
  const idOf = async (userId: string, itemId: string): Promise<string> =>
    (await listMyItems(ctx, userId)).find((i) => i.itemId === itemId)!.itemInstanceId;

  it('places owned placeable items, replaces the set and shows them in /me/items', async () => {
    await delivered([
      { itemId: 'sofa_linen', qty: 1 },
      { itemId: 'lamp_pipe', qty: 1 },
    ]);
    const sofa = await idOf(buyer, 'sofa_linen');
    const lamp = await idOf(buyer, 'lamp_pipe');
    const set = await setPlacements(ctx, homeId, buyer, [
      { itemInstanceId: sofa, x: 1, z: 2, rotY: 0.5 },
      { itemInstanceId: lamp, x: -1, z: 0, rotY: 0 },
    ]);
    expect(set.homeId).toBe(homeId);
    expect(set.placements.map((p) => [p.itemId, p.x, p.z, p.rotY])).toEqual([
      ['sofa_linen', 1, 2, 0.5],
      ['lamp_pipe', -1, 0, 0],
    ]);
    expect(set.placements[0]!.footprint).not.toBeNull();
    expect((await listMyItems(ctx, buyer)).every((i) => i.placedHomeId === homeId)).toBe(true);
    // Replace with one item: the lamp is free again.
    const again = await setPlacements(ctx, homeId, buyer, [
      { itemInstanceId: sofa, x: 3, z: 3, rotY: 1 },
    ]);
    expect(again.placements).toHaveLength(1);
    expect(
      (await listMyItems(ctx, buyer)).find((i) => i.itemId === 'lamp_pipe')!.placedHomeId,
    ).toBe(null);
    expect((await setPlacements(ctx, homeId, buyer, [])).placements).toEqual([]);
  });

  it('refuses an item that is not owned, not placeable, or listed twice', async () => {
    await delivered([
      { itemId: 'sofa_linen', qty: 1 },
      { itemId: 'pantry_restock', qty: 1 },
    ]);
    await delivered([{ itemId: 'lamp_pipe', qty: 1 }], stranger);
    const sofa = await idOf(buyer, 'sofa_linen');
    const noodles = await idOf(buyer, 'pantry_restock');
    const theirs = await idOf(stranger, 'lamp_pipe');
    const p = (id: string): { itemInstanceId: string; x: number; z: number; rotY: number } => ({
      itemInstanceId: id,
      x: 0,
      z: 0,
      rotY: 0,
    });
    await expect(setPlacements(ctx, homeId, buyer, [p(theirs)])).rejects.toBeInstanceOf(
      ItemNotOwnedError,
    );
    await expect(setPlacements(ctx, homeId, buyer, [p(uuidv7())])).rejects.toBeInstanceOf(
      ItemNotOwnedError,
    );
    await expect(setPlacements(ctx, homeId, buyer, [p(noodles)])).rejects.toBeInstanceOf(
      ItemNotPlaceableError,
    );
    await expect(setPlacements(ctx, homeId, buyer, [p(sofa), p(sofa)])).rejects.toBeInstanceOf(
      ItemAlreadyPlacedError,
    );
    await expect(
      setPlacements(ctx, homeId, buyer, [{ ...p(sofa), x: 1e9 }]),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      setPlacements(ctx, homeId, buyer, [{ ...p(sofa), x: Number.NaN }]),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect((await getPlacements(ctx, homeId, buyer)).placements).toEqual([]);
  });

  it('only the owner sets placements; an unknown home is 404', async () => {
    await delivered([{ itemId: 'sofa_linen', qty: 1 }], stranger);
    const sofa = await idOf(stranger, 'sofa_linen');
    const err = await setPlacements(ctx, homeId, stranger, [
      { itemInstanceId: sofa, x: 0, z: 0, rotY: 0 },
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotHomeOwnerError);
    await expect(setPlacements(ctx, `home:${uuidv7()}`, buyer, [])).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await getPlacements(ctx, homeId, buyer)).placements).toEqual([]);
  });

  it('a visitor reads the placements only with access (owner, guest), not a stranger', async () => {
    await delivered([{ itemId: 'sofa_linen', qty: 1 }]);
    const sofa = await idOf(buyer, 'sofa_linen');
    await setPlacements(ctx, homeId, buyer, [{ itemInstanceId: sofa, x: 1, z: 1, rotY: 0 }]);
    await expect(getPlacements(ctx, homeId, stranger)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getPlacements(ctx, `home:${uuidv7()}`, stranger)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await pool.query(`INSERT INTO home_guests (home_id, user_id) VALUES ($1, $2)`, [
      homeId,
      stranger,
    ]);
    const seen = await getPlacements(ctx, homeId, stranger);
    expect(seen.placements.map((x) => x.itemId)).toEqual(['sofa_linen']);
    // Revoked: locked out again. Moved out: nobody gets in.
    await pool.query(`DELETE FROM home_guests WHERE home_id = $1`, [homeId]);
    await expect(getPlacements(ctx, homeId, stranger)).rejects.toBeInstanceOf(ForbiddenError);
    await pool.query(`UPDATE homes SET status = 'moved_out' WHERE home_id = $1`, [homeId]);
    await expect(getPlacements(ctx, homeId, buyer)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
