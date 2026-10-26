/**
 * A ban reaches every room type and every point of a join: live sessions are
 * closed in street, venue, home, city, market, space, video call and vehicles;
 * a ban published while a join is still awaiting leaves the user out of the room.
 */
import { describe, expect, it, vi } from 'vitest';
import { StreetRoom } from './street.js';
import { VenueRoom } from './venue.js';
import { HomeRoom } from './home.js';
import { CityRoom } from './city.js';
import { MarketRoom } from './market.js';
import { SpaceRoom } from './space.js';
import { VideoCallRoom } from './video-call.js';
import { VehiclesRoom } from './vehicles.js';
import { BAN_CHANNEL } from '../../application/moderation.js';

vi.mock('../player.js', async (orig) => {
  const real = await orig<typeof import('../player.js')>();
  return { ...real, authenticateJoin: async () => '00000000-0000-4000-8000-000000000001' };
});

const mkClient = (sessionId: string) => ({
  sessionId,
  left: [] as Array<[number, string]>,
  sent: [] as unknown[],
  leave(code: number, reason: string) {
    this.left.push([code, reason]);
  },
  send(...a: unknown[]) {
    this.sent.push(a);
  },
});

const ROOMS = {
  street: StreetRoom,
  venue: VenueRoom,
  home: HomeRoom,
  city: CityRoom,
  market: MarketRoom,
  space: SpaceRoom,
  video_call: VideoCallRoom,
  vehicles: VehiclesRoom,
} as const;

describe('ban kicks live sessions in every room type', () => {
  for (const [name, Ctor] of Object.entries(ROOMS)) {
    it(`${name}: closes every session of the banned user, only theirs`, async () => {
      const room: any = new Ctor();
      const clients = [mkClient('a1'), mkClient('a2'), mkClient('b1')];
      Object.defineProperty(room, 'clients', { value: clients, configurable: true });
      // The room's presence delivers BAN_CHANNEL payloads to the guard.
      let handler: ((m: unknown) => void) | undefined;
      room.presence = {
        subscribe: async (ch: string, fn: (m: unknown) => void) => {
          if (ch === BAN_CHANNEL) handler = fn;
        },
        unsubscribe: async () => {},
      };
      await room.ban.attach();
      room.ban.track(clients[0], 'bad');
      room.ban.track(clients[1], 'bad');
      room.ban.track(clients[2], 'good');
      handler!({ userId: 'bad' });
      expect(clients[0]!.left).toEqual([[4003, 'ACCOUNT_BANNED']]);
      expect(clients[1]!.left).toHaveLength(1);
      expect(clients[2]!.left).toHaveLength(0);
      handler!({ nope: true }); // malformed events are ignored
      expect(clients[2]!.left).toHaveLength(0);
    });
  }

  it('a user present in a video call and a market room is kicked from both', async () => {
    const mk = async (Ctor: any) => {
      const room: any = new Ctor();
      const c = mkClient('s-' + Math.random());
      Object.defineProperty(room, 'clients', { value: [c], configurable: true });
      let handler: ((m: unknown) => void) | undefined;
      room.presence = {
        subscribe: async (_c: string, fn: (m: unknown) => void) => (handler = fn),
        unsubscribe: async () => {},
      };
      await room.ban.attach();
      room.ban.track(c, 'u9');
      return { c, fire: () => handler!({ userId: 'u9' }) };
    };
    const call = await mk(VideoCallRoom);
    const market = await mk(MarketRoom);
    call.fire();
    market.fire();
    expect(call.c.left).toEqual([[4003, 'ACCOUNT_BANNED']]);
    expect(market.c.left).toEqual([[4003, 'ACCOUNT_BANNED']]);
  });
});

describe('TOCTOU: a ban fired mid-join', () => {
  it('street: the user never ends up in the room', async () => {
    const room: any = new StreetRoom();
    const client = mkClient('s1');
    Object.defineProperty(room, 'clients', { value: [client], configurable: true });
    room.state = { instanceId: 'i', players: new Map() };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The join is parked on its awaits after the token check.
    room.loadPlayer = async () => {
      await gate;
      return {};
    };
    room.readPos = async () => null;
    const joining = room.onJoin(client, { token: 'x' });
    await new Promise((r) => setTimeout(r, 10));
    room.ban.ban('00000000-0000-4000-8000-000000000001'); // the ban event lands here
    release();
    await expect(joining).rejects.toThrow('ACCOUNT_BANNED');
    expect(room.sessions.has('s1')).toBe(false);
    // The in-flight session was also told to leave.
    expect(client.left).toEqual([[4003, 'ACCOUNT_BANNED']]);
    // A late join by the same user in the next minutes is refused too.
    await expect(room.ban.confirm('00000000-0000-4000-8000-000000000001')).rejects.toThrow(
      'ACCOUNT_BANNED',
    );
  });
});
