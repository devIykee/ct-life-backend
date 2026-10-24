/**
 * Street and vehicles rooms, driven directly (no matchmaker) with an
 * in-memory presence standing in for Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalPresence } from 'colyseus';
import { Encoder, type Schema } from '@colyseus/schema';
import { PlayerState, VehicleState } from '../../../contract/realtime/states.js';
import { setIslandGeometry, setParkingBays, POS_HASH, encodePos, DISTRICTS } from '../movement.js';

vi.mock('../player.js', async (orig) => {
  const real = await orig<typeof import('../player.js')>();
  return {
    ...real,
    authenticateJoin: async (o: { userId: string }) => o.userId,
  };
});

const { StreetRoom } = await import('./street.js');
const { VehiclesRoom, setVehicleCrimeHooks } = await import('./vehicles.js');

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

let now = 1_000_000;
beforeEach(() => {
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
    await msg(room, 'vehicle_enter', c, { id: 'car1', kind: 'moped', x: 2, y: 0, z: 0, yaw: 0 });
    const vehicles = (
      room as unknown as {
        state: { vehicles: Map<string, { driver: string; x: number; speed: number }> };
      }
    ).state.vehicles;
    expect(vehicles.get('car1')?.driver).toBe('u1');

    now += 100;
    msg(room, 'vehicle_move', c, {
      id: 'car1',
      x: 50,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: 99,
    });
    const v = vehicles.get('car1')!;
    expect(v.x).toBeLessThan(10); // moped cap 25 m/s
    expect(v.speed).toBe(25);
    expect(c.sent.some((s) => s.type === 'vehicle_corrected')).toBe(true);

    msg(room, 'vehicle_exit', c, { id: 'car1', x: v.x, z: 0, yaw: 1 });
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
    await msg(room, 'vehicle_enter', a, { id: 'v', kind: 'suv', x: 1, z: 0 });
    await msg(room, 'vehicle_enter', b, { id: 'v' });
    expect(b.sent.at(-1)?.payload.code).toBe('VEHICLE_TAKEN');
    await msg(room, 'vehicle_enter', b, { id: 'w', kind: 'suv', x: 0, z: 0 });
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
    await msg(room, 'vehicle_enter', d, { id: 'car', kind: 'sports', x: 1, z: 0 });
    await (room as unknown as { tick: (t: number) => Promise<void> }).tick(now);
    const car = (
      room as unknown as { state: { vehicles: Map<string, object> } }
    ).state.vehicles.get('car')!;
    const has = (c: { view?: unknown }): boolean =>
      (c.view as { has: (o: object) => boolean }).has(car);
    expect(has(d)).toBe(true);
    expect(has(n)).toBe(true);
    expect(has(f)).toBe(false);

    now += 500;
    msg(room, 'vehicle_move', d, {
      id: 'car',
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
    await msg(room, 'vehicle_enter', a, { id: 'carA', kind: 'sports', x: 1, z: 0 });
    msg(room, 'vehicle_exit', a, { id: 'carA', x: 1, z: 0, yaw: 0 });
    expect(vehicles(room).get('carA')?.driver).toBe('');

    await msg(room, 'vehicle_enter', b, { id: 'carA' });
    expect(lastCode(b)).toBe('STEAL_REQUIRED');
    await msg(room, 'vehicle_enter', b, { id: 'carA', steal: true });
    expect(vehicles(room).get('carA')?.driver).toBe('b');
    expect(heatCalls).toEqual([{ userId: 'b', delta: 15, source: 'steal_player', refId: 'carA' }]);
    expect(metaOf(room, 'carA').spawnedBy).toBe('a');
    const stolen = a.sent.find((m) => m.type === 'vehicle_stolen');
    expect(stolen?.payload).toMatchObject({ vehicleId: 'carA', kind: 'sports', by: 'b' });

    // Driven away and parked elsewhere: it returns to where the owner left it.
    now += 1_000;
    await msg(room, 'vehicle_move', b, {
      id: 'carA',
      x: 40,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      speed: 30,
    });
    await msg(room, 'vehicle_exit', b, {
      id: 'carA',
      x: vehicles(room).get('carA')!.x,
      z: 0,
      yaw: 0,
    });
    expect(vehicles(room).get('carA')?.x).toBe(1);
    expect(vehicles(room).get('carA')?.driver).toBe('');
    expect(metaOf(room, 'carA').spawnedBy).toBe('a');
    expect(a.sent.some((m) => m.type === 'vehicle_returned')).toBe(true);
  });

  it('hands a stolen player car back after 3 minutes even if still driven', async () => {
    const { room, a, b } = await two();
    await msg(room, 'vehicle_enter', a, { id: 'carA', kind: 'suv', x: 1, z: 0 });
    msg(room, 'vehicle_exit', a, { id: 'carA', x: 1, z: 0, yaw: 0 });
    await msg(room, 'vehicle_enter', b, { id: 'carA', steal: true });
    expect(vehicles(room).get('carA')?.driver).toBe('b');
    now += 3 * 60_000 + 1_000;
    await (room as unknown as { tick: (t: number) => Promise<void> }).tick(now);
    expect(vehicles(room).get('carA')?.driver).toBe('');
    expect(vehicles(room).get('carA')?.x).toBe(1);
    expect(
      b.sent.some((m) => m.type === 'vehicle_returned' && m.payload.reason === 'timeout'),
    ).toBe(true);
    expect(a.sent.some((m) => m.type === 'vehicle_returned')).toBe(true);
  });

  it('refuses to steal a vehicle a player is driving', async () => {
    const { room, a, b } = await two();
    await msg(room, 'vehicle_enter', a, { id: 'carA', kind: 'suv', x: 1, z: 0 });
    await msg(room, 'vehicle_enter', b, { id: 'carA', steal: true });
    expect(lastCode(b)).toBe('VEHICLE_TAKEN');
    expect(vehicles(room).get('carA')?.driver).toBe('a');
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
    await msg(room, 'vehicle_enter', b, { id: 'mine', kind: 'compact', x: 3, z: 0 });
    expect(lastCode(b)).toBe('JAILED');
    expect(vehicles(room).has('mine')).toBe(false);
  });

  it('hitting a player adds heat, at most once per 10 s', async () => {
    const { room, presence, a, b } = await two();
    await msg(room, 'vehicle_enter', a, { id: 'carA', kind: 'sports', x: 1, z: 0 });
    await presence.hset(POS_HASH, 'b', encodePos({ x: 5, z: 0, at: now }));
    now += 500;
    msg(room, 'vehicle_move', a, {
      id: 'carA',
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
