/** Park real join continuations after Redis increment / inherited join, then revoke. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerState, StreetState, VenueState } from '../../../contract/realtime/states.js';
import { StreetRoom } from './street.js';
import { VenueRoom } from './venue.js';
import { ProjectHqRoom } from './project-hq.js';
import { LOGIN_IDENTITY_REVOKED_CHANNEL } from '../../application/login-credentials.js';

const USER = '00000000-0000-4000-8000-000000000001';
const ID = '11111111-1111-4111-8111-111111111111';
const mocks = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../../application/context.js', () => ({ buildContext: () => ({ db: {} }) }));
vi.mock('../../application/project-hq.js', () => ({
  hqAccess: async () => ({ status: 'active', role: 'founder' }),
  setHqMembersPresent: mocks.publish,
  recordHqShift: async () => true,
}));
vi.mock('../../application/login-credentials.js', async (orig) => ({
  ...(await orig<typeof import('../../application/login-credentials.js')>()),
  assertLoginCredential: async () => {},
  invalidLoginCredentials: async () => [],
}));
vi.mock('../player.js', async (orig) => ({
  ...(await orig<typeof import('../player.js')>()),
  authenticateJoin: async () => USER,
  authenticateJoinIdentity: async () => ({
    userId: USER,
    credential: { userId: USER, identityId: ID, version: 0 },
  }),
  assertJoinAllowed: async () => {},
  loadPlayerState: async () => {
    const p = new PlayerState();
    p.userId = USER;
    return p;
  },
}));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const opened: any[] = [];
beforeEach(() => {
  mocks.publish.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((r) => r.ban.detach()));
});

async function fixture(
  kind: 'street' | 'venue' | 'hq',
  baseline = 0,
  pause = true,
  expireFails = false,
) {
  const room: any =
    kind === 'street' ? new StreetRoom() : kind === 'venue' ? new VenueRoom() : new ProjectHqRoom();
  opened.push(room);
  room.state = kind === 'street' ? new StreetState() : new VenueState();
  room.state.instanceId = 'fixture';
  room.state.district = 'timeline';
  room.state.venueId = 'ct_jail';
  room.spotsCfg = { venues: { ct_jail: { spots: [], walkable: [] } }, anims: [] };
  room.voice = true;
  room.projectId = '22222222-2222-4222-8222-222222222222';
  room.loadPlayer = async () => {
    const p = new PlayerState();
    p.userId = USER;
    return p;
  };
  room.removeFromVoice = vi.fn(async () => {});
  const entered = deferred(),
    release = deferred();
  let count = baseline;
  let expires = 0;
  const handlers = new Map<string, (event: unknown) => void>();
  room.presence = {
    hget: async () => null,
    hincrby: async (_key: string, _user: string, delta: number) => {
      count += delta;
      const n = count;
      if (delta === 1 && pause) {
        entered.resolve();
        await release.promise;
      }
      return n;
    },
    hset: async () => {},
    expire: async () => {
      if (expireFails && ++expires === 1) throw Error('fixture expiry failed after increment');
    },
    subscribe: async (channel: string, handler: (event: unknown) => void) => {
      handlers.set(channel, handler);
    },
    unsubscribe: async () => {},
  };
  const client = { sessionId: 'joining', send: vi.fn(), leave: vi.fn(() => room.onLeave(client)) };
  Object.defineProperty(room, 'clients', { value: [client], configurable: true });
  await room.ban.attach();
  return {
    room,
    client,
    entered,
    release,
    count: () => count,
    revoke: () =>
      handlers.get(LOGIN_IDENTITY_REVOKED_CHANNEL)!({
        userId: USER,
        identityId: ID,
        minVersion: 1,
      }),
  };
}

describe('revocation across asynchronous presence writes', () => {
  for (const kind of ['street', 'venue'] as const)
    it(`${kind}: compensates an acknowledged increment even if expiry fails after revocation`, async () => {
      const f = await fixture(kind, 0, true, true),
        joining = f.room.onJoin(f.client, {});
      await f.entered.promise;
      f.revoke();
      f.release.resolve();
      await expect(joining).rejects.toThrow(/JOIN_CANCELLED|AUTH_IDENTITY_REVOKED/);
      expect(f.count()).toBe(0);
      expect(f.room.members.size).toBe(0);
      expect(f.room.removeFromVoice).toHaveBeenCalledTimes(1);
    });

  for (const kind of ['street', 'venue'] as const)
    for (const baseline of [0, 1])
      it(`${kind}: compensates the cancelled increment without removing ${baseline ? 'a retained sibling' : 'an absent sibling'}`, async () => {
        const f = await fixture(kind, baseline);
        const joining = f.room.onJoin(f.client, {});
        await f.entered.promise;
        f.revoke();
        f.release.resolve();
        await expect(joining).rejects.toThrow(/JOIN_CANCELLED|AUTH_IDENTITY_REVOKED/);
        expect(f.client.leave).toHaveBeenCalledWith(4005, 'AUTH_IDENTITY_REVOKED');
        expect(f.count()).toBe(baseline);
        expect(f.room.members.size).toBe(0);
        expect(f.room.state.players.size).toBe(0);
        expect(f.client.send).not.toHaveBeenCalledWith('welcome', expect.anything());
        expect(f.room.removeFromVoice).toHaveBeenCalledTimes(baseline === 0 ? 1 : 0);
      });

  it('HQ cannot restore visitors after revocation between the inherited join and its continuation', async () => {
    const f = await fixture('hq', 0, false),
      entered = deferred(),
      release = deferred();
    const original = VenueRoom.prototype.onJoin;
    vi.spyOn(VenueRoom.prototype, 'onJoin').mockImplementation(async function (
      this: VenueRoom,
      client,
      options,
    ) {
      await original.call(this, client, options);
      entered.resolve();
      await release.promise;
    });
    const joining = f.room.onJoin(f.client, {});
    await entered.promise;
    f.revoke();
    release.resolve();
    await expect(joining).rejects.toThrow(/JOIN_CANCELLED|AUTH_IDENTITY_REVOKED/);
    expect(f.room.visitors.size).toBe(0);
    expect(f.room.state.players.size).toBe(0);
  });

  it('HQ coalesces presence updates so a delayed old snapshot cannot overwrite leave', async () => {
    const f = await fixture('hq', 0, false),
      entered = deferred(),
      release = deferred();
    let present: string[] = [];
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.publish.mockImplementation(async (_ctx: unknown, _project: string, ids: string[]) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      present = [...ids];
      inFlight--;
    });
    f.room.visitors.set('joining', {
      userId: USER,
      member: true,
      joinedAt: Date.now(),
      shiftLogged: false,
    });
    const first = f.room.publishPresence();
    await entered.promise;
    f.room.visitors.delete('joining');
    const last = f.room.publishPresence();
    await new Promise((resolve) => setImmediate(resolve));
    release.resolve();
    await Promise.all([first, last]);
    expect(maxInFlight).toBe(1);
    expect(present).toEqual([]);
    expect(calls).toBe(2);
  });
});
