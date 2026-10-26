/**
 * Realtime load: N headless players walking the island streets.
 *
 * Each player does what the Unity client does on CT Island
 * (client/Assets/Scripts/Net/Realtime/*.cs, World/Island/StreetNetworkBridge.cs):
 *
 *   1. dev sign-in (POST /v1/auth/dev) and a character, so the street
 *      room can load a profile;
 *   2. keeps the persistent `city` and `market` rooms joined;
 *   3. joins the island-wide `vehicles` room (sends nothing while on foot);
 *   4. joins `street` for its district and sends `move` every Update,
 *      throttled to one per 0.1 s (StreetChannel.Move), i.e. a steady
 *      10 Hz, even when standing still. Walking speed is 4 m/s, inside
 *      the district polygon so the server never clamps or rejects.
 *
 * Measured per run: join latency per room, move-to-visible latency (the
 * time from sending a move to seeing the player's own position in a
 * state patch), downstream bytes per player per second, disconnects and
 * join failures. The REST side of the same players is driven by k6
 * (tools/load/k6/rest-players.js); run both together. See docs/LOAD-TEST.md.
 *
 * Usage:
 *   pnpm exec tsx tools/load/street-players.ts --api http://localhost:4010 \
 *     --ws ws://localhost:2567 --players 300 --steps 3 --ramp 60 --hold 180 \
 *     --hot 0.6 --out /tmp/street.json
 *
 * The load climbs in --steps plateaus like the k6 script (1/3, 2/3, all of
 * --players), each reached over --ramp seconds and held for --hold seconds,
 * and the report has the move latency and bandwidth of every plateau.
 *
 * --hot is the share of players in the busiest district (timeline); the
 * rest spread evenly over the other districts. --hot 1 is the worst case
 * (everyone downtown: rooms fill to 100 and overflow).
 */
import { writeFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { Client, type Room } from '@colyseus/sdk';
import {
  DISTRICTS,
  distanceToPolygon,
  getIslandGeometry,
  onLand,
  type DistrictId,
  type Polygon,
} from '../../server/realtime/movement.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i < 0 ? undefined : process.argv[i + 1];
  return v === undefined ? fallback : v;
}

const API = arg('api', 'http://localhost:4010');
const WS = arg('ws', 'ws://localhost:2567');
const PLAYERS = Number(arg('players', '100'));
const STEPS = Number(arg('steps', '3'));
const RAMP_S = Number(arg('ramp', '60'));
const HOLD_S = Number(arg('hold', '180'));
const HOT = Number(arg('hot', '0.6'));
const OUT = arg('out', '');
/** Client send cadence: StreetChannel.Move drops calls closer than 0.1 s. */
const MOVE_INTERVAL_MS = 100;
const WALK_M_PER_S = 4;

// --- Stats ----------------------------------------------------------------

class Samples {
  private v: number[] = [];
  add(ms: number): void {
    this.v.push(ms);
  }
  get count(): number {
    return this.v.length;
  }
  summary(): Record<string, number> {
    const s = [...this.v].sort((a, b) => a - b);
    const p = (q: number): number =>
      s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
    return {
      count: s.length,
      p50: round(p(0.5)),
      p95: round(p(0.95)),
      p99: round(p(0.99)),
      max: round(s.length ? s[s.length - 1]! : 0),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

const stats = {
  signIn: new Samples(),
  join: {
    city: new Samples(),
    market: new Samples(),
    vehicles: new Samples(),
    street: new Samples(),
  },
  moveToVisible: new Samples(),
  joinFailures: 0,
  signInFailures: 0,
  drops: 0,
  movesSent: 0,
  corrected: 0,
  rejected: 0,
  rejectCodes: {} as Record<string, number>,
  bytesIn: 0,
};

// --- Geometry -------------------------------------------------------------

const geo = getIslandGeometry();

function randomPointIn(poly: Polygon): [number, number] {
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...zs),
    Math.max(...zs),
  ];
  for (let i = 0; i < 10_000; i++) {
    const x = minX + Math.random() * (maxX - minX);
    const z = minZ + Math.random() * (maxZ - minZ);
    // Stay 5 m inside the district and on land, so a step never leaves bounds.
    if (
      distanceToPolygon(poly, x, z) === 0 &&
      onLand(geo.island, x, z) &&
      insideBy(poly, x, z, 5)
    ) {
      return [x, z];
    }
  }
  throw new Error('no point found inside district');
}

function inside(poly: Polygon, x: number, z: number): boolean {
  return distanceToPolygon(poly, x, z) === 0 && onLand(geo.island, x, z);
}

function insideBy(poly: Polygon, x: number, z: number, m: number): boolean {
  for (const [dx, dz] of [
    [m, 0],
    [-m, 0],
    [0, m],
    [0, -m],
  ] as const) {
    if (distanceToPolygon(poly, x + dx, z + dz) > 0 || !onLand(geo.island, x + dx, z + dz))
      return false;
  }
  return true;
}

function pickDistrict(i: number): DistrictId {
  const open = DISTRICTS.filter((d) => (geo.districts[d]?.length ?? 0) >= 3);
  if (Math.random() < HOT || open.length === 1)
    return open.includes('timeline') ? 'timeline' : open[0]!;
  const rest = open.filter((d) => d !== 'timeline');
  return rest[i % rest.length]!;
}

// --- Player ---------------------------------------------------------------

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

interface Player {
  rooms: Room[];
  timer: NodeJS.Timeout | null;
}

async function timedJoin(
  client: Client,
  name: 'city' | 'market' | 'vehicles' | 'street',
  options: Record<string, unknown>,
): Promise<Room> {
  const t = performance.now();
  const room = await client.joinOrCreate(name, options);
  stats.join[name].add(performance.now() - t);
  countBytes(room);
  room.onMessage('*', () => undefined);
  room.onDrop(() => {
    stats.drops++;
  });
  return room;
}

/** Count downstream bytes by wrapping the connection's message callback. */
function countBytes(room: Room): void {
  const events = (
    room.connection as unknown as { events: { onmessage?: (e: MessageEvent) => void } }
  ).events;
  const original = events.onmessage;
  events.onmessage = (e: MessageEvent): void => {
    const d = e.data as ArrayBuffer | Buffer | string;
    stats.bytesIn += typeof d === 'string' ? d.length : d.byteLength;
    original?.(e);
  };
}

async function startPlayer(i: number, stopAt: number): Promise<Player> {
  const p: Player = { rooms: [], timer: null };
  const wallet = Keypair.generate().publicKey.toBase58();
  let token: string;
  try {
    const t = performance.now();
    const auth = await post<{ accessToken: string }>('/v1/auth/dev', { wallet });
    stats.signIn.add(performance.now() - t);
    token = auth.accessToken;
    await post('/v1/lottery/roll', {}, token);
    await post(
      '/v1/characters',
      {
        alias: `rt${i}_${wallet.slice(0, 6)}`,
        look: {
          skinTone: '#f5d0a9',
          headId: 'head_default',
          hairId: 'hair_short',
          topId: 'top_hoodie',
          bottomId: 'bottom_jeans',
          shoesId: 'shoes_sneakers',
          accId: 'acc_none',
        },
        traitIds: ['fast_talker', 'deep_pockets'],
        dreamId: 'make_10k',
        tribeId: 'trencher',
        ageConfirmed: true,
      },
      token,
    );
  } catch (e) {
    if (stats.signInFailures++ < 3) console.error('[street] sign-in failed:', (e as Error).message);
    return p;
  }

  const district = pickDistrict(i);
  const poly = geo.districts[district]!;
  const client = new Client(WS);
  try {
    p.rooms.push(await timedJoin(client, 'city', { token }));
    p.rooms.push(await timedJoin(client, 'market', { token }));
    p.rooms.push(await timedJoin(client, 'vehicles', { token }));
    const street = await timedJoin(client, 'street', { token, district });
    p.rooms.push(street);
    walk(street, poly, p, stopAt);
  } catch (e) {
    if (stats.joinFailures++ < 3) console.error('[street] join failed:', (e as Error).message);
  }
  return p;
}

function walk(street: Room, poly: Polygon, p: Player, stopAt: number): void {
  let [x, z] = randomPointIn(poly);
  let [tx, tz] = randomPointIn(poly);
  let rotY = 0;
  /** Recently sent positions, to time when each becomes visible in a patch. */
  const pending: { x: number; z: number; at: number }[] = [];
  const self = street.sessionId;

  street.onMessage('corrected', () => stats.corrected++);
  street.onMessage('rejected', (m: { code?: string }) => {
    stats.rejected++;
    stats.rejectCodes[m?.code ?? '?'] = (stats.rejectCodes[m?.code ?? '?'] ?? 0) + 1;
  });
  street.onStateChange((state: unknown) => {
    const players = (state as { players?: Map<string, { x: number; z: number }> }).players;
    const me = players?.get(self);
    if (!me || pending.length === 0) return;
    for (let k = pending.length - 1; k >= 0; k--) {
      const s = pending[k]!;
      if (Math.abs(s.x - me.x) < 0.01 && Math.abs(s.z - me.z) < 0.01) {
        stats.moveToVisible.add(performance.now() - s.at);
        pending.splice(0, k + 1);
        return;
      }
    }
  });

  const step = MOVE_INTERVAL_MS / 1000;
  p.timer = setInterval(() => {
    if (Date.now() >= stopAt) return;
    const dx = tx - x;
    const dz = tz - z;
    const d = Math.hypot(dx, dz);
    const nx = d > 0 ? x + (dx / d) * WALK_M_PER_S * step : x;
    const nz = d > 0 ? z + (dz / d) * WALK_M_PER_S * step : z;
    if (d < WALK_M_PER_S * step || !inside(poly, nx, nz)) {
      // Arrived, or the straight line leaves a concave district: new target.
      [tx, tz] = randomPointIn(poly);
    } else {
      x = nx;
      z = nz;
      rotY = Math.atan2(dx, dz);
    }
    // float32 on the wire: compare against what the server will echo.
    const fx = Math.fround(x);
    const fz = Math.fround(z);
    pending.push({ x: fx, z: fz, at: performance.now() });
    if (pending.length > 50) pending.shift();
    street.send('move', { x, z, rotY });
    stats.movesSent++;
  }, MOVE_INTERVAL_MS);
}

// --- Main -----------------------------------------------------------------

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const started = Date.now();
  const stopAt = started + STEPS * (RAMP_S + HOLD_S) * 1000;
  const all: Player[] = [];
  const plateaus: Record<string, unknown>[] = [];
  const ticker = setInterval(() => {
    console.info(
      `[street] t=${Math.round((Date.now() - started) / 1000)}s players=${all.length} ` +
        `moves=${stats.movesSent} visible p95=${stats.moveToVisible.summary().p95}ms drops=${stats.drops}`,
    );
  }, 15_000);

  for (let step = 1; step <= STEPS; step++) {
    const target = Math.ceil((PLAYERS * step) / STEPS);
    const adding = target - all.length;
    const gap = adding > 0 ? (RAMP_S * 1000) / adding : 0;
    const joining: Promise<Player>[] = [];
    for (let i = all.length; i < target; i++) {
      joining.push(startPlayer(i, stopAt));
      await sleepMs(gap);
    }
    all.push(...(await Promise.all(joining)));
    const connected = all.filter((p) => p.rooms.length === 4).length;
    // Hold, measuring this plateau only.
    stats.moveToVisible = new Samples();
    const bytes0 = stats.bytesIn;
    const t0 = Date.now();
    await sleepMs(HOLD_S * 1000);
    const secs = (Date.now() - t0) / 1000;
    const bytes = stats.bytesIn - bytes0;
    plateaus.push({
      players: target,
      connected,
      moveToVisibleMs: stats.moveToVisible.summary(),
      downKBpsPerPlayer: connected ? round(bytes / secs / connected / 1024) : 0,
      serverEgressKBps: round(bytes / secs / 1024),
    });
    console.info(
      `[street] plateau ${step}/${STEPS}: ${JSON.stringify(plateaus[plateaus.length - 1])}`,
    );
  }
  clearInterval(ticker);

  for (const p of all) {
    if (p.timer) clearInterval(p.timer);
    await Promise.allSettled(p.rooms.map((r) => r.leave()));
  }

  const report = {
    at: new Date().toISOString(),
    target: { api: API, ws: WS },
    players: PLAYERS,
    hot: HOT,
    steps: STEPS,
    rampS: RAMP_S,
    holdS: HOLD_S,
    signInMs: stats.signIn.summary(),
    joinMs: {
      city: stats.join.city.summary(),
      market: stats.join.market.summary(),
      vehicles: stats.join.vehicles.summary(),
      street: stats.join.street.summary(),
    },
    plateaus,
    movesSent: stats.movesSent,
    corrected: stats.corrected,
    rejected: stats.rejected,
    rejectCodes: stats.rejectCodes,
    drops: stats.drops,
    joinFailures: stats.joinFailures,
    signInFailures: stats.signInFailures,
  };
  console.info(JSON.stringify(report, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
  process.exit(0);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
