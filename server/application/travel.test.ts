/**
 * Map Travel service tests (docs/TRAVEL.md) against the real test Postgres and Redis:
 * fares, ride times and the arrival point for every venue; quote; booking (debit, ledger,
 * idempotent replay, one winner under concurrency, cash, cooldown, hourly limit, jail, bus
 * stop, quote expiry and drift); the single-use arrival ticket; cancel; the refund sweep.
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  InsufficientCashError,
  JailedError,
  NotFoundError,
  QuoteExpiredError,
  SybilJailedError,
  TravelCooldownError,
  TravelInProgressError,
  TravelLockedError,
  TravelNotAtStopError,
  TravelNotCancellableError,
  TravelNotInWorldError,
  VenueGatedError,
} from '../shared/domain/errors.js';
import {
  distanceToPolygon,
  encodePos,
  getIslandGeometry,
  onLand,
  POS_HASH,
  type DistrictId,
} from '../realtime/movement.js';
import {
  SWEEP_GRACE_MS,
  arrivalFor,
  bookTrip,
  cancelTrip,
  consumeTicket,
  currentTrip,
  fareCents,
  getTravelConfig,
  hasOpenTicket,
  markArrived,
  quoteTravel,
  rideSeconds,
  setTravelConfigForTests,
  STREET_BORDER_M,
  sweepTravelTrips,
  travelClientConfig,
  travelTicketKey,
  type TravelConfig,
  type TravelTicket,
} from './travel.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const redis = ctx.redis.main;
const cfg = getTravelConfig();
const STOP = cfg.busStops.find((s) => s.id === 'stop_timeline')!;
const DEST = 'terminal_cafe';
const users: string[] = [];

async function newUser(cashCents: number, debtCents = 0): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `travel-${id}`]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = $3`,
    [id, cashCents, debtCents],
  );
  users.push(id);
  return id;
}

async function standAt(userId: string, x: number, z: number, at = Date.now()): Promise<void> {
  await redis.hset(POS_HASH, userId, encodePos({ x, z, at }));
}

const cashOf = async (userId: string): Promise<number> =>
  Number(
    (
      await pool.query<{ c: string }>(`SELECT cash_cents AS c FROM balances WHERE user_id = $1`, [
        userId,
      ])
    ).rows[0]?.c ?? 0,
  );

const ledgerSum = async (userId: string, reason: string): Promise<{ n: number; sum: number }> => {
  const r = await pool.query<{ n: string; s: string | null }>(
    `SELECT COUNT(*)::text AS n, SUM(delta_cents)::text AS s FROM ledger_entries
      WHERE user_id = $1 AND reason = $2`,
    [userId, reason],
  );
  return { n: Number(r.rows[0]!.n), sum: Number(r.rows[0]!.s ?? 0) };
};

async function quoteAndBook(
  userId: string,
  mode: 'bus' | 'taxi',
  now = new Date(),
  key = uuidv7(),
): Promise<Awaited<ReturnType<typeof bookTrip>>> {
  const q = await quoteTravel(ctx, userId, DEST, now);
  return bookTrip(ctx, userId, { quoteId: q.quoteId, mode }, key, now);
}

beforeEach(() => setTravelConfigForTests(null));
afterEach(() => setTravelConfigForTests(null));

afterAll(async () => {
  for (const u of users) {
    await redis.hdel(POS_HASH, u);
    await redis.del(travelTicketKey(u));
  }
  await pool.end();
});

describe('fares, ride times and arrival points', () => {
  it('prices the taxi by distance between the floor and the cap, the bus flat', () => {
    const taxi = cfg.modes.taxi;
    expect(fareCents(taxi, 0)).toBe(500); // min
    expect(fareCents(taxi, 730)).toBe(400 + Math.ceil(7.3 * 80)); // ~$9.84 median
    expect(fareCents(taxi, 5_000)).toBe(1500); // cap
    expect(fareCents(cfg.modes.bus, 0)).toBe(200);
    expect(fareCents(cfg.modes.bus, 1_400)).toBe(200);
    expect(rideSeconds(cfg.modes.bus, 730)).toBe(Math.ceil(12 + 730 / 45));
    expect(rideSeconds(cfg.modes.taxi, 730)).toBe(Math.ceil(8 + 730 / 65));
  });

  it('puts every served arrival on land, inside its street room, 4.6 m outside the door', () => {
    const geo = getIslandGeometry();
    const notServed: string[] = [];
    for (const [id, v] of Object.entries(geo.venues ?? {})) {
      const a = arrivalFor(cfg, id)!;
      if (!a.served) {
        notServed.push(id);
        continue;
      }
      const { x, z, district } = a.arrival;
      expect(onLand(geo.island, x, z), id).toBe(true);
      const poly = geo.districts[district as DistrictId]!;
      expect(distanceToPolygon(poly, x, z), id).toBeLessThanOrEqual(STREET_BORDER_M);
      expect(Math.hypot(x - v.door[0], z - v.door[1])).toBeCloseTo(cfg.arrivalOffsetM, 1);
      // outside: farther from the venue's origin than its door
      const fromOrigin = (px: number, pz: number): number =>
        Math.hypot(px - v.origin[0], pz - v.origin[2]);
      expect(fromOrigin(x, z)).toBeGreaterThan(fromOrigin(v.door[0], v.door[1]));
      // facing the door: forward (sin yaw, cos yaw) points from the arrival to the door
      const fx = Math.sin(a.arrival.yaw);
      const fz = Math.cos(a.arrival.yaw);
      expect(fx * (v.door[0] - x) + fz * (v.door[1] - z)).toBeGreaterThan(4);
    }
    // ore_refinery's door is outside every district polygon in districts.json.
    expect(notServed).toEqual(['ore_refinery']);
    expect(Object.keys(geo.venues ?? {})).toHaveLength(21);
  });

  it('sends the travel block on GET /config only while the capability is on', () => {
    const off = { config: { capabilities: { on: new Set() } } } as never;
    const on = { config: { capabilities: { on: new Set(['travel']) } } } as never;
    expect(travelClientConfig(off)).toBeNull();
    const block = travelClientConfig(on)!;
    expect(block.walk).toEqual({ speedMps: 6 });
    expect((block.busStops as unknown[]).length).toBe(cfg.busStops.length);
  });
});

describe('quote', () => {
  it('prices walk, bus and taxi from the server position; the bus needs a stop', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const q = await quoteTravel(ctx, u, DEST);
    expect(q.to).toBe(DEST);
    expect(q.from.district).toBe('timeline');
    expect(q.gate).toEqual({ open: true });
    expect(q.cashCents).toBe(10_000);
    const by = Object.fromEntries(q.modes.map((m) => [m.mode, m]));
    expect(by.walk).toMatchObject({ available: true, fareCents: 0 });
    expect(by.bus).toMatchObject({ available: true, fareCents: 200 });
    expect(by.bus!.stop?.id).toBe('stop_timeline');
    expect(by.taxi!.available).toBe(true);
    expect(by.taxi!.fareCents).toBe(fareCents(cfg.modes.taxi, q.distanceM));

    // 100 m from the stop: the bus is not offered, the taxi is.
    await standAt(u, STOP.x - 100, STOP.z);
    const far = await quoteTravel(ctx, u, DEST);
    const farBus = far.modes.find((m) => m.mode === 'bus')!;
    expect(farBus).toMatchObject({ available: false, reason: 'NOT_AT_STOP' });
    expect(farBus.stop?.distanceM).toBeGreaterThan(cfg.busStopRadiusM);
    expect(far.modes.find((m) => m.mode === 'taxi')!.available).toBe(true);
  });

  it('refuses without a fresh position, for an unknown venue and while jailed', async () => {
    const u = await newUser(10_000);
    await expect(quoteTravel(ctx, u, DEST)).rejects.toBeInstanceOf(TravelNotInWorldError);
    await standAt(u, STOP.x, STOP.z, Date.now() - 31_000);
    await expect(quoteTravel(ctx, u, DEST)).rejects.toBeInstanceOf(TravelNotInWorldError);
    await standAt(u, STOP.x, STOP.z);
    await expect(quoteTravel(ctx, u, 'nowhere')).rejects.toBeInstanceOf(NotFoundError);

    await pool.query(
      `INSERT INTO player_jail (user_id, jail_id, jailed_at, jailed_until, bail_cents, heat_at_arrest)
       VALUES ($1, $2, now(), now() + interval '1 hour', 500, 1)`,
      [u, uuidv7()],
    );
    await expect(quoteTravel(ctx, u, DEST)).rejects.toBeInstanceOf(JailedError);

    const s = await newUser(10_000);
    await standAt(s, STOP.x, STOP.z);
    await pool.query(`UPDATE users SET is_sybil_jailed = true WHERE id = $1`, [s]);
    await expect(quoteTravel(ctx, s, DEST)).rejects.toBeInstanceOf(SybilJailedError);
  });

  it('marks rides too close, not served, locked and unaffordable', async () => {
    const u = await newUser(100);
    await standAt(u, STOP.x, STOP.z);
    const broke = await quoteTravel(ctx, u, DEST);
    expect(broke.modes.find((m) => m.mode === 'bus')!.reason).toBe('INSUFFICIENT_CASH');

    const door = getIslandGeometry().venues!.timeline_square!.door;
    await standAt(u, door[0] + 10, door[1]);
    const near = await quoteTravel(ctx, u, 'timeline_square');
    expect(near.modes.find((m) => m.mode === 'taxi')!.reason).toBe('TOO_CLOSE');
    expect(near.modes.find((m) => m.mode === 'walk')!.available).toBe(true);

    await standAt(u, STOP.x, STOP.z);
    const ore = await quoteTravel(ctx, u, 'ore_refinery');
    expect(ore.modes.find((m) => m.mode === 'taxi')!.reason).toBe('NOT_SERVED');

    setTravelConfigForTests({
      ...cfg,
      modes: { ...cfg.modes, taxi: { ...cfg.modes.taxi, unlockNetWorthCents: 1_000_000 } },
    });
    const rich = await newUser(10_000);
    await standAt(rich, STOP.x, STOP.z);
    const locked = await quoteTravel(ctx, rich, DEST);
    expect(locked.modes.find((m) => m.mode === 'taxi')).toMatchObject({
      available: false,
      reason: 'LOCKED',
      unlockNetWorthCents: 1_000_000,
    });
    expect(locked.modes.find((m) => m.mode === 'bus')!.available).toBe(true);
  });

  it('warns about a gated door by default and refuses it with gatedBooking refuse', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const warn = await quoteTravel(ctx, u, 'cabal_lounge');
    expect(warn.gate).toMatchObject({ open: false, code: 'NOT_A_MEMBER' });
    expect(warn.modes.find((m) => m.mode === 'taxi')!.available).toBe(true);

    setTravelConfigForTests({ ...cfg, gatedBooking: 'refuse' } as TravelConfig);
    const refuse = await quoteTravel(ctx, u, 'cabal_lounge');
    expect(refuse.modes.find((m) => m.mode === 'taxi')!.reason).toBe('VENUE_GATED');
    await expect(
      bookTrip(ctx, u, { quoteId: refuse.quoteId, mode: 'taxi' }, uuidv7()),
    ).rejects.toBeInstanceOf(VenueGatedError);
    expect(await cashOf(u)).toBe(10_000);
  });
});

describe('book', () => {
  it('debits the fare once, writes the ledger and the ticket; a replay returns the same trip', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const now = new Date();
    const key = uuidv7();
    const trip = await quoteAndBook(u, 'taxi', now, key);
    expect(trip.status).toBe('booked');
    expect(trip.mode).toBe('taxi');
    expect(trip.cashCents).toBe(10_000 - trip.fareCents);
    expect(await cashOf(u)).toBe(10_000 - trip.fareCents);
    expect(new Date(trip.arriveAt).getTime() - now.getTime()).toBe(
      rideSeconds(
        cfg.modes.taxi,
        Math.round(Math.hypot(-299.99 - STOP.x, -194.53 - STOP.z) * 1.3),
      ) * 1000,
    );
    expect(new Date(trip.expiresAt).getTime() - new Date(trip.arriveAt).getTime()).toBe(120_000);
    expect(await ledgerSum(u, 'travel_fare')).toEqual({ n: 1, sum: -trip.fareCents });

    const t = JSON.parse((await redis.get(travelTicketKey(u)))!) as TravelTicket;
    expect(t).toMatchObject({ tripId: trip.tripId, district: trip.arrival.district });

    // Replay with the same key (the quote is gone): the same trip, no second charge.
    const again = await bookTrip(ctx, u, { quoteId: uuidv7(), mode: 'taxi' }, key, now);
    expect(again.tripId).toBe(trip.tripId);
    expect(await ledgerSum(u, 'travel_fare')).toEqual({ n: 1, sum: -trip.fareCents });

    expect((await currentTrip(ctx, u)).trip?.tripId).toBe(trip.tripId);
  });

  it('lets only one of two concurrent bookings win', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const q = await quoteTravel(ctx, u, DEST);
    const results = await Promise.allSettled([
      bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'bus' }, uuidv7()),
      bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'bus' }, uuidv7()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(TravelInProgressError);
    expect(await cashOf(u)).toBe(10_000 - 200);
    expect((await ledgerSum(u, 'travel_fare')).n).toBe(1);
  });

  it('refuses short cash, a bus away from a stop, a moved player and a stale or foreign quote', async () => {
    const poor = await newUser(150);
    await standAt(poor, STOP.x, STOP.z);
    await expect(quoteAndBook(poor, 'bus')).rejects.toBeInstanceOf(InsufficientCashError);
    expect(await cashOf(poor)).toBe(150);

    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const q = await quoteTravel(ctx, u, DEST);
    // Walked 30 m after the quote: more than the 20 m drift.
    await standAt(u, STOP.x, STOP.z + 30);
    await expect(
      bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'bus' }, uuidv7()),
    ).rejects.toBeInstanceOf(QuoteExpiredError);
    await standAt(u, STOP.x - 60, STOP.z);
    const q2 = await quoteTravel(ctx, u, DEST);
    await expect(
      bookTrip(ctx, u, { quoteId: q2.quoteId, mode: 'bus' }, uuidv7()),
    ).rejects.toBeInstanceOf(TravelNotAtStopError);

    const other = await newUser(10_000);
    await standAt(other, STOP.x - 60, STOP.z);
    await expect(
      bookTrip(ctx, other, { quoteId: q2.quoteId, mode: 'taxi' }, uuidv7()),
    ).rejects.toBeInstanceOf(QuoteExpiredError);
    const late = new Date(Date.now() + 61_000);
    await standAt(u, STOP.x - 60, STOP.z, late.getTime());
    await expect(
      bookTrip(ctx, u, { quoteId: q2.quoteId, mode: 'taxi' }, uuidv7(), late),
    ).rejects.toBeInstanceOf(QuoteExpiredError);
    expect(await cashOf(u)).toBe(10_000);
  });

  it('refuses a locked mode at booking too', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const q = await quoteTravel(ctx, u, DEST);
    setTravelConfigForTests({
      ...cfg,
      modes: { ...cfg.modes, taxi: { ...cfg.modes.taxi, unlockNetWorthCents: 1_000_000 } },
    });
    await expect(
      bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'taxi' }, uuidv7()),
    ).rejects.toBeInstanceOf(TravelLockedError);
  });

  it('applies the cooldown after a ride ends and the hourly limit', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'bus');
    await cancelTrip(ctx, u, trip.tripId);
    const q = await quoteTravel(ctx, u, DEST);
    expect(q.modes.find((m) => m.mode === 'bus')).toMatchObject({ reason: 'COOLDOWN' });
    const err = await bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'bus' }, uuidv7()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TravelCooldownError);
    expect((err as TravelCooldownError).retryAfterMs).toBeGreaterThan(0);
    expect((err as TravelCooldownError).retryAfterMs).toBeLessThanOrEqual(10_000);
    // 11 s later the cooldown is over.
    const later = new Date(Date.now() + 11_000);
    await standAt(u, STOP.x, STOP.z, later.getTime());
    const ok = await quoteAndBook(u, 'bus', later);
    expect(ok.status).toBe('booked');

    // 30 trips in the last hour: no more.
    const h = await newUser(10_000);
    await standAt(h, STOP.x, STOP.z);
    for (let i = 0; i < cfg.tripsPerHour; i++) {
      const at = new Date(Date.now() - 50 * 60_000 + i * 1000);
      await pool.query(
        `INSERT INTO travel_trips (trip_id, user_id, mode, to_id, fare_cents, status, distance_m,
           origin_district, origin_x, origin_z, arrival_district, arrival_x, arrival_z, arrival_yaw,
           depart_at, arrive_at, expires_at, arrived_at, created_at)
         VALUES ($1, $2, 'bus', $3, 200, 'arrived', 500, 'timeline', 0, 0, 'trenches', 0, 0, 0,
           $4, $4, $4::timestamptz + interval '2 minutes', $4, $4)`,
        [uuidv7(), h, DEST, at],
      );
    }
    const hq = await quoteTravel(ctx, h, DEST);
    const bus = hq.modes.find((m) => m.mode === 'bus')!;
    expect(bus.reason).toBe('COOLDOWN');
    expect(bus.retryAfterSec).toBeGreaterThan(9 * 60);
  });
});

describe('arrival ticket', () => {
  it('opens at arriveAt, works once, only for its trip, district and user', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'taxi');
    const arriveAt = new Date(trip.arriveAt).getTime();
    const d = trip.arrival.district;
    expect(await hasOpenTicket(redis, u, Date.now())).toBe(true);

    const early = await consumeTicket(redis, cfg, u, trip.tripId, d, arriveAt - 5_000);
    expect(early).toMatchObject({ ok: false, code: 'TRAVEL_NOT_ARRIVED' });
    expect(await consumeTicket(redis, cfg, u, uuidv7(), d, arriveAt)).toMatchObject({
      ok: false,
      code: 'TRAVEL_TICKET_INVALID',
    });
    expect(await consumeTicket(redis, cfg, u, trip.tripId, 'islet', arriveAt)).toMatchObject({
      ok: false,
      code: 'TRAVEL_TICKET_INVALID',
    });
    const thief = await newUser(0);
    expect(await consumeTicket(redis, cfg, thief, trip.tripId, d, arriveAt)).toMatchObject({
      ok: false,
      code: 'TRAVEL_TICKET_INVALID',
    });

    // 1 s early is accepted (arriveEarlySec), once.
    const used = await consumeTicket(redis, cfg, u, trip.tripId, d, arriveAt - 900);
    expect(used.ok).toBe(true);
    expect(await consumeTicket(redis, cfg, u, trip.tripId, d, arriveAt)).toMatchObject({
      ok: false,
      code: 'TRAVEL_TICKET_INVALID',
    });
    expect(await hasOpenTicket(redis, u, Date.now())).toBe(false);
    expect(used.ok && (await markArrived(ctx, u, used.ticket))).toBe(true);
    expect((await currentTrip(ctx, u)).trip).toBeNull();

    // An arrived trip is never cancelled or refunded.
    await expect(cancelTrip(ctx, u, trip.tripId)).rejects.toBeInstanceOf(TravelNotCancellableError);
    await sweepTravelTrips(ctx, new Date(new Date(trip.expiresAt).getTime() + 61_000));
    expect((await ledgerSum(u, 'travel_refund')).n).toBe(0);
  });

  it('refuses a ticket after expiresAt', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'bus');
    const late = new Date(trip.expiresAt).getTime() + 1;
    expect(
      await consumeTicket(redis, cfg, u, trip.tripId, trip.arrival.district, late),
    ).toMatchObject({ ok: false, code: 'TRAVEL_TICKET_INVALID' });
  });
});

describe('cancel and sweep', () => {
  it('cancel refunds in full once and deletes the ticket', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'taxi');
    const out = await cancelTrip(ctx, u, trip.tripId);
    expect(out).toEqual({ tripId: trip.tripId, refundedCents: trip.fareCents, cashCents: 10_000 });
    expect(await cashOf(u)).toBe(10_000);
    expect(await redis.get(travelTicketKey(u))).toBeNull();
    await expect(cancelTrip(ctx, u, trip.tripId)).rejects.toBeInstanceOf(TravelNotCancellableError);
    expect(await ledgerSum(u, 'travel_refund')).toEqual({ n: 1, sum: trip.fareCents });

    const stranger = await newUser(0);
    await expect(cancelTrip(ctx, stranger, trip.tripId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('cannot cancel once arriveAt has passed', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'bus');
    await expect(
      cancelTrip(ctx, u, trip.tripId, new Date(new Date(trip.arriveAt).getTime() + 1)),
    ).rejects.toBeInstanceOf(TravelNotCancellableError);
  });

  it('the sweep refunds an expired trip exactly once, even run twice at once', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'taxi');
    // Not yet expired: nothing.
    await sweepTravelTrips(ctx, new Date(trip.arriveAt));
    expect(await cashOf(u)).toBe(10_000 - trip.fareCents);

    // Inside the 60 s grace after expiresAt: still nothing.
    await sweepTravelTrips(ctx, new Date(new Date(trip.expiresAt).getTime() + 30_000));
    expect(await cashOf(u)).toBe(10_000 - trip.fareCents);
    const after = new Date(new Date(trip.expiresAt).getTime() + 61_000);
    await Promise.all([sweepTravelTrips(ctx, after), sweepTravelTrips(ctx, after)]);
    await sweepTravelTrips(ctx, after);
    expect(await cashOf(u)).toBe(10_000);
    expect(await ledgerSum(u, 'travel_refund')).toEqual({ n: 1, sum: trip.fareCents });
    const r = await pool.query<{ status: string }>(
      `SELECT status FROM travel_trips WHERE trip_id = $1`,
      [trip.tripId],
    );
    expect(r.rows[0]!.status).toBe('expired_refunded');
    expect(await redis.get(travelTicketKey(u))).toBeNull();
    expect((await currentTrip(ctx, u)).trip).toBeNull();
  });
});

describe('security: ride XOR refund (review of PR #82)', () => {
  const at = (iso: string, deltaMs: number): Date => new Date(new Date(iso).getTime() + deltaMs);
  const statusOf = async (tripId: string): Promise<string> =>
    (
      await pool.query<{ status: string }>(`SELECT status FROM travel_trips WHERE trip_id = $1`, [
        tripId,
      ])
    ).rows[0]!.status;

  it('refuses arrive-then-cancel: the windows do not overlap and a used ticket blocks cancel', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'taxi');
    // Exactly at the cutoff (arriveAt - arriveEarlySec) a cancel is already refused.
    await expect(cancelTrip(ctx, u, trip.tripId, at(trip.arriveAt, -1_000))).rejects.toBeInstanceOf(
      TravelNotCancellableError,
    );
    const used = await consumeTicket(
      redis,
      cfg,
      u,
      trip.tripId,
      trip.arrival.district,
      new Date(trip.arriveAt).getTime() - 900,
    );
    expect(used.ok).toBe(true);
    expect(await markArrived(ctx, u, { tripId: trip.tripId }, at(trip.arriveAt, -900))).toBe(true);
    // Even with a clock before the cutoff, an arrived trip cannot be cancelled.
    await expect(cancelTrip(ctx, u, trip.tripId, new Date())).rejects.toBeInstanceOf(
      TravelNotCancellableError,
    );
    expect(await ledgerSum(u, 'travel_refund')).toEqual({ n: 0, sum: 0 });
    expect(await cashOf(u)).toBe(10_000 - trip.fareCents);
  });

  it('refuses a cancel once the ticket was taken, even before the row says arrived', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'bus');
    expect(
      (
        await consumeTicket(
          redis,
          cfg,
          u,
          trip.tripId,
          trip.arrival.district,
          new Date(trip.arriveAt).getTime(),
        )
      ).ok,
    ).toBe(true);
    const err = await cancelTrip(ctx, u, trip.tripId, new Date()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TravelNotCancellableError);
    expect((err as TravelNotCancellableError).details.reason).toBe('ticket_gone');
    expect(await statusOf(trip.tripId)).toBe('booked');
    expect(await cashOf(u)).toBe(10_000 - 200);
  });

  it('refuses cancel-then-arrive: no ticket and the guarded update finds no booked trip', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'taxi');
    await cancelTrip(ctx, u, trip.tripId);
    const arriveAt = new Date(trip.arriveAt).getTime();
    expect(
      await consumeTicket(redis, cfg, u, trip.tripId, trip.arrival.district, arriveAt),
    ).toMatchObject({
      ok: false,
      code: 'TRAVEL_TICKET_INVALID',
    });
    expect(await markArrived(ctx, u, { tripId: trip.tripId }, new Date(arriveAt))).toBe(false);
    expect(await statusOf(trip.tripId)).toBe('cancelled');
    expect(await ledgerSum(u, 'travel_refund')).toEqual({ n: 1, sum: trip.fareCents });
  });

  it('an arrival whose DB update failed gives no ride and the sweep refunds it later', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'taxi');
    // The ticket was taken, then the guarded UPDATE failed (the room refuses the placement).
    expect(
      (
        await consumeTicket(
          redis,
          cfg,
          u,
          trip.tripId,
          trip.arrival.district,
          new Date(trip.arriveAt).getTime(),
        )
      ).ok,
    ).toBe(true);
    expect(await statusOf(trip.tripId)).toBe('booked');
    // Too late to mark it arrived after expiresAt.
    expect(await markArrived(ctx, u, { tripId: trip.tripId }, at(trip.expiresAt, 0))).toBe(false);
    await sweepTravelTrips(ctx, at(trip.expiresAt, SWEEP_GRACE_MS + 1_000));
    expect(await statusOf(trip.tripId)).toBe('expired_refunded');
    expect(await ledgerSum(u, 'travel_refund')).toEqual({ n: 1, sum: trip.fareCents });
    expect(await cashOf(u)).toBe(10_000);
  });

  it('a sweep racing an arrival gives exactly one outcome', async () => {
    for (let i = 0; i < 4; i++) {
      const u = await newUser(10_000);
      await standAt(u, STOP.x, STOP.z);
      const trip = await quoteAndBook(u, 'taxi');
      // Skewed clocks: the room thinks it is arriveAt, the worker thinks the grace has passed.
      const [arrived] = await Promise.all([
        markArrived(ctx, u, { tripId: trip.tripId }, new Date(trip.arriveAt)),
        sweepTravelTrips(ctx, at(trip.expiresAt, SWEEP_GRACE_MS + 1_000)),
      ]);
      const status = await statusOf(trip.tripId);
      const refunds = await ledgerSum(u, 'travel_refund');
      if (arrived) {
        expect(status).toBe('arrived');
        expect(refunds.n).toBe(0);
        expect(await cashOf(u)).toBe(10_000 - trip.fareCents);
      } else {
        expect(status).toBe('expired_refunded');
        expect(refunds).toEqual({ n: 1, sum: trip.fareCents });
        expect(await cashOf(u)).toBe(10_000);
      }
    }
  });

  it('two cancels at once refund once', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'taxi');
    const results = await Promise.allSettled([
      cancelTrip(ctx, u, trip.tripId),
      cancelTrip(ctx, u, trip.tripId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toBeInstanceOf(TravelNotCancellableError);
    expect(await ledgerSum(u, 'travel_refund')).toEqual({ n: 1, sum: trip.fareCents });
    expect(await cashOf(u)).toBe(10_000);
  });

  it('refuses a ticket at exactly expiresAt', async () => {
    const u = await newUser(10_000);
    await standAt(u, STOP.x, STOP.z);
    const trip = await quoteAndBook(u, 'bus');
    const exp = new Date(trip.expiresAt).getTime();
    expect(
      await consumeTicket(redis, cfg, u, trip.tripId, trip.arrival.district, exp),
    ).toMatchObject({
      ok: false,
      code: 'TRAVEL_TICKET_INVALID',
    });
    expect(await hasOpenTicket(redis, u, exp)).toBe(false);
    expect(
      (await consumeTicket(redis, cfg, u, trip.tripId, trip.arrival.district, exp - 1)).ok,
    ).toBe(true);
  });

  it('refuses booking for a Sybil-jailed or CT-jailed player before charging', async () => {
    const s = await newUser(10_000);
    await standAt(s, STOP.x, STOP.z);
    const q = await quoteTravel(ctx, s, DEST);
    await pool.query(`UPDATE users SET is_sybil_jailed = true WHERE id = $1`, [s]);
    await expect(
      bookTrip(ctx, s, { quoteId: q.quoteId, mode: 'taxi' }, uuidv7()),
    ).rejects.toBeInstanceOf(SybilJailedError);
    expect(await cashOf(s)).toBe(10_000);

    const j = await newUser(10_000);
    await standAt(j, STOP.x, STOP.z);
    const qj = await quoteTravel(ctx, j, DEST);
    await pool.query(
      `INSERT INTO player_jail (user_id, jail_id, jailed_at, jailed_until, bail_cents, heat_at_arrest)
       VALUES ($1, $2, now(), now() + interval '1 hour', 500, 1)`,
      [j, uuidv7()],
    );
    await expect(
      bookTrip(ctx, j, { quoteId: qj.quoteId, mode: 'taxi' }, uuidv7()),
    ).rejects.toBeInstanceOf(JailedError);
    expect(await cashOf(j)).toBe(10_000);
    expect((await ledgerSum(j, 'travel_fare')).n).toBe(0);
  });
});
