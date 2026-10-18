/**
 * Movement rules shared by the venue, street and vehicle rooms.
 *
 * Speed is checked as a distance budget instead of speed between
 * message arrivals. The budget refills at the speed cap and is spent by
 * each accepted move, so a late or dropped message does not fail an
 * honest sprint, while the long-run speed can never exceed the cap. A
 * move past the budget is clamped toward the target and the client is
 * told where the server put it.
 *
 * Island geometry (island outline + district polygons, island metres,
 * +X east, +Z north, origin at the downtown plaza) is read from
 * `contract/ids/districts.json`, which the frontend owns.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Point = readonly [number, number];
export type Polygon = readonly Point[];

/** Walking cap: an honest sprint is 6 m/s, plus headroom. */
export const WALK_SPEED_M_PER_S = 6.5;
/** Extra distance granted on top of the refill, for float and timing noise. */
export const WALK_SLACK_M = 0.5;
/** Most movement time that can be banked (standing still does not build a teleport). */
export const MAX_BANKED_S = 1;

export interface MoveAnchor {
  x: number;
  z: number;
  /** Server time of the last accepted move. */
  at: number;
  /** Metres the player may still cover before the next refill. */
  budget: number;
}

/**
 * Start a movement anchor at a known position.
 * @param x - Position x.
 * @param z - Position z.
 * @param now - Server time in ms.
 * @returns A fresh anchor with only the slack in its budget.
 */
export function newAnchor(x: number, z: number, now: number): MoveAnchor {
  return { x, z, at: now, budget: WALK_SLACK_M };
}

/**
 * Apply one move against a distance budget and update the anchor.
 * @param a - The anchor, mutated to the accepted position.
 * @param x - Requested x.
 * @param z - Requested z.
 * @param now - Server time in ms.
 * @param speed - Cap in m/s (walking by default).
 * @returns The accepted position, whether it was clamped, and the distance moved.
 */
export function stepMove(
  a: MoveAnchor,
  x: number,
  z: number,
  now: number,
  speed = WALK_SPEED_M_PER_S,
): { x: number; z: number; clamped: boolean; dist: number } {
  const elapsedS = Math.max(0, now - a.at) / 1000;
  const cap = speed * MAX_BANKED_S + WALK_SLACK_M;
  const budget = Math.min(cap, a.budget + speed * elapsedS);
  const dx = x - a.x;
  const dz = z - a.z;
  const dist = Math.hypot(dx, dz);
  let out = { x, z, clamped: false, dist };
  if (dist > budget) {
    const k = dist > 0 ? budget / dist : 0;
    out = { x: a.x + dx * k, z: a.z + dz * k, clamped: true, dist: budget };
  }
  a.x = out.x;
  a.z = out.z;
  a.at = now;
  a.budget = budget - out.dist;
  return out;
}

/**
 * Simple token bucket for message rate limits. Bursts from network jitter
 * pass; a sustained flood does not.
 */
export class TokenBucket {
  private tokens: number;
  private at: number;
  /**
   * @param ratePerS - Refill rate.
   * @param burst - Bucket size.
   */
  constructor(
    private readonly ratePerS: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.at = 0;
  }

  /**
   * Take one token.
   * @param now - Server time in ms.
   * @returns False when the bucket is empty.
   */
  take(now: number): boolean {
    if (this.at !== 0) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.ratePerS);
    }
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// --- Polygons --------------------------------------------------------

/**
 * Even-odd point-in-polygon test.
 * @param poly - Polygon vertices as [x, z].
 * @param x - Point x.
 * @param z - Point z.
 * @returns True when the point is inside.
 */
export function pointInPolygon(poly: Polygon, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Distance from a point to a polygon, zero when inside.
 * @param poly - Polygon vertices as [x, z].
 * @param x - Point x.
 * @param z - Point z.
 * @returns Metres outside the polygon.
 */
export function distanceToPolygon(poly: Polygon, x: number, z: number): number {
  if (pointInPolygon(poly, x, z)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]!;
    const [bx, bz] = poly[i]!;
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2));
    best = Math.min(best, Math.hypot(x - (ax + ex * t), z - (az + ez * t)));
  }
  return best;
}

// --- Island geometry -------------------------------------------------

export const DISTRICTS = [
  'timeline',
  'trenches',
  'builder_hills',
  'airdrop_farm',
  'dubai_marina',
  'residences',
  'beachfront',
  'mountain',
] as const;
export type DistrictId = (typeof DISTRICTS)[number];

export interface IslandGeometry {
  readonly island: Polygon;
  readonly districts: Partial<Record<DistrictId, Polygon>>;
}

let geometry: IslandGeometry | null = null;

/**
 * Island outline and district polygons, read once from the contract.
 * @returns The geometry; polygons with fewer than 3 points mean "not sent yet".
 */
export function getIslandGeometry(): IslandGeometry {
  if (geometry) return geometry;
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'contract', 'ids', 'districts.json'), 'utf8'),
  ) as { island?: Polygon; districts?: Partial<Record<DistrictId, Polygon>> };
  geometry = { island: raw.island ?? [], districts: raw.districts ?? {} };
  return geometry;
}

/**
 * Replace the geometry (tests only).
 * @param g - Geometry to use, or null to re-read the file.
 */
export function setIslandGeometry(g: IslandGeometry | null): void {
  geometry = g;
}

// --- Last known island position (shared across rooms) -----------------

/**
 * Presence hash holding each user's last accepted island position as
 * "x,z,at". Street rooms write it while walking and the vehicle room
 * writes it while driving, so a player crossing into another district or
 * getting out of a car is checked against where they really were.
 */
export const POS_HASH = 'ctl:pos';
/** Presence channel the vehicle room publishes exits on. */
export const VEHICLE_EXIT_CHANNEL = 'ctl:vehicle_exit';
/** How old a stored position can be and still anchor a join. */
export const POS_FRESH_MS = 30_000;

export interface IslandPos {
  x: number;
  z: number;
  at: number;
}

/**
 * @param p - Position to encode.
 * @returns The presence value.
 */
export function encodePos(p: IslandPos): string {
  return `${p.x.toFixed(2)},${p.z.toFixed(2)},${p.at}`;
}

/**
 * @param s - Presence value.
 * @returns The position, or null if missing or malformed.
 */
export function decodePos(s: string | null | undefined): IslandPos | null {
  if (!s) return null;
  const [x, z, at] = s.split(',').map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(at)) return null;
  return { x: x!, z: z!, at: at! };
}
