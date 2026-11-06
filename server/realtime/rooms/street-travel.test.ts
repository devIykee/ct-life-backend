/**
 * Street room Map Travel arrival (docs/TRAVEL.md, docs/REALTIME.md "Map Travel arrival"),
 * driven directly with an in-memory presence and an in-memory ticket store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalPresence, ServerError } from 'colyseus';
import { Encoder, type Schema } from '@colyseus/schema';
import { PlayerState } from '../../../contract/realtime/states.js';
import { decodePos, POS_HASH, setIslandGeometry } from '../movement.js';
import { travelTicketKey, type TicketRedis, type TravelTicket } from '../../application/travel.js';

vi.mock('../player.js', async (orig) => {
  const real = await orig<typeof import('../player.js')>();
  return { ...real, authenticateJoin: async (o: { userId: string }) => o.userId };
});

const { StreetRoom } = await import('./street.js');

/** A Redis stand-in with GET / SET / the compare-and-delete script. */
class FakeRedis implements TicketRedis {
  readonly kv = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.kv.set(key, value);
    return 'OK';
  }
  async eval(_script: string, _n: number, key: string, expected: string): Promise<unknown> {
    if (this.kv.get(key) !== expected) return 0;
    this.kv.delete(key);
    return 1;
  }
}

const redis = new FakeRedis();
const arrivals: Array<{ userId: string; tripId: string }> = [];
let travelOn = true;
/** What the guarded `UPDATE ... SET status = 'arrived'` does in this test. */
let arrivalDb: 'arrived' | 'no_row' | 'throws' = 'arrived';

class TestStreet extends StreetRoom {
  protected override loadPlayer(userId: string): Promise<PlayerState> {
    const p = new PlayerState();
    p.userId = userId;
    return Promise.resolve(p);
  }
  protected override travelOn(): boolean {
    return travelOn;
  }
  protected override async travelRedis(): Promise<TicketRedis> {
    return redis;
  }
  protected override async recordArrival(userId: string, t: TravelTicket): Promise<boolean> {
    if (arrivalDb === 'throws') throw new Error('db down');
    if (arrivalDb === 'no_row') return false;
    arrivals.push({ userId, tripId: t.tripId });
    return true;
  }
  protected override streetVoiceOn(): boolean {
    return false;
  }
}

function fakeClient(sessionId: string): {
  sessionId: string;
  sent: Array<{ type: string; payload: Record<string, unknown> }>;
  send: (t: string, p: Record<string, unknown>) => void;
} {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return { sessionId, sent, send: (type, payload) => sent.push({ type, payload }) };
}

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
async function boot(presence: LocalPresence, district = 'timeline'): Promise<AnyRoom> {
  const room = new TestStreet() as unknown as AnyRoom;
  room.presence = presence;
  room.setSimulationInterval = () => undefined;
  await room.onCreate!({ district });
  new Encoder((room as unknown as { state: Schema }).state);
  return room;
}

const TRIP = '0192f000-0000-7000-8000-000000000001';
const now = 5_000_000;

function ticket(over: Partial<TravelTicket> = {}): TravelTicket {
  return {
    tripId: TRIP,
    district: 'timeline',
    x: -120,
    z: 40,
    yaw: 1.5,
    arriveAt: now + 10_000,
    expiresAt: now + 130_000,
    ...over,
  };
}

async function joinError(room: AnyRoom, client: unknown, opts: unknown): Promise<ServerError> {
  try {
    await room.onJoin!(client, opts);
  } catch (e) {
    return e as ServerError;
  }
  throw new Error('join was accepted');
}

beforeEach(() => {
  redis.kv.clear();
  arrivals.length = 0;
  travelOn = true;
  arrivalDb = 'arrived';
  setIslandGeometry({ island: [ISLAND], districts: { timeline: TIMELINE } });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  setIslandGeometry(null);
  vi.restoreAllMocks();
});

describe('StreetRoom Map Travel arrival', () => {
  it('refuses an early arrival (4425) and keeps the ticket', async () => {
    const room = await boot(new LocalPresence());
    redis.kv.set(travelTicketKey('u1'), JSON.stringify(ticket()));
    const err = await joinError(room, fakeClient('s1'), { userId: 'u1', tripId: TRIP });
    expect(err).toBeInstanceOf(ServerError);
    expect(err.code).toBe(4425);
    expect(err.message).toBe('TRAVEL_NOT_ARRIVED');
    expect(redis.kv.has(travelTicketKey('u1'))).toBe(true);
  });

  it('anchors and shows the traveller at the ticket point, once', async () => {
    const presence = new LocalPresence();
    const room = await boot(presence);
    redis.kv.set(travelTicketKey('u1'), JSON.stringify(ticket({ arriveAt: now - 100 })));
    const c = fakeClient('s1');
    await room.onJoin!(c, { userId: 'u1', tripId: TRIP });
    const players = (room as unknown as { state: { players: Map<string, PlayerState> } }).state
      .players;
    const p = players.get('s1')!;
    expect([p.x, p.z, p.rotY]).toEqual([-120, 40, 1.5]);
    expect([p.ix, p.iz]).toEqual([-120, 40]);
    expect(decodePos(await presence.hget(POS_HASH, 'u1'))).toEqual({ x: -120, z: 40, at: now });
    expect(c.sent.find((m) => m.type === 'welcome')?.payload.travel).toEqual({
      tripId: TRIP,
      x: -120,
      z: 40,
      yaw: 1.5,
    });
    expect(redis.kv.has(travelTicketKey('u1'))).toBe(false);
    expect(arrivals).toEqual([{ userId: 'u1', tripId: TRIP }]);

    // The used ticket cannot be used again.
    const again = await joinError(room, fakeClient('s2'), { userId: 'u1', tripId: TRIP });
    expect(again.code).toBe(4410);
    expect(again.message).toBe('TRAVEL_TICKET_INVALID');
  });

  it('refuses another user, another district and an expired ticket (4410)', async () => {
    const room = await boot(new LocalPresence());
    redis.kv.set(travelTicketKey('u1'), JSON.stringify(ticket({ arriveAt: now - 100 })));
    expect((await joinError(room, fakeClient('s1'), { userId: 'u2', tripId: TRIP })).code).toBe(
      4410,
    );

    redis.kv.set(
      travelTicketKey('u3'),
      JSON.stringify(ticket({ arriveAt: now - 100, district: 'trenches' })),
    );
    expect((await joinError(room, fakeClient('s2'), { userId: 'u3', tripId: TRIP })).code).toBe(
      4410,
    );

    redis.kv.set(
      travelTicketKey('u4'),
      JSON.stringify(ticket({ arriveAt: now - 200_000, expiresAt: now - 1 })),
    );
    expect((await joinError(room, fakeClient('s3'), { userId: 'u4', tripId: TRIP })).code).toBe(
      4410,
    );
  });

  it('refuses a rider joining without the ticket (4409); others join as before', async () => {
    const room = await boot(new LocalPresence());
    redis.kv.set(travelTicketKey('u1'), JSON.stringify(ticket()));
    const err = await joinError(room, fakeClient('s1'), { userId: 'u1' });
    expect(err.code).toBe(4409);
    expect(err.message).toBe('TRAVEL_IN_TRANSIT');

    const c = fakeClient('s2');
    await room.onJoin!(c, { userId: 'u2' });
    expect(c.sent.find((m) => m.type === 'welcome')?.payload.travel).toBeUndefined();
  });

  it('ignores tickets and trip ids while travel is off', async () => {
    travelOn = false;
    const room = await boot(new LocalPresence());
    redis.kv.set(travelTicketKey('u1'), JSON.stringify(ticket()));
    const c = fakeClient('s1');
    await room.onJoin!(c, { userId: 'u1', tripId: TRIP });
    const players = (room as unknown as { state: { players: Map<string, PlayerState> } }).state
      .players;
    expect(players.size).toBe(0); // placed by the first move, as before
    expect(redis.kv.has(travelTicketKey('u1'))).toBe(true);
  });

  it.each(['no_row', 'throws'] as const)(
    'gives no ride when the guarded arrival update finds no booked trip (%s): 4410, nothing placed',
    async (mode) => {
      arrivalDb = mode;
      const presence = new LocalPresence();
      const room = await boot(presence);
      redis.kv.set(travelTicketKey('u1'), JSON.stringify(ticket({ arriveAt: now - 100 })));
      const err = await joinError(room, fakeClient('s1'), { userId: 'u1', tripId: TRIP });
      expect(err.code).toBe(4410);
      expect(err.message).toBe('TRAVEL_TICKET_INVALID');
      const players = (room as unknown as { state: { players: Map<string, PlayerState> } }).state
        .players;
      expect(players.size).toBe(0);
      expect(await presence.hget(POS_HASH, 'u1')).toBeFalsy();
      // The ticket is spent (the trip stays booked for the sweep to refund); a plain join works.
      expect(redis.kv.has(travelTicketKey('u1'))).toBe(false);
      const c = fakeClient('s2');
      await room.onJoin!(c, { userId: 'u1' });
      expect(c.sent.find((m) => m.type === 'welcome')?.payload.travel).toBeUndefined();
      expect(players.size).toBe(0); // normal spawn: placed by the first move
    },
  );

  it('refuses an arrival after the trip was cancelled (ticket gone): 4410, nothing placed', async () => {
    const room = await boot(new LocalPresence());
    // cancelTrip deleted the ticket.
    const err = await joinError(room, fakeClient('s1'), { userId: 'u1', tripId: TRIP });
    expect(err.code).toBe(4410);
    expect(arrivals).toEqual([]);
  });

  it('refuses a ticket exactly at expiresAt', async () => {
    const room = await boot(new LocalPresence());
    redis.kv.set(
      travelTicketKey('u1'),
      JSON.stringify(ticket({ arriveAt: now - 120_000, expiresAt: now })),
    );
    expect((await joinError(room, fakeClient('s1'), { userId: 'u1', tripId: TRIP })).code).toBe(
      4410,
    );
  });

  it('places a helicopter traveller on the arrival pad (real districts.json)', async () => {
    setIslandGeometry(null);
    const presence = new LocalPresence();
    const room = await boot(presence, 'mountain');
    // pad_mountain in contract/config/travel.json
    redis.kv.set(
      travelTicketKey('u1'),
      JSON.stringify(
        ticket({ district: 'mountain', x: -226, z: 428, yaw: 2.2, arriveAt: now - 100 }),
      ),
    );
    const c = fakeClient('s1');
    await room.onJoin!(c, { userId: 'u1', tripId: TRIP });
    const p = (
      room as unknown as { state: { players: Map<string, PlayerState> } }
    ).state.players.get('s1')!;
    expect([p.x, p.z, p.rotY]).toEqual([-226, 428, 2.2]);
    expect(decodePos(await presence.hget(POS_HASH, 'u1'))).toEqual({ x: -226, z: 428, at: now });
  });
});
