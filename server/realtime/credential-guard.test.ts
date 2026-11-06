/** Session generations, lost pubsub, and late asynchronous results at the shared room boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BanGuard } from './ban-guard.js';
import {
  LOGIN_IDENTITY_REVOKED_CHANNEL,
  type LoginCredential,
} from '../application/login-credentials.js';

const mocks = vi.hoisted(() => ({
  invalid:
    vi.fn<(_db: unknown, credentials: readonly LoginCredential[]) => Promise<LoginCredential[]>>(),
  assert: vi.fn<() => Promise<void>>(),
  allowed: vi.fn<() => Promise<void>>(),
}));
vi.mock('../application/context.js', () => ({ buildContext: () => ({ db: {} }) }));
vi.mock('../application/login-credentials.js', async (orig) => ({
  ...(await orig<typeof import('../application/login-credentials.js')>()),
  invalidLoginCredentials: mocks.invalid,
  assertLoginCredential: mocks.assert,
}));
vi.mock('./player.js', async (orig) => ({
  ...(await orig<typeof import('./player.js')>()),
  assertJoinAllowed: mocks.allowed,
}));
const USER = '00000000-0000-4000-8000-000000000001';
const ID = '11111111-1111-4111-8111-111111111111';
const identity = (version = 0, id = ID) => ({
  userId: USER,
  credential: { userId: USER, identityId: id, version },
});
const client = (sessionId: string) => ({ sessionId, leave: vi.fn() });
const active: BanGuard[] = [];
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
async function fixture() {
  const clients = [client('old'), client('sibling')];
  const handlers = new Map<string, (event: unknown) => void>();
  const room = {
    clients,
    presence: {
      subscribe: async (channel: string, fn: (e: unknown) => void) => {
        handlers.set(channel, fn);
      },
      unsubscribe: async (channel: string) => {
        handlers.delete(channel);
      },
    },
  };
  const guard = new BanGuard(room as never);
  active.push(guard);
  await guard.attach();
  guard.track(clients[0] as never, identity());
  guard.track(clients[1] as never, identity(0, '22222222-2222-4222-8222-222222222222'));
  return { guard, clients, handlers, room };
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.invalid.mockReset().mockResolvedValue([]);
  mocks.assert.mockReset().mockResolvedValue(undefined);
  mocks.allowed.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(active.splice(0).map((g) => g.detach()));
  vi.useRealTimers();
});

describe('durable credential revalidation', () => {
  it('removes a revoked session after missed pubsub while preserving a retained credential', async () => {
    const { guard, clients } = await fixture();
    mocks.invalid.mockResolvedValue([identity().credential]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(clients[0]!.leave).toHaveBeenCalledWith(4005, 'AUTH_IDENTITY_REVOKED');
    expect(clients[1]!.leave).not.toHaveBeenCalled();
    expect(mocks.invalid).toHaveBeenCalledTimes(1);
    await guard.detach();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.invalid).toHaveBeenCalledTimes(1);
  });
  it('does not overlap durable checks', async () => {
    const { guard } = await fixture();
    const pending = deferred<LoginCredential[]>();
    mocks.invalid.mockReturnValue(pending.promise);
    const first = guard.recheck();
    await vi.advanceTimersByTimeAsync(60_000);
    await guard.recheck();
    expect(mocks.invalid).toHaveBeenCalledTimes(1);
    pending.resolve([]);
    await first;
  });
  it('bounds stalled checks, preserves replacement sessions and ignores late results without overlap', async () => {
    const { guard, clients } = await fixture();
    const pending = deferred<LoginCredential[]>();
    mocks.invalid.mockReturnValueOnce(pending.promise);
    const checking = guard.recheck();
    await vi.advanceTimersByTimeAsync(0);
    guard.track(clients[0] as never, identity(1));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(clients[1]!.leave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await checking;
    expect(clients[1]!.leave).toHaveBeenCalledWith(4006, 'AUTH_STATE_UNAVAILABLE');
    expect(clients[0]!.leave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await guard.recheck();
    expect(mocks.invalid).toHaveBeenCalledTimes(1);
    pending.resolve([identity(1).credential]);
    await vi.advanceTimersByTimeAsync(0);
    expect(clients[0]!.leave).not.toHaveBeenCalled();
    await guard.recheck();
    expect(mocks.invalid).toHaveBeenCalledTimes(2);
    expect(clients[0]!.leave).not.toHaveBeenCalled();
  });
  it('does not restart subscriptions or a timer after disposal during an awaited subscription', async () => {
    const pending = deferred<void>();
    const handlers = new Set<(event: unknown) => void>();
    const subscribe = vi.fn(async (_channel: string, handler: (event: unknown) => void) => {
      await pending.promise;
      handlers.add(handler);
    });
    const unsubscribe = vi.fn(async (_channel: string, handler: (event: unknown) => void) => {
      handlers.delete(handler);
    });
    const guard = new BanGuard({ clients: [], presence: { subscribe, unsubscribe } } as never);
    active.push(guard);
    const attaching = guard.attach();
    await guard.detach();
    pending.resolve();
    await attaching;
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not close a reauthenticated session with a delayed old-generation result', async () => {
    const { guard, clients } = await fixture();
    const pending = deferred<LoginCredential[]>();
    mocks.invalid.mockReturnValue(pending.promise);
    const checking = guard.recheck();
    await vi.advanceTimersByTimeAsync(0);
    guard.track(clients[0] as never, identity(1));
    pending.resolve([identity().credential]);
    await checking;
    expect(clients[0]!.leave).not.toHaveBeenCalled();
  });
  it('fails closed on unavailable durable state, only for sessions captured before the check', async () => {
    const { guard, clients } = await fixture();
    const pending = deferred<LoginCredential[]>();
    mocks.invalid.mockReturnValue(pending.promise);
    const checking = guard.recheck();
    await vi.advanceTimersByTimeAsync(0);
    guard.track(clients[0] as never, identity(1));
    pending.reject(new Error('database unavailable'));
    await checking;
    expect(clients[0]!.leave).not.toHaveBeenCalled();
    expect(clients[1]!.leave).toHaveBeenCalledWith(4006, 'AUTH_STATE_UNAVAILABLE');
  });
  it('ignores an in-flight check after disposal', async () => {
    const { guard, clients, handlers } = await fixture();
    const pending = deferred<LoginCredential[]>();
    mocks.invalid.mockReturnValue(pending.promise);
    const checking = guard.recheck();
    await vi.advanceTimersByTimeAsync(0);
    await guard.detach();
    pending.resolve([identity().credential]);
    await checking;
    expect(clients[0]!.leave).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not read credential state for an explicitly local development session', async () => {
    const { guard, clients } = await fixture();
    guard.untrack(clients[0] as never);
    guard.untrack(clients[1] as never);
    guard.track(clients[0] as never, { userId: 'dev-fixture', credential: null });
    await guard.recheck();
    await guard.confirm(clients[0] as never);
    expect(mocks.invalid).not.toHaveBeenCalled();
    expect(mocks.assert).not.toHaveBeenCalled();
  });
});

describe('join and event boundaries', () => {
  it('a failed durable recheck cancels join continuations before transport onLeave runs', async () => {
    const { guard, clients } = await fixture();
    const continuation = guard.checkpoint(clients[0] as never);
    mocks.invalid.mockResolvedValue([identity().credential]);
    await guard.recheck();
    // leave() is intentionally only a spy: the socket has not delivered onLeave yet.
    expect(() => continuation()).toThrow('JOIN_CANCELLED');
    await expect(guard.confirm(clients[0] as never)).rejects.toThrow('JOIN_CANCELLED');
    await expect(guard.confirm(clients[1] as never)).resolves.toBeUndefined();
  });

  it('refuses a credential revoked while its final join check awaits', async () => {
    const { guard, clients, handlers } = await fixture();
    const pending = deferred<void>();
    mocks.allowed.mockReturnValue(pending.promise);
    const joining = guard.confirm(clients[0] as never);
    handlers.get(LOGIN_IDENTITY_REVOKED_CHANNEL)!({ userId: USER, identityId: ID, minVersion: 1 });
    pending.resolve();
    await expect(joining).rejects.toThrow('AUTH_IDENTITY_REVOKED');
    expect(mocks.assert).not.toHaveBeenCalled();
  });
  it('uses durable state at final confirmation even with no event', async () => {
    const { guard, clients } = await fixture();
    mocks.assert.mockRejectedValue(new Error('AUTH_IDENTITY_REVOKED'));
    await expect(guard.confirm(clients[0] as never)).rejects.toThrow('AUTH_IDENTITY_REVOKED');
  });
  it('does not let a stale join complete after leave and same-session-id replacement', async () => {
    const { guard, clients } = await fixture();
    const pending = deferred<void>();
    mocks.assert.mockReturnValue(pending.promise);
    const joining = guard.confirm(clients[0] as never);
    await vi.advanceTimersByTimeAsync(0);
    guard.untrack(clients[0] as never);
    guard.track(clients[0] as never, identity());
    pending.resolve();
    await expect(joining).rejects.toThrow('JOIN_CANCELLED');
  });
  it('ignores malformed or wrong-owner events and does not lower an observed generation', async () => {
    const { guard, clients, handlers } = await fixture();
    const fire = handlers.get(LOGIN_IDENTITY_REVOKED_CHANNEL)!;
    for (const minVersion of [undefined, null, -1, 0, 0.5, '1', Infinity, 2147483648])
      fire({ userId: USER, identityId: ID, minVersion });
    fire({ userId: '00000000-0000-4000-8000-000000000002', identityId: ID, minVersion: 1 });
    expect(clients[0]!.leave).not.toHaveBeenCalled();
    fire({ userId: USER, identityId: ID, minVersion: 2 });
    guard.track(clients[0] as never, identity(1));
    fire({ userId: USER, identityId: ID, minVersion: 1 });
    await expect(guard.confirm(clients[0] as never)).rejects.toThrow('AUTH_IDENTITY_REVOKED');
    guard.track(clients[0] as never, identity(2));
    await expect(guard.confirm(clients[0] as never)).resolves.toBeUndefined();
  });
  it('rejects untracked or mismatched-owner session contexts', async () => {
    const { guard } = await fixture();
    const c = client('absent');
    await expect(guard.confirm(c as never)).rejects.toThrow('JOIN_CANCELLED');
    expect(() =>
      guard.track(c as never, { userId: 'wrong', credential: identity().credential }),
    ).toThrow('INVALID_TOKEN');
  });
});
