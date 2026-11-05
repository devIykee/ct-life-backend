/**
 * A ban reaches every room type and every point of a join: live sessions are
 * closed in street, venue, home, city, market, space, video call and vehicles;
 * a ban published while a join is still awaiting leaves the user out of the room.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreetRoom } from './street.js';
import { VenueRoom } from './venue.js';
import { HomeRoom } from './home.js';
import { CityRoom } from './city.js';
import { MarketRoom } from './market.js';
import { SpaceRoom } from './space.js';
import { VideoCallRoom } from './video-call.js';
import { VehiclesRoom } from './vehicles.js';
import { ProjectHqRoom } from './project-hq.js';
import { LOGIN_IDENTITY_REVOKED_CHANNEL } from '../../application/login-credentials.js';
import { BAN_CHANNEL } from '../../application/moderation.js';
import { ACCOUNT_DELETED_CHANNEL } from '../../application/account-deletion.js';

const gate: { promise: Promise<void> | null } = { promise: null };
const USER = '00000000-0000-4000-8000-000000000001';
const IDENTITY = '11111111-1111-4111-8111-111111111111';
const joined = (userId: string, identityId = IDENTITY, version = 0) => ({
  userId,
  credential: { userId, identityId, version },
});
const opened: any[] = [];
afterEach(async () => {
  gate.promise = null;
  await Promise.all(opened.splice(0).map((r) => r.ban.detach()));
});
vi.mock('../../application/context.js', () => ({ buildContext: () => ({ db: {} }) }));
vi.mock('../../application/login-credentials.js', async (orig) => ({
  ...(await orig<typeof import('../../application/login-credentials.js')>()),
  assertLoginCredential: async () => {},
  invalidLoginCredentials: async () => [],
}));
vi.mock('../player.js', async (orig) => {
  const real = await orig<typeof import('../player.js')>();
  return {
    ...real,
    authenticateJoinIdentity: async () => joined(USER),
    // The ban/database check: a test can park it to fire a ban during the await.
    assertJoinAllowed: async () => {
      if (gate.promise) await gate.promise;
    },
  };
});
vi.mock('../../shared/auth/jwt.js', async (orig) => {
  const real = await orig<typeof import('../../shared/auth/jwt.js')>();
  return {
    ...real,
    createJwtIssuer: () => ({
      verifyAccess: async () => ({ sub: '00000000-0000-4000-8000-0000000000aa' }),
    }),
  };
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
  project_hq: ProjectHqRoom,
} as const;

describe('ban kicks live sessions in every room type', () => {
  for (const [name, Ctor] of Object.entries(ROOMS)) {
    it(`${name}: closes every session of the banned user, only theirs`, async () => {
      const room: any = new Ctor();
      opened.push(room);
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
      room.ban.track(clients[0], joined('bad'));
      room.ban.track(clients[1], joined('bad'));
      room.ban.track(clients[2], joined('good'));
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
      opened.push(room);
      const c = mkClient('s-' + Math.random());
      Object.defineProperty(room, 'clients', { value: [c], configurable: true });
      let handler: ((m: unknown) => void) | undefined;
      room.presence = {
        subscribe: async (channel: string, fn: (m: unknown) => void) => {
          if (channel === BAN_CHANNEL) handler = fn;
        },
        unsubscribe: async () => {},
      };
      await room.ban.attach();
      room.ban.track(c, joined('u9'));
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

describe('account deletion closes every room without banning a fresh account', () => {
  for (const [name, Ctor] of Object.entries(ROOMS)) {
    it(`${name}: closes only the deleted UUID and refuses its in-flight joins`, async () => {
      const room: any = new Ctor();
      opened.push(room);
      const clients = [mkClient('old1'), mkClient('old2'), mkClient('fresh')];
      Object.defineProperty(room, 'clients', { value: clients, configurable: true });
      const handlers = new Map<string, (m: unknown) => void>();
      room.presence = {
        subscribe: async (channel: string, fn: (m: unknown) => void) => {
          handlers.set(channel, fn);
        },
        unsubscribe: async (channel: string) => {
          handlers.delete(channel);
        },
      };
      await room.ban.attach();
      room.ban.track(clients[0], joined('old-player'));
      room.ban.track(clients[1], joined('old-player'));
      room.ban.track(clients[2], joined('fresh-player'));
      let release!: () => void;
      gate.promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inFlight = room.ban.confirm(clients[0]);
      handlers.get(ACCOUNT_DELETED_CHANNEL)!({ userId: 'old-player' });
      release();
      await expect(inFlight).rejects.toThrow('ACCOUNT_DELETED');
      gate.promise = null;
      expect(clients[0]!.left).toEqual([[4004, 'ACCOUNT_DELETED']]);
      expect(clients[1]!.left).toEqual([[4004, 'ACCOUNT_DELETED']]);
      expect(clients[2]!.left).toEqual([]);
      await expect(room.ban.confirm(clients[2])).resolves.toBeUndefined();
      handlers.get(ACCOUNT_DELETED_CHANNEL)!({ nope: true });
      expect(clients[2]!.left).toEqual([]);
      await room.ban.detach();
      expect(handlers.size).toBe(0);
    });
  }
});

describe('TOCTOU: a ban fired mid-join', () => {
  it('street: the user never ends up in the room', async () => {
    const room: any = new StreetRoom();
    opened.push(room);
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
    await expect(room.ban.confirm(client)).rejects.toThrow('ACCOUNT_BANNED');
  });
});

describe('TOCTOU in the token-verifying rooms', () => {
  const ID = USER;
  for (const [name, Ctor] of Object.entries({
    city: CityRoom,
    market: MarketRoom,
    space: SpaceRoom,
    video_call: VideoCallRoom,
  })) {
    it(`${name}: a ban fired while the join awaits its last check leaves the user out`, async () => {
      const room: any = new Ctor();
      opened.push(room);
      const client = mkClient('t1');
      Object.defineProperty(room, 'clients', { value: [client], configurable: true });
      room.state = {
        online: 0,
        speakers: new Map(),
        participantUserIds: [],
        handQueue: [],
        coins: new Map(),
      };
      room.sessionsByUser = new Map();
      room.userIdBySession = new Map();
      // Park the join on the ban/database check (the last await), then fire the ban.
      let release!: () => void;
      gate.promise = new Promise<void>((r) => (release = r));
      const joining = room.onJoin(client, { token: 'valid', hostUserId: 'x' });
      await new Promise((r) => setTimeout(r, 10));
      room.ban.ban(ID);
      release();
      await expect(joining).rejects.toThrow('ACCOUNT_BANNED');
      expect(room.state.speakers.size).toBe(0);
      expect(room.state.participantUserIds).toHaveLength(0);
      expect(room.userIdBySession.size).toBe(0);
      expect(client.left).toEqual([[4003, 'ACCOUNT_BANNED']]);
    });
  }
});

describe('credential revocation reaches every direct and inherited room', () => {
  for (const [name, Ctor] of Object.entries(ROOMS)) {
    it(`${name}: closes only the older generation of the removed credential`, async () => {
      const room: any = new Ctor();
      opened.push(room);
      const clients = [mkClient('old'), mkClient('fresh'), mkClient('retained'), mkClient('other')];
      Object.defineProperty(room, 'clients', { value: clients, configurable: true });
      const handlers = new Map<string, (event: unknown) => void>();
      room.presence = {
        subscribe: async (channel: string, fn: (e: unknown) => void) => {
          handlers.set(channel, fn);
        },
        unsubscribe: async () => {},
      };
      await room.ban.attach();
      room.ban.track(clients[0], joined(USER, IDENTITY, 0));
      room.ban.track(clients[1], joined(USER, IDENTITY, 1));
      room.ban.track(clients[2], joined(USER, '22222222-2222-4222-8222-222222222222', 0));
      room.ban.track(
        clients[3],
        joined('00000000-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333', 0),
      );
      handlers.get(LOGIN_IDENTITY_REVOKED_CHANNEL)!({
        userId: USER,
        identityId: IDENTITY,
        minVersion: 1,
      });
      expect(clients[0]!.left).toEqual([[4005, 'AUTH_IDENTITY_REVOKED']]);
      expect(clients.slice(1).map((c) => c.left)).toEqual([[], [], []]);
      await expect(room.ban.confirm(clients[0])).rejects.toThrow('AUTH_IDENTITY_REVOKED');
      await expect(room.ban.confirm(clients[1])).resolves.toBeUndefined();
      await expect(room.ban.confirm(clients[2])).resolves.toBeUndefined();
    });
  }
});
