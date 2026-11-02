/**
 * Map Travel phase 3, the helicopter (docs/TRAVEL.md), against the real test Postgres and
 * Redis: eligibility by pad home, pickup pad (own home pad first, else a public pad within
 * the radius), arrival on the public pad nearest the door, the flat fare, booking re-checks
 * in the locked transaction, the ticket at the arrival pad, the capability gate, and the
 * ride-XOR-refund rules for heli trips.
 */
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  CapabilityOffError,
  NeedsHelipadError,
  TravelNotAtPadError,
  TravelNotCancellableError,
} from '../shared/domain/errors.js';
import { encodePos, getIslandGeometry, POS_HASH } from '../realtime/movement.js';
import {
  bookTrip,
  cancelTrip,
  consumeTicket,
  getTravelConfig,
  markArrived,
  quoteTravel,
  streetDistrictAt,
  sweepTravelTrips,
  SWEEP_GRACE_MS,
  travelClientConfig,
  travelTicketKey,
  type QuoteMode,
  type TravelTicket,
} from './travel.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const base = buildContext();
/** The same context with `travel` and `travelHeli` on (as a deployment listing both). */
const ctx: AppContext = {
  ...base,
  config: {
    ...base.config,
    capabilities: { ...base.config.capabilities, on: new Set(['travel', 'travelHeli'] as const) },
  },
};
/** `travel` on, `travelHeli` off. */
const groundOnly: AppContext = {
  ...base,
  config: {
    ...base.config,
    capabilities: { ...base.config.capabilities, on: new Set(['travel'] as const) },
  },
};
const redis = base.redis.main;
const cfg = getTravelConfig();
const pad = (id: string) =>
  cfg.heliPads.find((p) => p.id === id) ?? Object.values(cfg.homePads).find((p) => p.id === id)!;
const HOME_PH = cfg.homePads.penthouse!;
const MOUNTAIN = pad('pad_mountain');
const BREAKPOINT = pad('pad_breakpoint');
const DEST = 'hackathon_house'; // nearest public pad: pad_mountain
const users: string[] = [];

async function newUser(cashCents: number, homeKind?: string): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `heli-${id}`]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = 0`,
    [id, cashCents],
  );
  if (homeKind) {
    await pool.query(
      `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, status)
       VALUES ($1, $2, $3, 150000, 'active')`,
      [`heli-home-${id}`, id, homeKind],
    );
  }
  users.push(id);
  return id;
}

const standAt = (u: string, x: number, z: number, at = Date.now()) =>
  redis.hset(POS_HASH, u, encodePos({ x, z, at }));
const cashOf = async (u: string): Promise<number> =>
  Number(
    (
      await pool.query<{ c: string }>(`SELECT cash_cents AS c FROM balances WHERE user_id = $1`, [
        u,
      ])
    ).rows[0]?.c ?? 0,
  );
const ledger = async (u: string, reason: string) => {
  const r = await pool.query<{ n: string; s: string | null }>(
    `SELECT COUNT(*)::text AS n, SUM(delta_cents)::text AS s FROM ledger_entries
      WHERE user_id = $1 AND reason = $2`,
    [u, reason],
  );
  return { n: Number(r.rows[0]!.n), sum: Number(r.rows[0]!.s ?? 0) };
};
const heliRow = (modes: QuoteMode[]): QuoteMode | undefined => modes.find((m) => m.mode === 'heli');

afterAll(async () => {
  for (const u of users) {
    await redis.hdel(POS_HASH, u);
    await redis.del(travelTicketKey(u));
  }
  await pool.end();
});

describe('helicopter config', () => {
  it('puts every pad (public and home) inside the street room of its district', () => {
    for (const p of [...cfg.heliPads, ...Object.values(cfg.homePads)]) {
      expect(streetDistrictAt(p.x, p.z), p.id).toBe(p.district);
    }
    expect(cfg.modes.heli).toMatchObject({ minCents: 15_000, capCents: 15_000, pickup: 'pad' });
    expect(cfg.heliHomeKinds).toEqual(['penthouse', 'marina_villa']);
  });

  it('sends pads and the heli flag on GET /config', () => {
    const on = travelClientConfig(ctx)!;
    expect(on.heli).toBe(true);
    expect(on.heliPads).toEqual(cfg.heliPads);
    expect(on.homePads).toEqual(cfg.homePads);
    expect(on.heliPadRadiusM).toBe(15);
    expect((on.modes as Record<string, unknown>).heli).toBeDefined();
    expect(travelClientConfig(groundOnly)!.heli).toBe(false);
  });
});

describe('helicopter quote', () => {
  it.each([
    ['timeline_square', 'pad_genesis_park', 82],
    ['spaces_studio', 'pad_genesis_park', 123],
    ['discord_heights', 'pad_genesis_park', 113],
    ['ct_jail', 'pad_boardwalk', 132],
  ])(
    'lands downtown flights close: %s on %s (~%i m from the door)',
    async (venue, padId, metres) => {
      const u = await newUser(1_000_000, 'penthouse');
      await standAt(u, HOME_PH.x, HOME_PH.z);
      const h = heliRow((await quoteTravel(ctx, u, venue)).modes)!;
      const landing = pad(padId);
      expect(h.available).toBe(true);
      expect(h.arrival).toMatchObject({ x: landing.x, z: landing.z, district: landing.district });
      const door = getIslandGeometry().venues![venue]!.door;
      const d = Math.hypot(door[0] - landing.x, door[1] - landing.z);
      expect(d).toBeLessThanOrEqual(150);
      expect(Math.round(d)).toBe(metres);
    },
  );

  it('needs a pad home: a non-owner on a public pad gets NEEDS_HELIPAD', async () => {
    const u = await newUser(1_000_000);
    await standAt(u, BREAKPOINT.x, BREAKPOINT.z);
    const q = await quoteTravel(ctx, u, DEST);
    const h = heliRow(q.modes)!;
    expect(h).toMatchObject({ available: false, reason: 'NEEDS_HELIPAD', fareCents: 15_000 });
    expect(h.pickup).toBeUndefined();
    expect(h.arrival).toMatchObject({ x: MOUNTAIN.x, z: MOUNTAIN.z, district: 'mountain' });
  });

  it('an owner at their home pad flies from it to the public pad nearest the door, flat fare', async () => {
    const u = await newUser(1_000_000, 'penthouse');
    await standAt(u, HOME_PH.x + 5, HOME_PH.z);
    const q = await quoteTravel(ctx, u, DEST);
    const h = heliRow(q.modes)!;
    expect(h.available).toBe(true);
    expect(h.reason).toBeUndefined();
    expect(h.pickup).toEqual({ id: HOME_PH.id, x: HOME_PH.x, z: HOME_PH.z });
    const d = Math.round(Math.hypot(MOUNTAIN.x - HOME_PH.x, MOUNTAIN.z - HOME_PH.z));
    expect(h.fareCents).toBe(15_000);
    expect(h.durationSec).toBe(Math.ceil(10 + d / 80));
    const door = getIslandGeometry().venues![DEST]!.door;
    expect(h.arrival).toMatchObject({ district: 'mountain', x: MOUNTAIN.x, z: MOUNTAIN.z });
    // facing the door
    expect(
      Math.sin(h.arrival!.yaw) * (door[0] - MOUNTAIN.x) +
        Math.cos(h.arrival!.yaw) * (door[1] - MOUNTAIN.z),
    ).toBeGreaterThan(0);
    // ground modes keep their own arrival (the street outside the door)
    expect(q.arrival).not.toMatchObject({ x: MOUNTAIN.x, z: MOUNTAIN.z });
  });

  it('away from every pad is NOT_AT_PAD with the nearest pad the owner may use', async () => {
    const u = await newUser(1_000_000, 'penthouse');
    const at = { x: 44.31, z: 6.07 }; // stop_timeline, downtown
    await standAt(u, at.x, at.z);
    const h = heliRow((await quoteTravel(ctx, u, DEST)).modes)!;
    expect(h).toMatchObject({ available: false, reason: 'NOT_AT_PAD' });
    const usable = [HOME_PH, ...cfg.heliPads];
    const nearest = usable.reduce((a, b) =>
      Math.hypot(a.x - at.x, a.z - at.z) <= Math.hypot(b.x - at.x, b.z - at.z) ? a : b,
    );
    expect(h.stop).toEqual({
      id: nearest.id,
      x: nearest.x,
      z: nearest.z,
      distanceM: Math.round(Math.hypot(nearest.x - at.x, nearest.z - at.z)),
    });
    expect(h.pickup).toBeUndefined();
  });

  it('an owner may board at a public pad; at the arrival pad itself it is TOO_CLOSE', async () => {
    const u = await newUser(1_000_000, 'marina_villa');
    await standAt(u, BREAKPOINT.x, BREAKPOINT.z + 3);
    const h = heliRow((await quoteTravel(ctx, u, DEST)).modes)!;
    expect(h.available).toBe(true);
    expect(h.pickup?.id).toBe('pad_breakpoint');

    await standAt(u, MOUNTAIN.x, MOUNTAIN.z);
    const near = heliRow((await quoteTravel(ctx, u, DEST)).modes)!;
    expect(near).toMatchObject({ available: false, reason: 'TOO_CLOSE' });
  });

  it('has no heli row while travelHeli is off, and booking heli is 503', async () => {
    const u = await newUser(1_000_000, 'penthouse');
    await standAt(u, HOME_PH.x, HOME_PH.z);
    const q = await quoteTravel(groundOnly, u, DEST);
    expect(heliRow(q.modes)).toBeUndefined();
    expect(q.modes.map((m) => m.mode)).toEqual(['walk', 'bus', 'taxi']);
    const err = await bookTrip(groundOnly, u, { quoteId: q.quoteId, mode: 'heli' }, uuidv7()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CapabilityOffError);
    expect((err as CapabilityOffError).httpStatus).toBe(503);
    expect((err as CapabilityOffError).details).toEqual({ capability: 'travelHeli' });
    expect(await cashOf(u)).toBe(1_000_000);
  });
});

describe('helicopter booking', () => {
  it('charges the flat fare once and tickets the arrival pad', async () => {
    const u = await newUser(1_000_000, 'penthouse');
    await standAt(u, HOME_PH.x, HOME_PH.z);
    const q = await quoteTravel(ctx, u, DEST);
    const trip = await bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'heli' }, uuidv7());
    expect(trip).toMatchObject({
      mode: 'heli',
      fareCents: 15_000,
      cashCents: 985_000,
      status: 'booked',
    });
    expect(trip.pickup).toEqual({ id: HOME_PH.id, x: HOME_PH.x, z: HOME_PH.z });
    expect(trip.origin).toEqual({ district: 'dubai_marina', x: HOME_PH.x, z: HOME_PH.z });
    expect(trip.arrival).toEqual(heliRow(q.modes)!.arrival);
    expect(await cashOf(u)).toBe(985_000);
    expect(await ledger(u, 'travel_fare')).toEqual({ n: 1, sum: -15_000 });

    const t = JSON.parse((await redis.get(travelTicketKey(u)))!) as TravelTicket;
    expect(t).toMatchObject({
      tripId: trip.tripId,
      district: 'mountain',
      x: MOUNTAIN.x,
      z: MOUNTAIN.z,
    });
    const used = await consumeTicket(
      redis,
      cfg,
      u,
      trip.tripId,
      'mountain',
      new Date(trip.arriveAt).getTime(),
    );
    expect(used.ok && used.ticket.x === MOUNTAIN.x && used.ticket.z === MOUNTAIN.z).toBe(true);
    expect(await markArrived(ctx, u, { tripId: trip.tripId }, new Date(trip.arriveAt))).toBe(true);
  });

  it('refuses after moving off the pad (TRAVEL_NOT_AT_PAD) with no charge', async () => {
    const u = await newUser(1_000_000, 'penthouse');
    await standAt(u, HOME_PH.x, HOME_PH.z);
    const q = await quoteTravel(ctx, u, DEST);
    await standAt(u, HOME_PH.x + 18, HOME_PH.z); // inside the 20 m drift, outside the 15 m pad radius
    const err = await bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'heli' }, uuidv7()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TravelNotAtPadError);
    expect((err as TravelNotAtPadError).details).toMatchObject({
      radiusM: 15,
      pad: { id: HOME_PH.id },
      distanceM: 18,
    });
    expect(await cashOf(u)).toBe(1_000_000);
    expect((await ledger(u, 'travel_fare')).n).toBe(0);
  });

  it('refuses when the pad home was lost between quote and book (NEEDS_HELIPAD) with no charge', async () => {
    const u = await newUser(1_000_000, 'penthouse');
    await standAt(u, HOME_PH.x, HOME_PH.z);
    const q = await quoteTravel(ctx, u, DEST);
    expect(heliRow(q.modes)!.available).toBe(true);
    await pool.query(`UPDATE homes SET status = 'evicted' WHERE owner_user_id = $1`, [u]);
    await expect(
      bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'heli' }, uuidv7()),
    ).rejects.toBeInstanceOf(NeedsHelipadError);
    expect(await cashOf(u)).toBe(1_000_000);
  });

  it('refuses the home pad of a kind the player no longer owns, even with another pad home', async () => {
    const u = await newUser(1_000_000, 'penthouse');
    await standAt(u, HOME_PH.x, HOME_PH.z);
    const q = await quoteTravel(ctx, u, DEST);
    await pool.query(`UPDATE homes SET kind = 'marina_villa' WHERE owner_user_id = $1`, [u]);
    const err = await bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'heli' }, uuidv7()).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NeedsHelipadError);
    expect((err as NeedsHelipadError).details).toMatchObject({ reason: 'pad_not_yours' });
  });
});

describe('helicopter: ride XOR refund', () => {
  it('cannot be cancelled after arriving', async () => {
    const u = await newUser(1_000_000, 'penthouse');
    await standAt(u, HOME_PH.x, HOME_PH.z);
    const q = await quoteTravel(ctx, u, DEST);
    const trip = await bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'heli' }, uuidv7());
    expect(
      (
        await consumeTicket(
          redis,
          cfg,
          u,
          trip.tripId,
          'mountain',
          new Date(trip.arriveAt).getTime(),
        )
      ).ok,
    ).toBe(true);
    expect(await markArrived(ctx, u, { tripId: trip.tripId }, new Date(trip.arriveAt))).toBe(true);
    await expect(cancelTrip(ctx, u, trip.tripId, new Date())).rejects.toBeInstanceOf(
      TravelNotCancellableError,
    );
    await sweepTravelTrips(
      ctx,
      new Date(new Date(trip.expiresAt).getTime() + SWEEP_GRACE_MS + 1_000),
    );
    expect((await ledger(u, 'travel_refund')).n).toBe(0);
    expect(await cashOf(u)).toBe(985_000);
  });

  it('a cancel refunds 150 once and the ticket is gone; an unused flight is refunded by the sweep once', async () => {
    const u = await newUser(1_000_000, 'penthouse');
    await standAt(u, HOME_PH.x, HOME_PH.z);
    const q = await quoteTravel(ctx, u, DEST);
    const trip = await bookTrip(ctx, u, { quoteId: q.quoteId, mode: 'heli' }, uuidv7());
    expect(await cancelTrip(ctx, u, trip.tripId)).toMatchObject({
      refundedCents: 15_000,
      cashCents: 1_000_000,
    });
    expect(
      await consumeTicket(
        redis,
        cfg,
        u,
        trip.tripId,
        'mountain',
        new Date(trip.arriveAt).getTime(),
      ),
    ).toMatchObject({ ok: false, code: 'TRAVEL_TICKET_INVALID' });

    const v = await newUser(1_000_000, 'marina_villa');
    const villa = cfg.homePads.marina_villa!;
    await standAt(v, villa.x, villa.z);
    const qv = await quoteTravel(ctx, v, DEST);
    const tv = await bookTrip(ctx, v, { quoteId: qv.quoteId, mode: 'heli' }, uuidv7());
    const after = new Date(new Date(tv.expiresAt).getTime() + SWEEP_GRACE_MS + 1_000);
    await Promise.all([sweepTravelTrips(ctx, after), sweepTravelTrips(ctx, after)]);
    expect(await ledger(v, 'travel_refund')).toEqual({ n: 1, sum: 15_000 });
    expect(await cashOf(v)).toBe(1_000_000);
  });
});
