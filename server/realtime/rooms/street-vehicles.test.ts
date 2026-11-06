/**
 * Street and vehicles rooms, driven directly (no matchmaker) with an
 * in-memory presence standing in for Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalPresence } from 'colyseus';
import { Encoder, type Schema } from '@colyseus/schema';
import { PlayerState, VehicleState } from '../../../contract/realtime/states.js';
import {
  setIslandGeometry,
  setParkedSpots,
  setParkingBays,
  POS_HASH,
  decodePos,
  encodePos,
  DISTRICTS,
  getParkedSpots,
  parkedSpotFor,
} from '../movement.js';

vi.mock('../player.js', async (orig) => {
  const real = await orig<typeof import('../player.js')>();
  return {
    ...real,
    authenticateJoinIdentity: async (o: { userId: string }) => ({
      userId: o.userId,
      credential: null,
    }),
  };
});

const { StreetRoom } = await import('./street.js');
const { VehiclesRoom, setVehicleCrimeHooks, registrationRefusal, PARKED_SPOT_DRIFT_M } =
  await import('./vehicles.js');

class TestStreet extends StreetRoom {
  protected override loadPlayer(userId: string): Promise<PlayerState> {
    const p = new PlayerState();
    p.userId = userId;
    return Promise.resolve(p);
  }
}

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}
function fakeClient(sessionId: string): {
  sessionId: string;
  sent: Sent[];
  send: (t: string, p: Record<string, unknown>) => void;
  view?: unknown;
} {
  const sent: Sent[] = [];
  return { sessionId, sent, send: (type, payload) => sent.push({ type, payload }) };
}

// A 2 km square island, timeline district is the west half.
const ISLAND: Array<[number, number]> = [
  [-1000, -1000],
  [1000, -1000],
  [1000, 1000],
  [-1000, 1000],
];
const TIMELINE: Array<[number, number]> = [
  [-1000, -1000],
  [0, -1000],
  [0, 1000],
  [-1000, 1000],
];

type AnyRoom = Record<string, (...a: unknown[]) => unknown> & { presence: unknown };
async function boot<T>(
  Ctor: new () => T,
  presence: LocalPresence,
  opts: unknown,
): Promise<AnyRoom> {
  const room = new Ctor() as unknown as AnyRoom;
  room.presence = presence;
  room.setSimulationInterval = () => undefined;
  await room.onCreate!(opts);
  // A started room binds its state to an encoder; do it by hand here so
  // StateView works.
  new Encoder((room as unknown as { state: Schema }).state);
  return room;
}
/** Dispatch a message; await the result to let async handlers finish. */
function msg(room: AnyRoom, name: string, client: unknown, payload: unknown): Promise<void> {
  const handlers = (
    room as unknown as {
      onMessageEvents: { events: Record<string, Array<(c: unknown, m: unknown) => unknown>> };
    }
  ).onMessageEvents.events;
  handlers[name]![0]!(client, payload);
  return new Promise((r) => setTimeout(r, 0));
}

interface HeatCall {
  userId: string;
  delta: number;
  source: string;
  refId: string;
}
const jailed = new Set<string>();
const heatCalls: HeatCall[] = [];

// Decor parked cars the tests register (contract/ids/parked_cars.json stand-ins).
const CAR1 = 'park_moped_20_0';
const MINE = 'park_compact_10_0';
const CAR_A = 'park_sports_10_0';
const CAR_A_SUV = 'park_suv_10_0';
const TEST_SPOTS = [
  { id: 'parked_t1', x: 2, z: 0, kinds: ['moped'] },
  { id: 'parked_t2', x: 1, z: 0, kinds: ['compact', 'sports', 'suv'] },
  { id: 'parked_t3', x: 0, z: 0, kinds: ['suv'] },
  { id: 'parked_t4', x: 3, z: 0, kinds: ['compact'] },
];

let now = 1_000_000;
beforeEach(() => {
  setParkedSpots(TEST_SPOTS);
  jailed.clear();
  heatCalls.length = 0;
  setVehicleCrimeHooks({
    isJailed: async (u) => jailed.has(u),
    raiseHeat: async (userId, delta, source, refId) => {
      heatCalls.push({ userId, delta, source, refId });
    },
  });
  setIslandGeometry({ island: [ISLAND], districts: { timeline: TIMELINE } });
  setParkingBays([]);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  setVehicleCrimeHooks(null);
  setIslandGeometry(null);
  setParkingBays(null);
  setParkedSpots(null);
  vi.restoreAllMocks();
});

describe('StreetRoom', () => {
  it('refuses a district whose polygon is not set', async () => {
    await expect(boot(TestStreet, new LocalPresence(), { district: 'islet' })).rejects.toThrow(
      /bounds not set/,
    );
  });

  it('opens a room for every district in the real districts.json', async () => {
    setIslandGeometry(null);
    for (const district of DISTRICTS) {
      await expect(boot(TestStreet, new LocalPresence(), { district })).resolves.toBeDefined();
    }
  });

  it('places on first move, clamps a teleport and stays in bounds', async () => {
    const presence = new LocalPresence();
    const room = await boot(TestStreet, presence, { district: 'timeline' });
    const c = fakeClient('s1');
    await room.onJoin!(c, { userId: 'u1' });
    const players = (room as unknown as { state: { players: Map<string, PlayerState> } }).state
      .players;
    expect(players.size).toBe(0);

    msg(room, 'move', c, { x: -100, z: 0 });
    expect(players.get('s1')?.x).toBe(-100);

    now += 100;
    msg(room, 'move', c, { x: -50, z: 0 });
    const p = players.get('s1')!;
    expect(p.x).toBeLessThan(-98);
    expect(c.sent.some((s) => s.type === 'corrected')).toBe(true);

    // 30 m border into the next district is fine, past it is not.
    const sess = (room as unknown as { sessions: Map<string, { anchor: unknown }> }).sessions.get(
      's1',
    )!;
    now += 60_000;
    sess.anchor = { x: 20, z: 0, at: now, budget: 7 };
    msg(room, 'move', c, { x: 25, z: 0 });
    expect(p.x).toBeCloseTo(25);
    now += 1000;
    sess.anchor = { x: 28, z: 0, at: now, budget: 7 };
    msg(room, 'move', c, { x: 33, z: 0 });
    expect(c.sent.at(-1)?.payload.code).toBe('OUT_OF_BOUNDS');
    expect(p.x).toBeCloseTo(25);
  });

  it('accepts a first move onto the casino pier pad and rejects the sea beyond it', async () => {
    setIslandGeometry(null); // the real districts.json
    const room = await boot(TestStreet, new LocalPresence(), { district: 'boardwalk' });
    const c = fakeClient('pier');
    await room.onJoin!(c, { userId: 'pier-u' });
    const players = (room as unknown as { state: { players: Map<string, PlayerState> } }).state
      .players;
    msg(room, 'move', c, { x: 126, z: -290 });
    expect(c.sent.at(-1)?.payload.code).toBe('OUT_OF_BOUNDS');
    expect(players.size).toBe(0);
    msg(room, 'move', c, { x: 126, z: -262 });
    expect(
      c.sent.some(
        (s) =>
          s.type === 'rejected' && s.payload.code === 'OUT_OF_BOUNDS' && s.payload.x !== undefined,
      ),
    ).toBe(false);
    expect(players.get('pier')?.x).toBe(126);
    expect(players.get('pier')?.z).toBe(-262);
  });

  it('anchors a join on the last position from another room', async () => {
    const presence = new LocalPresence();
    await presence.hset(POS_HASH, 'u2', encodePos({ x: -10, z: 0, at: now - 200 }));
    const room = await boot(TestStreet, presence, { district: 'timeline' });
    const c = fakeClient('s2');
    await room.onJoin!(c, { userId: 'u2' });
    msg(room, 'move', c, { x: -500, z: 0 }); // far teleport on join
    expect(c.sent.some((s) => s.type === 'corrected')).toBe(true);
  });

  it('accepts the first move at a vehicle exit without the walking rule', async () => {
    const presence = new LocalPresence();
    const room = await boot(TestStreet, presence, { district: 'timeline' });
    const c = fakeClient('s3');
    await room.onJoin!(c, { userId: 'u3' });
    msg(room, 'move', c, { x: -900, z: 0 });
    now += 3000;
    (room as unknown as { handleVehicleExit: (d: unknown) => void }).handleVehicleExit({
      userId: 'u3',
      x: -300,
      z: 0,
      at: now,
    });
    now += 100;
    c.sent.length = 0;
    msg(room, 'move', c, { x: -301, z: 1 });
    expect(c.sent.some((s) => s.type === 'corrected')).toBe(false);
  });
});

describe('StreetRoom rejoin position', () => {
  type Sess = { anchor: { x: number; z: number; at: number } | null; placed: boolean };
  const players = (room: AnyRoom): Map<string, PlayerState> =>
    (room as unknown as { state: { players: Map<string, PlayerState> } }).state.players;
  const session = (room: AnyRoom, id: string): Sess =>
    (room as unknown as { sessions: Map<string, Sess> }).sessions.get(id)!;

  /** Presence holding the player's last accepted move, a room, and a joined client. */
  async function rejoin(
    last: { x: number; z: number; at: number } | null,
    options: Record<string, unknown>,
  ): Promise<{ room: AnyRoom; c: ReturnType<typeof fakeClient>; presence: LocalPresence }> {
    const presence = new LocalPresence();
    if (last) await presence.hset(POS_HASH, 'r1', encodePos(last));
    const room = await boot(TestStreet, presence, { district: 'timeline' });
    const c = fakeClient('r1');
    await room.onJoin!(c, { userId: 'r1', token: 't', district: 'timeline', ...options });
    return { room, c, presence };
  }

  it('1: accepts a join spot within walking reach; the first move there is not corrected', async () => {
    // 50 m away after 10 s: reach is 6.5 x 10 + 0.5 = 65.5 m.
    const { room, c } = await rejoin({ x: -60, z: 0, at: now - 10_000 }, { x: -10, z: 0 });
    expect(session(room, 'r1').anchor).toMatchObject({ x: -10, z: 0, at: now });
    now += 100;
    msg(room, 'move', c, { x: -10, z: 0 });
    expect(players(room).get('r1')?.x).toBe(-10);
    expect(c.sent.some((s) => s.type === 'corrected' || s.type === 'rejected')).toBe(false);
  });

  it('2: ignores a join spot beyond the reach; the first move is clamped near the stored spot', async () => {
    // 190 m away after 10 s.
    const { room, c } = await rejoin({ x: -200, z: 0, at: now - 10_000 }, { x: -10, z: 0 });
    now += 100;
    msg(room, 'move', c, { x: -10, z: 0 });
    const p = players(room).get('r1')!;
    expect(Math.hypot(p.x + 200, p.z)).toBeLessThanOrEqual(7 + 1e-9);
    expect(c.sent.some((s) => s.type === 'corrected')).toBe(true);
  });

  it('3: ignores a join spot in reach but outside the district border', async () => {
    // 23 m away, but x = 33 is past the 30 m border of TIMELINE (x <= 0).
    const { room, c } = await rejoin({ x: 10, z: 0, at: now - 10_000 }, { x: 33, z: 0 });
    expect(session(room, 'r1').anchor).toMatchObject({ x: 10, z: 0, at: now - 10_000 });
    expect(c.sent.some((s) => s.type === 'rejected')).toBe(false);
  });

  it('4: onLeave stores the time of the last accepted move, not the leave time', async () => {
    const { room, c, presence } = await rejoin(null, {});
    const t0 = now;
    msg(room, 'move', c, { x: -100, z: 0 });
    now += 100; // inside the 250 ms write throttle: accepted but not written yet
    const t1 = now;
    msg(room, 'move', c, { x: -100, z: 0.5 });
    now += 8_000; // the dropped socket is only noticed now
    room.onLeave!(c);
    await new Promise((r) => setTimeout(r, 0));
    const pos = decodePos(await presence.hget(POS_HASH, 'r1'));
    expect(pos).toEqual({ x: -100, z: 0.5, at: t1 });
    expect(pos?.at).not.toBe(t0 + 8_100);
  });

  it('abuse: a huge in-bounds jump is ignored', async () => {
    // About 1,800 m across the district after 10 s.
    const { room, c } = await rejoin({ x: -990, z: 900, at: now - 10_000 }, { x: -10, z: -900 });
    expect(session(room, 'r1').anchor).toMatchObject({ x: -990, z: 900 });
    now += 100;
    msg(room, 'move', c, { x: -10, z: -900 });
    expect(c.sent.some((s) => s.type === 'corrected')).toBe(true);
    expect(players(room).get('r1')!.z).toBeGreaterThan(890);
  });

  it('abuse: a spot in reach but off the island is ignored', async () => {
    const { room } = await rejoin({ x: -990, z: 0, at: now - 10_000 }, { x: -1010, z: 0 });
    expect(session(room, 'r1').anchor).toMatchObject({ x: -990, z: 0 });
  });

  it('abuse: the reach counts from the stored move time, so a short drop allows only a short walk', async () => {
    // 2 s since the last accepted move: reach 13.5 m, asked 50 m.
    const { room } = await rejoin({ x: -60, z: 0, at: now - 2_000 }, { x: -10, z: 0 });
    expect(session(room, 'r1').anchor).toMatchObject({ x: -60, z: 0 });
  });

  it('abuse: a stored time in the future grants only the slack', async () => {
    const { room } = await rejoin({ x: -60, z: 0, at: now + 60_000 }, { x: -59, z: 0 });
    expect(session(room, 'r1').anchor).toMatchObject({ x: -60, z: 0 });
    const near = await rejoin({ x: -60, z: 0, at: now + 60_000 }, { x: -59.6, z: 0 });
    expect(session(near.room, 'r1').anchor).toMatchObject({ x: -59.6, z: 0 });
  });

  it('abuse: an old stored position (over 30 s) is not a rejoin; the spot is not used', async () => {
    const { room, c } = await rejoin({ x: -60, z: 0, at: now - 31_000 }, { x: -10, z: 0 });
    // Today's stale case: no anchor, not shown until the first in-bounds move.
    expect(session(room, 'r1').anchor).toBeNull();
    expect(players(room).size).toBe(0);
    msg(room, 'move', c, { x: 40, z: 0 });
    expect(c.sent.at(-1)?.payload.code).toBe('OUT_OF_BOUNDS');
    expect(players(room).size).toBe(0);
  });

  it('abuse: malformed join spots fall back silently', async () => {
    const bad: Array<Record<string, unknown>> = [
      { x: 'abc', z: 0 },
      { x: Number.NaN, z: 0 },
      { x: Number.POSITIVE_INFINITY, z: 0 },
      { x: -10 },
      { x: -10, z: null },
    ];
    for (const options of bad) {
      const { room, c } = await rejoin({ x: -60, z: 0, at: now - 10_000 }, options);
      expect(session(room, 'r1').anchor).toMatchObject({ x: -60, z: 0, at: now - 10_000 });
      expect(c.sent.map((s) => s.type)).toEqual(['welcome']);
    }
  });

  it('abuse: joining without moving does not move the stored position', async () => {
    const at = now - 10_000;
    const first = await rejoin({ x: -60, z: 0, at }, { x: -10, z: 0 });
    first.room.onLeave!(first.c); // never moved, so nothing is written
    await new Promise((r) => setTimeout(r, 0));
    expect(decodePos(await first.presence.hget(POS_HASH, 'r1'))).toEqual({ x: -60, z: 0, at });
  });
});

describe('VehiclesRoom', () => {
  async function setup(): Promise<{ room: AnyRoom; presence: LocalPresence }> {
    const presence = new LocalPresence();
    const room = await boot(VehiclesRoom, presence, {});
    return { room, presence };
  }

  it('enter, drive with speed clamp, exit publishes the exit spot', async () => {
    const { room, presence } = await setup();
    const exits: unknown[] = [];
    await presence.subscribe('ctl:vehicle_exit', (d: unknown) => exits.push(d));
    await presence.hset(POS_HASH, 'u1', encodePos({ x: 0, z: 0, at: now }));
    const c = fakeClient('s1');
    await room.onJoin!(c, { userId: 'u1' });
    await msg(room, 'vehicle_enter', c, { id: CAR1, kind: 'moped', x: 2, y: 0, z: 0, yaw: 0 });
    const vehicles = (
      room as unknown as {
        state: { vehicles: Map<string, { driver: string; x: number; speed: number }> };
      }
    ).state.vehicles;
    expect(vehicles.get(CAR1)?.driver).toBe('u1');

    now += 100;
    msg(room, 'vehicle_move', c, {
      id: CAR1,
      x: 50,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: 99,
    });
    const v = vehicles.get(CAR1)!;
    expect(v.x).toBeLessThan(10); // moped cap 25 m/s
    expect(v.speed).toBe(25);
    expect(c.sent.some((s) => s.type === 'vehicle_corrected')).toBe(true);

    msg(room, 'vehicle_exit', c, { id: CAR1, x: v.x, z: 0, yaw: 1 });
    expect(v.driver).toBe('');
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toHaveLength(1);
  });

  it('parks a server car on each valid bay and brings an abandoned one back', async () => {
    setParkingBays([
      { id: 'bay_1', kind: 'compact', x: 10, y: 0, z: 0, yaw: 0 },
      { id: 'bay_bad', kind: 'tank', x: 0, y: 0, z: 0, yaw: 0 },
    ]);
    const { room, presence } = await setup();
    const vehicles = (
      room as unknown as { state: { vehicles: Map<string, { x: number; driver: string }> } }
    ).state.vehicles;
    expect([...vehicles.keys()]).toEqual(['bay_1']);

    await presence.hset(POS_HASH, 'u1', encodePos({ x: 10, z: 0, at: now }));
    const c = fakeClient('s1');
    await room.onJoin!(c, { userId: 'u1' });
    await msg(room, 'vehicle_enter', c, { id: 'bay_1' });
    expect(vehicles.get('bay_1')?.driver).toBe('u1');
    for (let i = 1; i <= 10; i++) {
      now += 1000;
      await msg(room, 'vehicle_move', c, {
        id: 'bay_1',
        x: 10 + i * 50,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        roll: 0,
        speed: 50,
      });
    }
    await msg(room, 'vehicle_exit', c, { id: 'bay_1', x: vehicles.get('bay_1')!.x, z: 0, yaw: 0 });
    room.onLeave!(c);
    await presence.hdel(POS_HASH, 'u1');
    now += 11 * 60_000;
    await (room as unknown as { tick: (t: number) => Promise<void> }).tick(now);
    expect(vehicles.get('bay_1')?.x).toBe(10);
  });

  it('rejects a taken vehicle and a far one', async () => {
    const { room, presence } = await setup();
    await presence.hset(POS_HASH, 'a', encodePos({ x: 0, z: 0, at: now }));
    await presence.hset(POS_HASH, 'b', encodePos({ x: 100, z: 0, at: now }));
    const a = fakeClient('sa');
    const b = fakeClient('sb');
    await room.onJoin!(a, { userId: 'a' });
    await room.onJoin!(b, { userId: 'b' });
    await msg(room, 'vehicle_enter', a, { id: 'park_suv_10_0', kind: 'suv', x: 1, z: 0 });
    await msg(room, 'vehicle_enter', b, { id: 'park_suv_10_0' });
    expect(b.sent.at(-1)?.payload.code).toBe('VEHICLE_TAKEN');
    await msg(room, 'vehicle_enter', b, { id: 'park_suv_0_0', kind: 'suv', x: 0, z: 0 });
    expect(b.sent.at(-1)?.payload.code).toBe('VEHICLE_TOO_FAR');
  });

  it('only shows nearby vehicles and relays hits to the victim only', async () => {
    const { room, presence } = await setup();
    await presence.hset(POS_HASH, 'driver', encodePos({ x: 0, z: 0, at: now }));
    await presence.hset(POS_HASH, 'near', encodePos({ x: 5, z: 0, at: now }));
    await presence.hset(POS_HASH, 'far', encodePos({ x: 800, z: 0, at: now }));
    const d = fakeClient('sd');
    const n = fakeClient('sn');
    const f = fakeClient('sf');
    await room.onJoin!(d, { userId: 'driver' });
    await room.onJoin!(n, { userId: 'near' });
    await room.onJoin!(f, { userId: 'far' });
    await msg(room, 'vehicle_enter', d, { id: 'park_sports_10_0', kind: 'sports', x: 1, z: 0 });
    await (room as unknown as { tick: (t: number) => Promise<void> }).tick(now);
    const car = (
      room as unknown as { state: { vehicles: Map<string, object> } }
    ).state.vehicles.get('park_sports_10_0')!;
    const has = (c: { view?: unknown }): boolean =>
      (c.view as { has: (o: object) => boolean }).has(car);
    expect(has(d)).toBe(true);
    expect(has(n)).toBe(true);
    expect(has(f)).toBe(false);

    now += 500;
    msg(room, 'vehicle_move', d, {
      id: 'park_sports_10_0',
      x: 4,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: 15,
    });
    await msg(room, 'vehicle_hit', d, { victim: 'near', velocity: { x: 15, y: 2, z: 0 } });
    expect(n.sent.filter((s) => s.type === 'vehicle_hit')).toHaveLength(1);
    expect(f.sent.some((s) => s.type === 'vehicle_hit')).toBe(false);
    // Rate limited per victim.
    now += 200;
    await msg(room, 'vehicle_hit', d, { victim: 'near', velocity: { x: 15, y: 2, z: 0 } });
    expect(n.sent.filter((s) => s.type === 'vehicle_hit')).toHaveLength(1);
    // Too far.
    now += 2000;
    await msg(room, 'vehicle_hit', d, { victim: 'far', velocity: { x: 15, y: 0, z: 0 } });
    expect(f.sent.some((s) => s.type === 'vehicle_hit')).toBe(false);
  });
});

describe('carjacking', () => {
  async function two(): Promise<{
    room: AnyRoom;
    presence: LocalPresence;
    a: ReturnType<typeof fakeClient>;
    b: ReturnType<typeof fakeClient>;
  }> {
    const presence = new LocalPresence();
    const room = await boot(VehiclesRoom, presence, {});
    await presence.hset(POS_HASH, 'a', encodePos({ x: 0, z: 0, at: now }));
    await presence.hset(POS_HASH, 'b', encodePos({ x: 2, z: 0, at: now }));
    const a = fakeClient('sa');
    const b = fakeClient('sb');
    await room.onJoin!(a, { userId: 'a' });
    await room.onJoin!(b, { userId: 'b' });
    return { room, presence, a, b };
  }
  const vehicles = (room: AnyRoom): Map<string, { driver: string; x: number; z: number }> =>
    (
      room as unknown as {
        state: { vehicles: Map<string, { driver: string; x: number; z: number }> };
      }
    ).state.vehicles;
  const metaOf = (room: AnyRoom, id: string): { spawnedBy: string | null } =>
    (room as unknown as { meta: Map<string, { spawnedBy: string | null }> }).meta.get(id)!;
  const lastCode = (c: ReturnType<typeof fakeClient>): unknown => c.sent.at(-1)?.payload.code;

  it('lets the player into their parked car when its stored pose trails the real one, within limits', async () => {
    const { room, presence, a } = await two();
    await msg(room, 'vehicle_enter', a, { id: MINE, kind: 'compact', x: 1, z: 0 });
    msg(room, 'vehicle_exit', a, { id: MINE, x: 1, z: 0, yaw: 0 });
    const car = vehicles(room).get(MINE)!;
    expect(car.driver).toBe('');

    // The real car rolled on to x = 40 but the server still has x = 20; the player stands by the real one.
    car.x = 20;
    now += 2_000;
    await presence.hset(POS_HASH, 'a', encodePos({ x: 41, z: 0, at: now }));
    await msg(room, 'vehicle_enter', a, { id: MINE, kind: 'compact', x: 40, z: 0 });
    expect(car.driver).toBe('a');
    expect(car.x).toBe(40);
    msg(room, 'vehicle_exit', a, { id: MINE, x: 40, z: 0, yaw: 0 });

    // A claimed pose far from the stored one is still refused, and the car stays put.
    now += 2_000;
    await presence.hset(POS_HASH, 'a', encodePos({ x: 141, z: 0, at: now }));
    await msg(room, 'vehicle_enter', a, { id: MINE, kind: 'compact', x: 140, z: 0 });
    expect(lastCode(a)).toBe('VEHICLE_TOO_FAR');
    expect(car.x).toBe(40);
    expect(car.driver).toBe('');
  });

  it('steals an NPC traffic car with steal:true and adds heat; without the flag it asks for it', async () => {
    const { room, b } = await two();
    await msg(room, 'vehicle_enter', b, { id: 'traffic_7', kind: 'compact', x: 3, z: 0 });
    expect(lastCode(b)).toBe('STEAL_REQUIRED');
    expect(heatCalls).toHaveLength(0);
    await msg(room, 'vehicle_enter', b, {
      id: 'traffic_7',
      kind: 'compact',
      x: 3,
      z: 0,
      steal: true,
    });
    expect(vehicles(room).get('traffic_7')?.driver).toBe('b');
    expect(heatCalls).toEqual([{ userId: 'b', delta: 8, source: 'steal_npc', refId: 'traffic_7' }]);
  });

  it('validates distance server-side and rate limits steals', async () => {
    const { room, presence, b } = await two();
    await msg(room, 'vehicle_enter', b, {
      id: 'traffic_far',
      kind: 'compact',
      x: 30,
      z: 0,
      steal: true,
    });
    expect(lastCode(b)).toBe('VEHICLE_TOO_FAR');
    expect(heatCalls).toHaveLength(0);

    await msg(room, 'vehicle_enter', b, {
      id: 'traffic_1',
      kind: 'compact',
      x: 3,
      z: 0,
      steal: true,
    });
    msg(room, 'vehicle_exit', b, { id: 'traffic_1', x: 3, z: 0, yaw: 0 });
    now += 2_000;
    await msg(room, 'vehicle_enter', b, {
      id: 'traffic_2',
      kind: 'compact',
      x: 3,
      z: 0,
      steal: true,
    });
    expect(lastCode(b)).toBe('RATE_LIMITED');
    expect(heatCalls).toHaveLength(1);
    now += 15_000;
    await presence.hset(POS_HASH, 'b', encodePos({ x: 2, z: 0, at: now }));
    await msg(room, 'vehicle_enter', b, {
      id: 'traffic_2',
      kind: 'compact',
      x: 3,
      z: 0,
      steal: true,
    });
    expect(vehicles(room).get('traffic_2')?.driver).toBe('b');
    expect(heatCalls).toHaveLength(2);
  });

  it('steals a parked player-owned car, tells the owner, never transfers ownership, and hands it back', async () => {
    const { room, a, b } = await two();
    await msg(room, 'vehicle_enter', a, { id: CAR_A, kind: 'sports', x: 1, z: 0 });
    msg(room, 'vehicle_exit', a, { id: CAR_A, x: 1, z: 0, yaw: 0 });
    expect(vehicles(room).get(CAR_A)?.driver).toBe('');

    await msg(room, 'vehicle_enter', b, { id: CAR_A });
    expect(lastCode(b)).toBe('STEAL_REQUIRED');
    await msg(room, 'vehicle_enter', b, { id: CAR_A, steal: true });
    expect(vehicles(room).get(CAR_A)?.driver).toBe('b');
    expect(heatCalls).toEqual([{ userId: 'b', delta: 15, source: 'steal_player', refId: CAR_A }]);
    expect(metaOf(room, CAR_A).spawnedBy).toBe('a');
    const stolen = a.sent.find((m) => m.type === 'vehicle_stolen');
    expect(stolen?.payload).toMatchObject({ vehicleId: CAR_A, kind: 'sports', by: 'b' });

    // Driven away and parked elsewhere: it returns to where the owner left it.
    now += 1_000;
    await msg(room, 'vehicle_move', b, {
      id: CAR_A,
      x: 40,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: 30,
    });
    await msg(room, 'vehicle_exit', b, {
      id: CAR_A,
      x: vehicles(room).get(CAR_A)!.x,
      z: 0,
      yaw: 0,
    });
    expect(vehicles(room).get(CAR_A)?.x).toBe(1);
    expect(vehicles(room).get(CAR_A)?.driver).toBe('');
    expect(metaOf(room, CAR_A).spawnedBy).toBe('a');
    expect(a.sent.some((m) => m.type === 'vehicle_returned')).toBe(true);
  });

  it('hands a stolen player car back after 3 minutes even if still driven', async () => {
    const { room, a, b } = await two();
    await msg(room, 'vehicle_enter', a, { id: CAR_A_SUV, kind: 'suv', x: 1, z: 0 });
    msg(room, 'vehicle_exit', a, { id: CAR_A_SUV, x: 1, z: 0, yaw: 0 });
    await msg(room, 'vehicle_enter', b, { id: CAR_A_SUV, steal: true });
    expect(vehicles(room).get(CAR_A_SUV)?.driver).toBe('b');
    now += 3 * 60_000 + 1_000;
    await (room as unknown as { tick: (t: number) => Promise<void> }).tick(now);
    expect(vehicles(room).get(CAR_A_SUV)?.driver).toBe('');
    expect(vehicles(room).get(CAR_A_SUV)?.x).toBe(1);
    expect(
      b.sent.some((m) => m.type === 'vehicle_returned' && m.payload.reason === 'timeout'),
    ).toBe(true);
    expect(a.sent.some((m) => m.type === 'vehicle_returned')).toBe(true);
  });

  it('refuses to steal a vehicle a player is driving', async () => {
    const { room, a, b } = await two();
    await msg(room, 'vehicle_enter', a, { id: CAR_A_SUV, kind: 'suv', x: 1, z: 0 });
    await msg(room, 'vehicle_enter', b, { id: CAR_A_SUV, steal: true });
    expect(lastCode(b)).toBe('VEHICLE_TAKEN');
    expect(vehicles(room).get(CAR_A_SUV)?.driver).toBe('a');
    expect(heatCalls).toHaveLength(0);
  });

  it('never steals the hovercar: traffic roadstar or a player-owned one', async () => {
    const { room, b } = await two();
    await msg(room, 'vehicle_enter', b, {
      id: 'traffic_hover',
      kind: 'roadstar',
      x: 3,
      z: 0,
      steal: true,
    });
    expect(lastCode(b)).toBe('VEHICLE_NOT_STEALABLE');
    expect(vehicles(room).has('traffic_hover')).toBe(false);

    // A roadstar parked by player a (seeded straight into the room; owning it needs the pass).
    const v = new VehicleState();
    v.id = 'hoverA';
    v.kind = 'roadstar';
    v.x = 1;
    v.z = 0;
    (room as unknown as { state: { vehicles: Map<string, object> } }).state.vehicles.set(
      'hoverA',
      v,
    );
    (room as unknown as { meta: Map<string, object> }).meta.set('hoverA', {
      spawnedBy: 'a',
      bay: null,
      spawnedAt: now,
      driverSession: null,
      at: now,
      budget: 0,
      idleSince: now,
      stolen: null,
    });
    await msg(room, 'vehicle_enter', b, { id: 'hoverA', steal: true });
    expect(lastCode(b)).toBe('VEHICLE_NOT_STEALABLE');
    expect(vehicles(room).get('hoverA')?.driver).toBe('');
    expect(heatCalls).toHaveLength(0);
  });

  it('a jailed player cannot enter any vehicle', async () => {
    const { room, b } = await two();
    jailed.add('b');
    await msg(room, 'vehicle_enter', b, { id: 'park_compact_30_0', kind: 'compact', x: 3, z: 0 });
    expect(lastCode(b)).toBe('JAILED');
    expect(vehicles(room).has('park_compact_30_0')).toBe(false);
  });

  it('hitting a player adds heat, at most once per 10 s', async () => {
    const { room, presence, a, b } = await two();
    await msg(room, 'vehicle_enter', a, { id: CAR_A, kind: 'sports', x: 1, z: 0 });
    await presence.hset(POS_HASH, 'b', encodePos({ x: 5, z: 0, at: now }));
    now += 500;
    msg(room, 'vehicle_move', a, {
      id: CAR_A,
      x: 4,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: 15,
    });
    await msg(room, 'vehicle_hit', a, { victim: 'b', velocity: { x: 15, y: 2, z: 0 } });
    expect(b.sent.filter((m) => m.type === 'vehicle_hit')).toHaveLength(1);
    expect(heatCalls).toEqual([{ userId: 'a', delta: 3, source: 'vehicle_hit', refId: 'b' }]);
    now += 2_000;
    await presence.hset(POS_HASH, 'b', encodePos({ x: 5, z: 0, at: now }));
    await msg(room, 'vehicle_hit', a, { victim: 'b', velocity: { x: 15, y: 2, z: 0 } });
    expect(b.sent.filter((m) => m.type === 'vehicle_hit')).toHaveLength(2);
    expect(heatCalls).toHaveLength(1);
    now += 9_000;
    await presence.hset(POS_HASH, 'b', encodePos({ x: 5, z: 0, at: now }));
    await msg(room, 'vehicle_hit', a, { victim: 'b', velocity: { x: 15, y: 2, z: 0 } });
    expect(heatCalls).toHaveLength(2);
  });
});

describe('vehicle registration (security fix: no conjured vehicles)', () => {
  const passHolders = new Set<string>();
  async function one(at = { x: 0, z: 0 }): Promise<{
    room: AnyRoom;
    c: ReturnType<typeof fakeClient>;
  }> {
    passHolders.clear();
    setVehicleCrimeHooks({
      isJailed: async () => false,
      raiseHeat: async (userId, delta, source, refId) => {
        heatCalls.push({ userId, delta, source, refId });
      },
      ownsHovercarPass: async (u) => passHolders.has(u),
    });
    const presence = new LocalPresence();
    const room = await boot(VehiclesRoom, presence, {});
    await presence.hset(POS_HASH, 'p', encodePos({ x: at.x, z: at.z, at: now }));
    const c = fakeClient('sp');
    await room.onJoin!(c, { userId: 'p' });
    return { room, c };
  }
  const vehicles = (room: AnyRoom): Map<string, { driver: string; kind: string }> =>
    (room as unknown as { state: { vehicles: Map<string, { driver: string; kind: string }> } })
      .state.vehicles;
  const lastCode = (c: ReturnType<typeof fakeClient>): unknown => c.sent.at(-1)?.payload.code;

  it('refuses to register a helicopter anywhere (no client may conjure one)', async () => {
    const { room, c } = await one();
    await msg(room, 'vehicle_enter', c, { id: 'park_heli_10_0', kind: 'heli', x: 1, z: 0 });
    expect(lastCode(c)).toBe('VEHICLE_KIND_NOT_ALLOWED');
    await msg(room, 'vehicle_enter', c, { id: 'my_heli', kind: 'heli', x: 1, y: 150, z: 0 });
    expect(lastCode(c)).toBe('VEHICLE_KIND_NOT_ALLOWED');
    expect(vehicles(room).size).toBe(0);
  });

  it('refuses a hijacked "traffic" helicopter, drone or other non-street kind', async () => {
    const { room, c } = await one();
    for (const kind of ['heli', 'drone']) {
      await msg(room, 'vehicle_enter', c, { id: `traffic_${kind}`, kind, x: 1, z: 0, steal: true });
      expect(lastCode(c)).toBe(kind === 'drone' ? 'NOT_ENTITLED' : 'VEHICLE_KIND_NOT_ALLOWED');
    }
    passHolders.add('p');
    await msg(room, 'vehicle_enter', c, {
      id: 'traffic_drone',
      kind: 'drone',
      x: 1,
      z: 0,
      steal: true,
    });
    expect(lastCode(c)).toBe('VEHICLE_KIND_NOT_ALLOWED');
    expect(vehicles(room).size).toBe(0);
    expect(heatCalls).toHaveLength(0);
  });

  it('a drone needs the hovercar pass, like the hovercar; with it, it registers as before', async () => {
    const { room, c } = await one();
    await msg(room, 'vehicle_enter', c, { id: 'drone_p', kind: 'drone', x: 1, z: 0 });
    expect(lastCode(c)).toBe('NOT_ENTITLED');
    await msg(room, 'vehicle_enter', c, { id: 'hover_p', kind: 'roadstar', x: 1, z: 0 });
    expect(lastCode(c)).toBe('NOT_ENTITLED');
    expect(vehicles(room).size).toBe(0);
    passHolders.add('p');
    await msg(room, 'vehicle_enter', c, { id: 'hover_p', kind: 'roadstar', x: 1, z: 0 });
    expect(vehicles(room).get('hover_p')?.driver).toBe('p');
  });

  it('a server-owned drone bay also needs the pass; a server-owned heli bay stays enterable', async () => {
    setParkingBays([
      { id: 'bay_drone', kind: 'drone', x: 1, y: 0, z: 0, yaw: 0 },
      { id: 'bay_heli', kind: 'heli', x: 2, y: 0, z: 0, yaw: 0 },
    ]);
    const { room, c } = await one();
    await msg(room, 'vehicle_enter', c, { id: 'bay_drone' });
    expect(lastCode(c)).toBe('NOT_ENTITLED');
    await msg(room, 'vehicle_enter', c, { id: 'bay_heli' });
    expect(vehicles(room).get('bay_heli')?.driver).toBe('p');
  });

  it('refuses a street car under a free-form id (the old "register it where I say" path)', async () => {
    const { room, c } = await one();
    await msg(room, 'vehicle_enter', c, { id: 'anything', kind: 'sports', x: 1, z: 0 });
    expect(lastCode(c)).toBe('VEHICLE_NOT_REGISTRABLE');
    expect(vehicles(room).size).toBe(0);
  });

  it('refuses a parked id with no decor car at that spot', async () => {
    const { room, c } = await one({ x: 50, z: 50 });
    await msg(room, 'vehicle_enter', c, {
      id: 'park_sports_500_500',
      kind: 'sports',
      x: 50,
      z: 50,
    });
    expect(lastCode(c)).toBe('VEHICLE_NOT_REGISTRABLE');
    expect(vehicles(room).size).toBe(0);
  });

  it('refuses a kind the spot does not park, and an id whose kind differs from the message', async () => {
    const { room, c } = await one();
    // parked_t4 at (3, 0) parks a compact only
    await msg(room, 'vehicle_enter', c, { id: 'park_sports_30_0', kind: 'sports', x: 3, z: 0 });
    expect(lastCode(c)).toBe('VEHICLE_NOT_REGISTRABLE');
    await msg(room, 'vehicle_enter', c, { id: 'park_compact_30_0', kind: 'sports', x: 3, z: 0 });
    expect(lastCode(c)).toBe('VEHICLE_NOT_REGISTRABLE');
    expect(vehicles(room).size).toBe(0);
  });

  it('refuses a real spot reported far from where the decor car stands', async () => {
    const { room, c } = await one({ x: 3 + PARKED_SPOT_DRIFT_M + 2, z: 0 });
    await msg(room, 'vehicle_enter', c, {
      id: 'park_compact_30_0',
      kind: 'compact',
      x: 3 + PARKED_SPOT_DRIFT_M + 1,
      z: 0,
    });
    expect(lastCode(c)).toBe('VEHICLE_NOT_REGISTRABLE');
    expect(vehicles(room).size).toBe(0);
  });

  it('refuses a real spot the player is not near (VEHICLE_TOO_FAR)', async () => {
    const { room, c } = await one({ x: 40, z: 0 });
    await msg(room, 'vehicle_enter', c, { id: 'park_compact_30_0', kind: 'compact', x: 3, z: 0 });
    expect(lastCode(c)).toBe('VEHICLE_TOO_FAR');
    expect(vehicles(room).size).toBe(0);
  });

  it('allows a real decor car within reach, a bumped one, and 1 dm of id rounding', async () => {
    const { room, c } = await one({ x: 3, z: 1 });
    await msg(room, 'vehicle_enter', c, {
      id: 'park_compact_31_-1',
      kind: 'compact',
      x: 4.5,
      z: 0.5,
    });
    expect(vehicles(room).get('park_compact_31_-1')?.driver).toBe('p');
  });

  it('keeps NPC traffic hijacks of street kinds working (steal rules unchanged)', async () => {
    const { room, c } = await one();
    await msg(room, 'vehicle_enter', c, { id: 'traffic_x', kind: 'taxi', x: 2, z: 0 });
    expect(lastCode(c)).toBe('STEAL_REQUIRED');
    await msg(room, 'vehicle_enter', c, { id: 'traffic_x', kind: 'taxi', x: 2, z: 0, steal: true });
    expect(vehicles(room).get('traffic_x')?.driver).toBe('p');
    expect(heatCalls).toHaveLength(1);
  });

  it('registrationRefusal covers every wire kind', () => {
    expect(registrationRefusal('park_compact_30_0', 'compact', 3, 0)).toBeNull();
    expect(registrationRefusal('traffic_1', 'van', 0, 0)).toBeNull();
    expect(registrationRefusal('x', 'roadstar', 0, 0)).toBeNull(); // the pass check runs separately
    expect(registrationRefusal('x', 'drone', 0, 0)).toBeNull();
    expect(registrationRefusal('x', 'heli', 0, 0)).toBe('VEHICLE_KIND_NOT_ALLOWED');
    expect(registrationRefusal('traffic_1', 'heli', 0, 0)).toBe('VEHICLE_KIND_NOT_ALLOWED');
    expect(registrationRefusal('traffic_1', 'roadstar', 0, 0)).toBe('VEHICLE_KIND_NOT_ALLOWED');
    expect(registrationRefusal('park_compact_30_0x', 'compact', 3, 0)).toBe(
      'VEHICLE_NOT_REGISTRABLE',
    );
  });

  it('every spot in the real contract/ids/parked_cars.json is registrable under its own id', () => {
    setParkedSpots(null);
    const spots = getParkedSpots();
    expect(spots.length).toBeGreaterThan(200);
    for (const s of spots) {
      for (const kind of s.kinds) {
        // The client's id: IslandProtocol.ParkedId rounds x*10 and z*10 away from zero.
        const r = (v: number): number => Math.sign(v) * Math.round(Math.abs(v) * 10);
        const id = `park_${kind}_${r(s.x)}_${r(s.z)}`;
        expect(parkedSpotFor(id)?.spot.id).toBeDefined();
        expect(registrationRefusal(id, kind, s.x, s.z)).toBeNull();
      }
    }
  });
});
