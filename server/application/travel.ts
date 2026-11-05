/**
 * Map Travel phase 1 (docs/TRAVEL.md): server-priced bus and taxi rides between CT Island
 * venues, plus the free walk.
 *
 *   quoteTravel   GET  /v1/travel/quote?to=<venueId>
 *   bookTrip      POST /v1/travel/trips            (Idempotency-Key)
 *   currentTrip   GET  /v1/travel/trips/current
 *   cancelTrip    POST /v1/travel/trips/:id/cancel (Idempotency-Key)
 *   consumeTicket the street room's `tripId` arrival (single use, server-timed)
 *   sweepTravelTrips  the travel-sweep worker (refund trips that expired unused)
 *
 * The client never sends a price, an origin or a distance. The origin is the player's last
 * accepted island position (`ctl:pos`, written by the street and vehicle rooms), which must
 * be fresh (POS_FRESH_MS). The distance is the straight line to the destination door in
 * contract/ids/districts.json times `roadFactor`. Fares and ride times come from
 * contract/config/travel.json and are flat per mode: net worth only unlocks modes.
 *
 * Booking mirrors the Duo Shop order (`placeOrder`): one transaction that locks the balance
 * row first (serialising this player's bookings), finds a replay by the ledger's unique
 * `idempotency_ref`, checks the open trip, cooldown, hourly limit and cash, inserts the trip,
 * debits the balance and writes the ledger row (`travel_fare`). After the commit a single-use
 * ticket `ctl:travel:<userId>` is written to Redis; the street room accepts it from
 * `arriveAt - arriveEarlySec` until `expiresAt` and deletes it as it anchors the player at the
 * arrival point, a street spot outside the destination door. Entry into the venue is still the
 * normal walk-in and the venue room's own gate. A trip never arrived is refunded in full by
 * the sweep (`travel_refund`, exactly once by its own idempotency_ref).
 */
import type { PoolClient } from 'pg';
import { TRAVEL_JOIN_ERROR_CODES } from '../../contract/realtime/messages.js';
import { runInTransaction } from '../shared/db/uow.js';
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
  ValidationFailedError,
  VenueGatedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  decodePos,
  distanceToPolygon,
  getIslandGeometry,
  onLand,
  POS_FRESH_MS,
  POS_HASH,
  type DistrictId,
  type IslandPos,
} from '../realtime/movement.js';
import type { AppContext } from './context.js';
import { isCapabilityOn } from './capabilities.js';
import { activeJail, assertNotJailed } from './heat.js';
import { isSybilJailed } from './sybil-jail.js';
import { getVenueAccess } from './venues-gating.js';
import { readContractJson } from './rewards.js';

// --- Config -----------------------------------------------------------

export const RIDE_MODES = ['bus', 'taxi'] as const;
export type RideMode = (typeof RIDE_MODES)[number];
export type TravelMode = 'walk' | RideMode;

export interface RideModeConfig {
  readonly baseCents: number;
  readonly perHundredMCents: number;
  readonly minCents: number;
  readonly capCents: number;
  readonly baseSec: number;
  readonly speedMps: number;
  readonly unlockNetWorthCents: number;
  readonly pickup: 'stop' | 'anywhere';
}

export interface BusStop {
  readonly id: string;
  readonly district: string;
  readonly x: number;
  readonly z: number;
  /** Degrees clockwise from north, the open side of the shelter (towards the road). */
  readonly yaw: number;
  readonly shelter: 'baked' | 'kit';
}

export interface TravelConfig {
  readonly version: string;
  readonly roadFactor: number;
  readonly minDistanceM: number;
  readonly quoteTtlSec: number;
  readonly bookDriftM: number;
  readonly ticketGraceSec: number;
  readonly arriveEarlySec: number;
  readonly cooldownSec: number;
  readonly tripsPerHour: number;
  readonly arrivalOffsetM: number;
  readonly gatedBooking: 'warn' | 'refuse';
  readonly walk: { readonly speedMps: number };
  readonly busStopRadiusM: number;
  readonly modes: Readonly<Record<RideMode, RideModeConfig>>;
  readonly busStops: readonly BusStop[];
}

let travelConfig: TravelConfig | null = null;

/** contract/config/travel.json, read once. */
export function getTravelConfig(): TravelConfig {
  if (!travelConfig) travelConfig = readContractJson<TravelConfig>('config', 'travel.json');
  return travelConfig;
}

/**
 * Replace the config (tests only).
 * @param c - Config to use, or null to re-read the file.
 */
export function setTravelConfigForTests(c: TravelConfig | null): void {
  travelConfig = c;
}

// --- Pure rules -------------------------------------------------------

/** How far outside its district polygon a street room still holds a player (street.ts STREET_BORDER_M). */
export const STREET_BORDER_M = 30;

/**
 * @param m - The mode's fare rules.
 * @param distanceM - Road distance, metres.
 * @returns Integer cents: base plus the per-100 m rate (rounded up), clamped to [min, cap].
 */
export function fareCents(m: RideModeConfig, distanceM: number): number {
  const raw = m.baseCents + Math.ceil((Math.max(0, distanceM) / 100) * m.perHundredMCents);
  return Math.min(m.capCents, Math.max(m.minCents, raw));
}

/**
 * @param m - The mode's speed rules.
 * @param distanceM - Road distance, metres.
 * @returns Whole seconds: `baseSec + distance / speed`, rounded up.
 */
export function rideSeconds(
  m: Pick<RideModeConfig, 'baseSec' | 'speedMps'>,
  distanceM: number,
): number {
  return Math.ceil(m.baseSec + Math.max(0, distanceM) / m.speedMps);
}

/**
 * @param cfg - Travel config.
 * @param distanceM - Road distance, metres.
 * @returns Seconds the auto-path walk takes at `walk.speedMps`.
 */
export function walkSeconds(cfg: TravelConfig, distanceM: number): number {
  return Math.ceil(Math.max(0, distanceM) / cfg.walk.speedMps);
}

/**
 * @param cfg - Travel config.
 * @param fromX - Origin x.
 * @param fromZ - Origin z.
 * @param toX - Door x.
 * @param toZ - Door z.
 * @returns Whole metres along the road (straight line times `roadFactor`).
 */
export function roadDistanceM(
  cfg: TravelConfig,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): number {
  return Math.round(Math.hypot(toX - fromX, toZ - fromZ) * cfg.roadFactor);
}

export interface StreetPoint {
  readonly district: string;
  readonly x: number;
  readonly z: number;
}

export interface Arrival extends StreetPoint {
  /** Radians (PlayerState.rotY: forward = (sin yaw, cos yaw)), facing the door. */
  readonly yaw: number;
}

/**
 * The district whose street room covers a point: the polygon it is in, else the nearest one
 * within the street border.
 * @param x - Island x.
 * @param z - Island z.
 * @returns The district, or null when no street room holds the point.
 */
export function streetDistrictAt(x: number, z: number): DistrictId | null {
  const geo = getIslandGeometry();
  if (!onLand(geo.island, x, z)) return null;
  let best: { id: DistrictId; d: number } | null = null;
  for (const [id, poly] of Object.entries(geo.districts) as Array<
    [DistrictId, (typeof geo.island)[number]]
  >) {
    if (!poly || poly.length < 3) continue;
    const d = distanceToPolygon(poly, x, z);
    if (d <= STREET_BORDER_M && (best === null || d < best.d)) best = { id, d };
  }
  return best?.id ?? null;
}

/**
 * The street point a ride to `venueId` ends on: the door plus `arrivalOffsetM` outward
 * (outward = from the venue's origin through its door), facing the door, so the rope
 * (0.6 m outside the walk rect) and the venue room's join gate still decide entry.
 * @param cfg - Travel config.
 * @param venueId - A venue in districts.json.
 * @returns The arrival, `served: false` when no street room covers that point (no ride is
 *   offered there), or null for an unknown venue.
 */
export function arrivalFor(
  cfg: TravelConfig,
  venueId: string,
): { arrival: Arrival; door: { x: number; z: number }; served: boolean } | null {
  const v = getIslandGeometry().venues?.[venueId];
  if (!v) return null;
  const [dx, dz] = v.door;
  let ox = dx - v.origin[0];
  let oz = dz - v.origin[2];
  const len = Math.hypot(ox, oz);
  if (len < 1e-3) {
    // Door on the origin: fall back to the venue's facing (local -Z is the front).
    const a = (v.yaw * Math.PI) / 180;
    ox = -Math.sin(a);
    oz = -Math.cos(a);
  } else {
    ox /= len;
    oz /= len;
  }
  const x = round2(dx + ox * cfg.arrivalOffsetM);
  const z = round2(dz + oz * cfg.arrivalOffsetM);
  const yaw = round4(Math.atan2(-ox, -oz));
  const district = streetDistrictAt(x, z);
  return {
    arrival: { district: district ?? v.district, x, z, yaw },
    door: { x: dx, z: dz },
    served: district !== null,
  };
}

/**
 * @param cfg - Travel config.
 * @param x - Island x.
 * @param z - Island z.
 * @returns The nearest bus stop and its distance (whole metres), or null with no stops.
 */
export function nearestBusStop(
  cfg: TravelConfig,
  x: number,
  z: number,
): { stop: BusStop; distanceM: number } | null {
  let best: { stop: BusStop; distanceM: number } | null = null;
  for (const s of cfg.busStops) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (best === null || d < best.distanceM) best = { stop: s, distanceM: d };
  }
  return best ? { stop: best.stop, distanceM: Math.round(best.distanceM) } : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// --- Redis keys -------------------------------------------------------

/** The single-use arrival ticket of a player's booked trip. */
export const travelTicketKey = (userId: string): string => `ctl:travel:${userId}`;
/** A stored quote (the booking prices from it). */
export const travelQuoteKey = (quoteId: string): string => `ctl:travel:quote:${quoteId}`;

export interface TravelTicket {
  readonly tripId: string;
  readonly district: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** ms */
  readonly arriveAt: number;
  /** ms */
  readonly expiresAt: number;
}

interface StoredQuote {
  readonly userId: string;
  readonly to: string;
  readonly from: StreetPoint;
  readonly distanceM: number;
  readonly arrival: Arrival;
  readonly served: boolean;
  readonly fares: Record<RideMode, number>;
  readonly durations: Record<RideMode, number>;
  readonly createdAt: number;
}

// --- Shapes -----------------------------------------------------------

export type ModeReason =
  | 'TOO_CLOSE'
  | 'NOT_AT_STOP'
  | 'INSUFFICIENT_CASH'
  | 'LOCKED'
  | 'COOLDOWN'
  | 'TRAVEL_IN_PROGRESS'
  | 'VENUE_GATED'
  | 'NOT_SERVED';

export interface QuoteMode {
  readonly mode: TravelMode;
  readonly available: boolean;
  readonly reason?: ModeReason;
  readonly reasonMessage?: string;
  readonly fareCents: number;
  readonly durationSec: number;
  readonly stop?: { id: string; x: number; z: number; yaw: number; distanceM: number };
  readonly unlockNetWorthCents?: number;
  readonly retryAfterSec?: number;
}

export interface TravelQuote {
  readonly quoteId: string;
  readonly to: string;
  readonly toKind: 'venue';
  readonly distanceM: number;
  readonly serverNow: string;
  readonly expiresAt: string;
  readonly cashCents: number;
  readonly from: StreetPoint;
  readonly arrival: Arrival;
  readonly gate: { open: boolean; code?: string; message?: string };
  readonly modes: QuoteMode[];
}

export type TripStatus = 'booked' | 'arrived' | 'cancelled' | 'expired_refunded';

export interface TravelTrip {
  readonly tripId: string;
  readonly status: TripStatus;
  readonly mode: RideMode;
  readonly to: string;
  readonly fareCents: number;
  readonly cashCents: number;
  readonly departAt: string;
  readonly arriveAt: string;
  readonly expiresAt: string;
  readonly serverNow: string;
  readonly origin: StreetPoint;
  readonly arrival: Arrival;
  readonly pickup?: { id: string; x: number; z: number; yaw: number };
}

const GATE_MESSAGES: Record<string, string> = {
  NET_WORTH_TOO_LOW: 'The door needs a higher net worth. You can ride to the street outside.',
  NOT_A_MEMBER: 'Members only. You can ride to the street outside.',
  NOT_JAILED: 'Only for players in the Barn. You can ride to the street outside.',
  JAILED: 'You are in Jail.',
};

const REASON_MESSAGES: Record<ModeReason, string> = {
  TOO_CLOSE: 'It is just around the corner. Walk.',
  NOT_AT_STOP: 'The bus picks up at bus stops. Walk to the nearest stop.',
  INSUFFICIENT_CASH: 'Not enough Cash.',
  LOCKED: 'Unlocks at a higher net worth.',
  COOLDOWN: 'Wait a moment before booking another ride.',
  TRAVEL_IN_PROGRESS: 'You already have a ride booked.',
  VENUE_GATED: 'The door is gated for you.',
  NOT_SERVED: 'No road service to this door yet. Walk.',
};

// --- Shared reads -----------------------------------------------------

async function freshPos(ctx: AppContext, userId: string, now: Date): Promise<IslandPos> {
  const pos = decodePos(await ctx.redis.main.hget(POS_HASH, userId));
  if (!pos || now.getTime() - pos.at > POS_FRESH_MS) {
    throw new TravelNotInWorldError({ reason: 'no fresh position' });
  }
  return pos;
}

async function assertMayTravel(ctx: AppContext, userId: string, now: Date): Promise<void> {
  await assertNotJailed(ctx, userId, now);
  if (await ctx.db.withConnection((c) => isSybilJailed(c, userId, now))) {
    throw new SybilJailedError({});
  }
}

interface Limits {
  /** The open trip, if any. */
  readonly openTripId: string | null;
  /** ms until the next booking can pass the cooldown / hourly limit; 0 = now. */
  readonly retryAfterMs: number;
}

async function readLimits(
  c: Pick<PoolClient, 'query'>,
  cfg: TravelConfig,
  userId: string,
  now: Date,
): Promise<Limits> {
  const open = await c.query<{ trip_id: string }>(
    `SELECT trip_id FROM travel_trips WHERE user_id = $1 AND status = 'booked' LIMIT 1`,
    [userId],
  );
  const last = await c.query<{ ended: Date | null }>(
    `SELECT MAX(COALESCE(arrived_at, ended_at)) AS ended FROM travel_trips
      WHERE user_id = $1 AND status IN ('arrived', 'cancelled')`,
    [userId],
  );
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const hour = await c.query<{ n: string; oldest: Date | null }>(
    `SELECT COUNT(*)::text AS n, MIN(created_at) AS oldest FROM travel_trips
      WHERE user_id = $1 AND created_at > $2`,
    [userId, hourAgo],
  );
  let retry = 0;
  const ended = last.rows[0]?.ended;
  if (ended) retry = Math.max(retry, ended.getTime() + cfg.cooldownSec * 1000 - now.getTime());
  const n = Number(hour.rows[0]?.n ?? '0');
  const oldest = hour.rows[0]?.oldest;
  if (n >= cfg.tripsPerHour && oldest) {
    retry = Math.max(retry, oldest.getTime() + 3_600_000 - now.getTime());
  }
  return { openTripId: open.rows[0]?.trip_id ?? null, retryAfterMs: Math.max(0, retry) };
}

async function balanceOf(
  c: Pick<PoolClient, 'query'>,
  userId: string,
): Promise<{ cash: number; netWorth: number }> {
  const r = await c.query<{ cash_cents: string; debt_cents: string }>(
    `SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  const cash = Number(r.rows[0]?.cash_cents ?? '0');
  return { cash, netWorth: cash - Number(r.rows[0]?.debt_cents ?? '0') };
}

// --- Quote ------------------------------------------------------------

/**
 * Price every mode from the player's own fresh server position to `to`'s door and store
 * the quote for `quoteTtlSec`.
 * @throws NotFoundError for a venue that is not on the island.
 * @throws JailedError / SybilJailedError while jailed.
 * @throws TravelNotInWorldError without a fresh `ctl:pos`.
 */
export async function quoteTravel(
  ctx: AppContext,
  userId: string,
  to: string,
  now: Date = new Date(),
): Promise<TravelQuote> {
  const cfg = getTravelConfig();
  const target = arrivalFor(cfg, to);
  if (!target) throw new NotFoundError({ resource: 'venue', venueId: to });
  await assertMayTravel(ctx, userId, now);
  const pos = await freshPos(ctx, userId, now);
  const fromDistrict = streetDistrictAt(pos.x, pos.z) ?? 'unknown';
  const from: StreetPoint = { district: fromDistrict, x: round2(pos.x), z: round2(pos.z) };
  const distanceM = roadDistanceM(cfg, pos.x, pos.z, target.door.x, target.door.z);

  const access = await getVenueAccess(ctx, userId, to);
  const gate = access.allowed
    ? { open: true }
    : {
        open: false,
        ...(access.reasonCode ? { code: access.reasonCode } : {}),
        message: GATE_MESSAGES[access.reasonCode ?? ''] ?? 'The door is gated for you.',
      };

  const { bal, limits } = await ctx.db.withConnection(async (c) => ({
    bal: await balanceOf(c, userId),
    limits: await readLimits(c, cfg, userId, now),
  }));

  const fares = {} as Record<RideMode, number>;
  const durations = {} as Record<RideMode, number>;
  const modes: QuoteMode[] = [
    { mode: 'walk', available: true, fareCents: 0, durationSec: walkSeconds(cfg, distanceM) },
  ];
  const near = nearestBusStop(cfg, pos.x, pos.z);
  for (const mode of RIDE_MODES) {
    const m = cfg.modes[mode];
    const fare = fareCents(m, distanceM);
    const durationSec = rideSeconds(m, distanceM);
    fares[mode] = fare;
    durations[mode] = durationSec;
    let reason: ModeReason | undefined;
    if (limits.openTripId) reason = 'TRAVEL_IN_PROGRESS';
    else if (limits.retryAfterMs > 0) reason = 'COOLDOWN';
    else if (!target.served) reason = 'NOT_SERVED';
    else if (distanceM < cfg.minDistanceM) reason = 'TOO_CLOSE';
    else if (!gate.open && cfg.gatedBooking === 'refuse') reason = 'VENUE_GATED';
    else if (bal.netWorth < m.unlockNetWorthCents) reason = 'LOCKED';
    else if (m.pickup === 'stop' && (!near || near.distanceM > cfg.busStopRadiusM)) {
      reason = 'NOT_AT_STOP';
    } else if (bal.cash < fare) reason = 'INSUFFICIENT_CASH';
    const stop =
      m.pickup === 'stop' && near
        ? {
            id: near.stop.id,
            x: near.stop.x,
            z: near.stop.z,
            yaw: near.stop.yaw,
            distanceM: near.distanceM,
          }
        : undefined;
    modes.push({
      mode,
      available: reason === undefined,
      ...(reason ? { reason, reasonMessage: REASON_MESSAGES[reason] } : {}),
      fareCents: fare,
      durationSec,
      ...(stop ? { stop } : {}),
      ...(reason === 'LOCKED' ? { unlockNetWorthCents: m.unlockNetWorthCents } : {}),
      ...(reason === 'COOLDOWN'
        ? { retryAfterSec: Math.max(1, Math.ceil(limits.retryAfterMs / 1000)) }
        : {}),
    });
  }

  const quoteId = uuidv7();
  const stored: StoredQuote = {
    userId,
    to,
    from,
    distanceM,
    arrival: target.arrival,
    served: target.served,
    fares,
    durations,
    createdAt: now.getTime(),
  };
  await ctx.redis.main.set(travelQuoteKey(quoteId), JSON.stringify(stored), 'EX', cfg.quoteTtlSec);
  return {
    quoteId,
    to,
    toKind: 'venue',
    distanceM,
    serverNow: now.toISOString(),
    expiresAt: new Date(now.getTime() + cfg.quoteTtlSec * 1000).toISOString(),
    cashCents: bal.cash,
    from,
    arrival: target.arrival,
    gate,
    modes,
  };
}

// --- Book -------------------------------------------------------------

interface TripRow {
  trip_id: string;
  status: TripStatus;
  mode: RideMode;
  to_id: string;
  fare_cents: string;
  origin_district: string;
  origin_x: number;
  origin_z: number;
  pickup_stop_id: string | null;
  arrival_district: string;
  arrival_x: number;
  arrival_z: number;
  arrival_yaw: number;
  depart_at: Date;
  arrive_at: Date;
  expires_at: Date;
}

const TRIP_COLS = `trip_id, status, mode, to_id, fare_cents, origin_district, origin_x, origin_z,
  pickup_stop_id, arrival_district, arrival_x, arrival_z, arrival_yaw, depart_at, arrive_at, expires_at`;

function toTrip(r: TripRow, cashCents: number, now: Date): TravelTrip {
  const stop = r.pickup_stop_id
    ? getTravelConfig().busStops.find((s) => s.id === r.pickup_stop_id)
    : undefined;
  return {
    tripId: r.trip_id,
    status: r.status,
    mode: r.mode,
    to: r.to_id,
    fareCents: Number(r.fare_cents),
    cashCents,
    departAt: r.depart_at.toISOString(),
    arriveAt: r.arrive_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    serverNow: now.toISOString(),
    origin: { district: r.origin_district, x: r.origin_x, z: r.origin_z },
    arrival: { district: r.arrival_district, x: r.arrival_x, z: r.arrival_z, yaw: r.arrival_yaw },
    ...(stop ? { pickup: { id: stop.id, x: stop.x, z: stop.z, yaw: stop.yaw } } : {}),
  };
}

function ticketOf(r: TripRow): TravelTicket {
  return {
    tripId: r.trip_id,
    district: r.arrival_district,
    x: r.arrival_x,
    z: r.arrival_z,
    yaw: r.arrival_yaw,
    arriveAt: r.arrive_at.getTime(),
    expiresAt: r.expires_at.getTime(),
  };
}

export interface BookInput {
  readonly quoteId: string;
  readonly mode: RideMode;
}

/**
 * Book a bus or taxi from a stored quote. A replay with the same Idempotency-Key returns
 * the same trip (also after the 24 h response cache, through the ledger's unique ref).
 * @throws QuoteExpiredError for a missing, foreign or stale quote, or a player who moved.
 * @throws TravelNotInWorldError, TravelNotAtStopError, TravelLockedError, VenueGatedError,
 *   TravelInProgressError, TravelCooldownError, InsufficientCashError.
 */
export async function bookTrip(
  ctx: AppContext,
  userId: string,
  input: BookInput,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<TravelTrip> {
  const cfg = getTravelConfig();
  const ref = `travel-trip:${userId}:${idempotencyKey}`;
  const rawQuote = await ctx.redis.main.get(travelQuoteKey(input.quoteId));
  const quote = rawQuote ? (JSON.parse(rawQuote) as StoredQuote) : null;
  const pos = decodePos(await ctx.redis.main.hget(POS_HASH, userId));
  const m = cfg.modes[input.mode];
  const tripId = uuidv7();
  // gatedBooking 'refuse': a gated destination is refused before any charge (read outside the
  // transaction, thrown inside after the replay check so a replay still answers).
  const gated =
    cfg.gatedBooking === 'refuse' && quote
      ? !(await getVenueAccess(ctx, userId, quote.to)).allowed
      : false;

  const out = await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await client.query(`SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`, [userId]);

    const prior = await client.query<{ ref_id: string }>(
      `SELECT ref_id FROM ledger_entries WHERE idempotency_ref = $1`,
      [ref],
    );
    if (prior.rows[0]) {
      const r = await client.query<TripRow>(
        `SELECT ${TRIP_COLS} FROM travel_trips WHERE trip_id = $1 AND user_id = $2`,
        [prior.rows[0].ref_id, userId],
      );
      if (r.rows[0]) {
        const bal = await balanceOf(client, userId);
        return { row: r.rows[0], cash: bal.cash, fresh: false };
      }
    }

    // Jail checks in the application layer too (the route also has requireNotJailed): CT Jail
    // and the Barn are refused before anything is charged. A replay above still answers.
    const custody = await activeJail(client, userId, now);
    if (custody) {
      throw new JailedError({ until: custody.until.toISOString(), bailCents: custody.bailCents });
    }
    if (await isSybilJailed(client, userId, now)) throw new SybilJailedError({});

    if (
      !quote ||
      quote.userId !== userId ||
      now.getTime() - quote.createdAt > cfg.quoteTtlSec * 1000
    ) {
      throw new QuoteExpiredError({ reason: 'expired' });
    }
    if (!pos || now.getTime() - pos.at > POS_FRESH_MS) {
      throw new TravelNotInWorldError({ reason: 'no fresh position' });
    }
    if (Math.hypot(pos.x - quote.from.x, pos.z - quote.from.z) > cfg.bookDriftM) {
      throw new QuoteExpiredError({ reason: 'moved' });
    }
    if (!quote.served) throw new ValidationFailedError({ reason: 'not_served', to: quote.to });
    if (quote.distanceM < cfg.minDistanceM) {
      throw new ValidationFailedError({ reason: 'too_close', minDistanceM: cfg.minDistanceM });
    }

    if (gated) throw new VenueGatedError({ to: quote.to });

    const limits = await readLimits(client, cfg, userId, now);
    if (limits.openTripId) throw new TravelInProgressError({ tripId: limits.openTripId });
    if (limits.retryAfterMs > 0) throw new TravelCooldownError(limits.retryAfterMs);

    const bal = await balanceOf(client, userId);
    if (bal.netWorth < m.unlockNetWorthCents) {
      throw new TravelLockedError({ mode: input.mode, unlockNetWorthCents: m.unlockNetWorthCents });
    }

    let pickupStopId: string | null = null;
    if (m.pickup === 'stop') {
      const near = nearestBusStop(cfg, pos.x, pos.z);
      if (!near || near.distanceM > cfg.busStopRadiusM) {
        throw new TravelNotAtStopError({
          radiusM: cfg.busStopRadiusM,
          ...(near
            ? {
                stop: { id: near.stop.id, x: near.stop.x, z: near.stop.z },
                distanceM: near.distanceM,
              }
            : {}),
        });
      }
      pickupStopId = near.stop.id;
    }

    const fare = quote.fares[input.mode];
    if (bal.cash < fare) {
      throw new InsufficientCashError({ have: String(bal.cash), need: String(fare) });
    }

    const durationSec = quote.durations[input.mode];
    const departAt = now;
    const arriveAt = new Date(now.getTime() + durationSec * 1000);
    const expiresAt = new Date(arriveAt.getTime() + cfg.ticketGraceSec * 1000);
    const origin = pickupStopId
      ? cfg.busStops.find((s) => s.id === pickupStopId)!
      : { district: quote.from.district, x: quote.from.x, z: quote.from.z };
    try {
      await client.query(
        `INSERT INTO travel_trips
           (trip_id, user_id, mode, to_id, fare_cents, status, distance_m,
            origin_district, origin_x, origin_z, pickup_stop_id,
            arrival_district, arrival_x, arrival_z, arrival_yaw,
            depart_at, arrive_at, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'booked', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $15)`,
        [
          tripId,
          userId,
          input.mode,
          quote.to,
          fare,
          quote.distanceM,
          origin.district,
          origin.x,
          origin.z,
          pickupStopId,
          quote.arrival.district,
          quote.arrival.x,
          quote.arrival.z,
          quote.arrival.yaw,
          departAt,
          arriveAt,
          expiresAt,
        ],
      );
    } catch (e) {
      // The partial unique index: another booking won (the balance lock makes this rare).
      if ((e as { code?: string }).code === '23505') throw new TravelInProgressError({});
      throw e;
    }
    if (fare > 0) {
      await client.query(
        `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
        [fare, userId],
      );
    }
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'travel_fare', 'travel_trip', $3, $4)`,
      [userId, -fare, tripId, ref],
    );
    const r = await client.query<TripRow>(
      `SELECT ${TRIP_COLS} FROM travel_trips WHERE trip_id = $1`,
      [tripId],
    );
    return { row: r.rows[0]!, cash: bal.cash - fare, fresh: true };
  });

  if (out.fresh) {
    await writeTicket(ctx, userId, ticketOf(out.row), now);
    await ctx.redis.main.del(travelQuoteKey(input.quoteId));
  }
  return toTrip(out.row, out.cash, now);
}

// --- Current / cancel -------------------------------------------------

/**
 * @returns The caller's booked trip, or null.
 */
export async function currentTrip(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<{ trip: TravelTrip | null; serverNow: string }> {
  const out = await ctx.db.withConnection(async (c) => {
    const r = await c.query<TripRow>(
      `SELECT ${TRIP_COLS} FROM travel_trips WHERE user_id = $1 AND status = 'booked' LIMIT 1`,
      [userId],
    );
    const bal = await balanceOf(c, userId);
    return { row: r.rows[0], cash: bal.cash };
  });
  return {
    trip: out.row ? toTrip(out.row, out.cash, now) : null,
    serverNow: now.toISOString(),
  };
}

/**
 * Cancel a booked trip before its ticket opens: full refund once.
 *
 * Security (review of PR #82): the cancel window ends where the arrival window starts
 * (`arriveAt - arriveEarlySec`), so the two never overlap, and the ticket is taken first:
 * it must still exist, name this trip and be deleted by this call (compare-and-delete), or
 * the cancel is refused. Only then is the row flipped with one guarded UPDATE, and the refund
 * is credited only when that UPDATE returned the row. A used ticket can therefore never be
 * refunded, and two cancels refund once. If the transaction fails after the ticket was
 * taken, the trip stays booked with no ticket: no ride, and the sweep refunds it.
 * @throws NotFoundError for a trip that is not the caller's.
 * @throws TravelNotCancellableError once arrived, ended, past the cutoff or the ticket is gone.
 */
export async function cancelTrip(
  ctx: AppContext,
  userId: string,
  tripId: string,
  now: Date = new Date(),
): Promise<{ tripId: string; refundedCents: number; cashCents: number }> {
  const cfg = getTravelConfig();
  const earlyMs = cfg.arriveEarlySec * 1000;
  const found = await ctx.db.withConnection((c) =>
    c.query<{ status: TripStatus; arrive_at: Date }>(
      `SELECT status, arrive_at FROM travel_trips WHERE trip_id = $1 AND user_id = $2`,
      [tripId, userId],
    ),
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError({ resource: 'travel_trip', tripId });
  if (row.status !== 'booked' || now.getTime() >= row.arrive_at.getTime() - earlyMs) {
    throw new TravelNotCancellableError({ status: row.status });
  }
  if (!(await takeTicket(ctx.redis.main as unknown as TicketRedis, userId, tripId))) {
    throw new TravelNotCancellableError({ status: row.status, reason: 'ticket_gone' });
  }

  const out = await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await client.query(`SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`, [userId]);
    const flipped = await client.query<{ fare_cents: string }>(
      `UPDATE travel_trips SET status = 'cancelled', ended_at = $3
        WHERE trip_id = $1 AND user_id = $2 AND status = 'booked'
          AND arrive_at > $3::timestamptz + make_interval(secs => $4)
        RETURNING fare_cents`,
      [tripId, userId, now, cfg.arriveEarlySec],
    );
    const fare = flipped.rows[0];
    if (!fare) throw new TravelNotCancellableError({ reason: 'not_booked' });
    const refunded = await creditRefund(client, userId, tripId, Number(fare.fare_cents));
    const bal = await balanceOf(client, userId);
    return { refunded, cash: bal.cash };
  });
  return { tripId, refundedCents: out.refunded, cashCents: out.cash };
}

/**
 * Credit a trip's fare back once (ledger `travel_refund`, idempotency_ref
 * `travel-refund:<tripId>`). Call only after a guarded UPDATE ended the trip.
 * @returns The cents credited (0 when this trip was already refunded).
 */
async function creditRefund(
  client: Pick<PoolClient, 'query'>,
  userId: string,
  tripId: string,
  fare: number,
): Promise<number> {
  const ins = await client.query(
    `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
     VALUES ($1, $2, 'cash', 'travel_refund', 'travel_trip', $3, $4)
     ON CONFLICT (idempotency_ref) DO NOTHING`,
    [userId, fare, tripId, `travel-refund:${tripId}`],
  );
  if ((ins.rowCount ?? 0) === 0 || fare <= 0) return 0;
  await client.query(
    `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
    [fare, userId],
  );
  return fare;
}

// --- Tickets (the street room's arrival) ------------------------------

/** Minimal Redis surface the ticket helpers need (ioredis in production, a fake in room tests). */
export interface TicketRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** Delete KEYS[1] only while it still holds ARGV[1] (the exact ticket that was read). */
const COMPARE_AND_DELETE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

async function writeTicket(
  ctx: AppContext,
  userId: string,
  t: TravelTicket,
  now: Date,
): Promise<void> {
  const ttlMs = Math.max(1_000, t.expiresAt + 60_000 - now.getTime());
  await ctx.redis.main.set(travelTicketKey(userId), JSON.stringify(t), 'PX', ttlMs);
}

/**
 * Delete the caller's ticket only if it names `tripId` and is still exactly what was read.
 * @returns True when this call deleted it.
 */
async function takeTicket(redis: TicketRedis, userId: string, tripId: string): Promise<boolean> {
  const key = travelTicketKey(userId);
  const raw = await redis.get(key);
  if (!raw) return false;
  try {
    if ((JSON.parse(raw) as TravelTicket).tripId !== tripId) return false;
  } catch {
    return false;
  }
  return Number(await redis.eval(COMPARE_AND_DELETE, 1, key, raw)) === 1;
}

export type TicketResult =
  | { readonly ok: true; readonly ticket: TravelTicket }
  | {
      readonly ok: false;
      readonly code: 'TRAVEL_TICKET_INVALID' | 'TRAVEL_NOT_ARRIVED';
      readonly retryAfterMs?: number;
    };

/** Realtime join refusal codes (`ServerError(code, name)`; contract/realtime/messages.ts). */
export const TRAVEL_JOIN_CODES = TRAVEL_JOIN_ERROR_CODES;

/**
 * Use the caller's arrival ticket in `district`'s street room: valid only for this user (the
 * key is per user), this trip and this district, from `arriveAt - arriveEarlySec` until just
 * before `expiresAt`. Deleted atomically on success, so it works once; an early join keeps
 * it. The caller must then run `markArrived` and place the player only when it returns true.
 * @param redis - Redis.
 * @param cfg - Travel config.
 * @param userId - The joining user.
 * @param tripId - The trip id from the join options.
 * @param district - The street room's district.
 * @param nowMs - Server time.
 */
export async function consumeTicket(
  redis: TicketRedis,
  cfg: Pick<TravelConfig, 'arriveEarlySec'>,
  userId: string,
  tripId: string,
  district: string,
  nowMs: number,
): Promise<TicketResult> {
  const key = travelTicketKey(userId);
  const raw = await redis.get(key);
  if (!raw) return { ok: false, code: 'TRAVEL_TICKET_INVALID' };
  let t: TravelTicket;
  try {
    t = JSON.parse(raw) as TravelTicket;
  } catch {
    return { ok: false, code: 'TRAVEL_TICKET_INVALID' };
  }
  if (t.tripId !== tripId || t.district !== district) {
    return { ok: false, code: 'TRAVEL_TICKET_INVALID' };
  }
  const opensAt = t.arriveAt - cfg.arriveEarlySec * 1000;
  if (nowMs < opensAt)
    return { ok: false, code: 'TRAVEL_NOT_ARRIVED', retryAfterMs: opensAt - nowMs };
  if (nowMs >= t.expiresAt) return { ok: false, code: 'TRAVEL_TICKET_INVALID' };
  const deleted = Number(await redis.eval(COMPARE_AND_DELETE, 1, key, raw));
  if (deleted !== 1) return { ok: false, code: 'TRAVEL_TICKET_INVALID' };
  return { ok: true, ticket: t };
}

/**
 * @param redis - Redis.
 * @param userId - The user.
 * @param nowMs - Server time.
 * @returns True while the user holds an unexpired ticket (riding: no street join without it).
 */
export async function hasOpenTicket(
  redis: Pick<TicketRedis, 'get'>,
  userId: string,
  nowMs: number,
): Promise<boolean> {
  const raw = await redis.get(travelTicketKey(userId));
  if (!raw) return false;
  try {
    return nowMs < (JSON.parse(raw) as TravelTicket).expiresAt;
  } catch {
    return false;
  }
}

/**
 * Record an arrival; the database is the source of truth. One guarded UPDATE flips the trip
 * to `arrived` only while it is still `booked` and unexpired. The street room places the
 * traveller only when this returns true. Otherwise (cancelled, swept, expired, or the update
 * failed) it refuses the arrival, and a trip left `booked` is refunded by the sweep, so a
 * ride and a refund can never both happen.
 * @param ctx - The app context.
 * @param userId - The traveller.
 * @param t - The consumed ticket.
 * @param now - Server time.
 * @returns True when this call marked the trip arrived.
 */
export async function markArrived(
  ctx: Pick<AppContext, 'db'>,
  userId: string,
  t: Pick<TravelTicket, 'tripId'>,
  now: Date = new Date(),
): Promise<boolean> {
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE travel_trips SET status = 'arrived', arrived_at = $3
        WHERE trip_id = $1 AND user_id = $2 AND status = 'booked' AND expires_at > $3
        RETURNING trip_id`,
      [t.tripId, userId, now],
    ),
  );
  return (r.rowCount ?? 0) > 0;
}

// --- Sweep ------------------------------------------------------------

/** How long after `expiresAt` the sweep waits, so it never races a join near the deadline. */
export const SWEEP_GRACE_MS = 60_000;

/**
 * Refund every booked trip whose ticket expired unused (more than SWEEP_GRACE_MS ago), once
 * each. Each refund is one guarded UPDATE (`status = 'booked'` -> `expired_refunded`) that
 * must return the row before anything is credited, so an arrived or cancelled trip is never
 * refunded and two sweeps at once refund once.
 * @returns How many trips were refunded.
 */
export async function sweepTravelTrips(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SWEEP_GRACE_MS);
  const due = await ctx.db.withConnection((c) =>
    c.query<{ trip_id: string; user_id: string }>(
      `SELECT trip_id, user_id FROM travel_trips
        WHERE status = 'booked' AND expires_at < $1 ORDER BY expires_at ASC LIMIT 200`,
      [cutoff],
    ),
  );
  let refunded = 0;
  for (const { trip_id, user_id } of due.rows) {
    const done = await runInTransaction(async (client) => {
      await client.query(`SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`, [
        user_id,
      ]);
      const flipped = await client.query<{ fare_cents: string }>(
        `UPDATE travel_trips SET status = 'expired_refunded', ended_at = $3
          WHERE trip_id = $1 AND status = 'booked' AND expires_at < $2
          RETURNING fare_cents`,
        [trip_id, cutoff, now],
      );
      const row = flipped.rows[0];
      if (!row) return false;
      await creditRefund(client, user_id, trip_id, Number(row.fare_cents));
      return true;
    });
    if (done) {
      refunded++;
      await takeTicket(ctx.redis.main as unknown as TicketRedis, user_id, trip_id);
    }
  }
  return refunded;
}

// --- GET /config ------------------------------------------------------

/**
 * The `travel` block of GET /config: null while the capability is off.
 * @param ctx - The (platform-scoped) context.
 */
export function travelClientConfig(
  ctx: Pick<AppContext, 'config'>,
): Record<string, unknown> | null {
  if (!isCapabilityOn(ctx, 'travel')) return null;
  const cfg = getTravelConfig();
  return {
    version: cfg.version,
    walk: cfg.walk,
    busStopRadiusM: cfg.busStopRadiusM,
    busStops: cfg.busStops,
    modes: cfg.modes,
    minDistanceM: cfg.minDistanceM,
  };
}
