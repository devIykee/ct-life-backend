/**
 * LiveKit service tests.
 *
 * Mocks the `livekit-server-sdk` so the tests don't need a running
 * LiveKit server. Asserts:
 *
 *   1. mintRtcToken returns a JWT whose payload decodes to the
 *      expected grants (room name, identity, canPublish).
 *   2. mintRtcToken honours canPublish=false for listener defaults.
 *   3. setParticipantCanPublish calls updateParticipant on the
 *      RoomServiceClient with the right room and identity.
 *   4. endRoom swallows 404 (idempotent end).
 *
 * The token decode uses the raw JWT (header.payload.signature); the
 * SDK signs with HS256 against `LIVEKIT_API_SECRET`. The test uses
 * a known dev secret so the signature verifies.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { AppContext } from './context.js';
import { mediaIdentity } from '../shared/livekit/identity.js';
import { createLiveKitService, roomName, type LiveKitService } from './livekit.js';

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  sig: string;
}

function decodeJwt(token: string): JwtParts {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  const decode = (s: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  return {
    header: decode(parts[0] ?? ''),
    payload: decode(parts[1] ?? ''),
    sig: parts[2] ?? '',
  };
}

function makeContext(overrides: Partial<AppContext> = {}): AppContext {
  return {
    config: {
      appEnv: 'local',
      nodeEnv: 'development',
      port: 4010,
      logLevel: 'info',
      databaseUrl: 'postgres://x',
      redisUrl: 'redis://x',
      jwt: {
        privateKeyPem: '',
        publicKeyPem: '',
        issuer: 'ct-life',
        audience: 'ct-life',
        accessTtlSec: 900,
        refreshTtlSec: 2592000,
        kid: 'ctlife-1',
      },
      solana: {
        cluster: 'devnet',
        rpcUrl: 'http://x',
        treasuryPubkey: 't',
        settleAuthorityKey: 'k',
        adminKey: 'a',
      },
      helius: {
        apiKey: 'k',
        rpcUrlDevnet: 'http://d',
        rpcUrlMainnet: 'http://m',
        webhookSecret: 'w',
      },
      livekit: {
        url: 'ws://localhost:7880',
        apiKey: 'devkey',
        apiSecret: 'devsecret_please_change',
        webhookSecret: 'livekit-webhook-secret',
      },
      s3: {
        endpoint: 'http://x',
        region: 'us-east-1',
        accessKey: 'a',
        secretKey: 's',
        bucketAds: 'b',
        forcePathStyle: true,
      },
      auth: { devAuthEnabled: true },
      rateLimits: {
        restPerUserPerSec: 20,
        restGlobalPerSec: 5000,
        loginPerIpPerMin: 30,
        loginGlobalConcurrent: 200,
      },
      features: {
        llmEnabled: false,
        pushEnabled: false,
        xLinkEnabled: false,
        mainnetTests: false,
        oreReader: false,
      },
    } as AppContext['config'],
    db: {
      withConnection: async (fn: (client: unknown) => Promise<unknown>) =>
        fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
    } as unknown as AppContext['db'],
    redis: {} as AppContext['redis'],
    jwt: {} as AppContext['jwt'],
    helius: {} as AppContext['helius'],
    idempotency: {} as AppContext['idempotency'],
    livekit: {} as AppContext['livekit'],
    s3: {} as AppContext['s3'],
    instanceId: 'test',
    nonces: {} as AppContext['nonces'],
    configCache: {} as AppContext['configCache'],
    ...overrides,
  };
}

const qualified = mediaIdentity({
  userId: '019a5750-0000-7000-8000-000000000001',
  identityId: '019a5750-0000-7000-8000-000000000002',
  version: 0,
});

describe('livekit service', () => {
  let svc: LiveKitService;

  beforeEach(() => {
    svc = createLiveKitService();
  });

  it('roomName is {kind}:{id}', () => {
    expect(roomName('space', 'abc')).toBe('space:abc');
    expect(roomName('video', 'xyz')).toBe('video:xyz');
    expect(roomName('paid_call', 'q1')).toBe('paid_call:q1');
  });

  it('mints a token whose payload carries the right grants', async () => {
    const out = await svc.mintRtcToken({
      identity: qualified,
      kind: 'space',
      id: 'sp-1',
    });
    expect(out.roomName).toBe('space:sp-1');
    expect(out.identity).toBe(qualified);
    expect(out.url).toBe('ws://localhost:7880');
    // Spaces default to canPublish=false for listeners.
    expect(out.canPublish).toBe(false);
    expect(out.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const decoded = decodeJwt(out.token);
    expect(decoded.payload.sub).toBe(qualified);
    const video = decoded.payload.video as Record<string, unknown>;
    expect(video?.room).toBe('space:sp-1');
    expect(video?.canPublish).toBe(false);
    expect(video?.roomJoin).toBe(true);
  });

  it('canPublish=true for non-space kinds by default', async () => {
    const out = await svc.mintRtcToken({
      identity: qualified,
      kind: 'paid_call',
      id: 'pc-1',
    });
    expect(out.canPublish).toBe(true);
    expect(out.roomName).toBe('paid_call:pc-1');
    const decoded = decodeJwt(out.token);
    const video = decoded.payload.video as Record<string, unknown>;
    expect(video?.canPublish).toBe(true);
    expect(video?.room).toBe('paid_call:pc-1');
  });

  it('honours explicit canPublish override', async () => {
    const out = await svc.mintRtcToken({
      identity: qualified,
      kind: 'space',
      id: 'sp-2',
      canPublish: true,
    });
    expect(out.canPublish).toBe(true);
    const decoded = decodeJwt(out.token);
    const video = decoded.payload.video as Record<string, unknown>;
    expect(video?.canPublish).toBe(true);
  });

  it('TTL stays within Cloud revocation retention by default', async () => {
    const before = Math.floor(Date.now() / 1000);
    const out = await svc.mintRtcToken({ identity: qualified, kind: 'video', id: 'v-1' });
    const ttl = out.expiresAt - before;
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });
});

describe('livekit room service client', () => {
  it('rejects unqualified identities and token TTLs outside the Cloud cutoff horizon', async () => {
    const service = createLiveKitService();
    await expect(service.mintRtcToken({ identity: 'u-1', kind: 'video', id: 'v' })).rejects.toThrow(
      'qualified media identity',
    );
    for (const ttlSec of [0, -1, 1.5, 601, NaN])
      await expect(
        service.mintRtcToken({ identity: qualified, kind: 'video', id: 'v', ttlSec }),
      ).rejects.toThrow('TTL');
  });

  it('attempts all matching credential permissions even when one update fails', async () => {
    const { RoomServiceClient } = await import('livekit-server-sdk');
    const player = '019a5750-0000-7000-8000-000000000001';
    const sibling = mediaIdentity({
      userId: player,
      identityId: '019a5750-0000-7000-8000-000000000003',
      version: 0,
    });
    const list = vi
      .spyOn(RoomServiceClient.prototype, 'listParticipants')
      .mockResolvedValue([
        { identity: qualified },
        { identity: sibling },
        { identity: '019a5750-0000-7000-8000-000000000099' },
      ] as never);
    const update = vi
      .spyOn(RoomServiceClient.prototype, 'updateParticipant')
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValue({} as never);
    try {
      await expect(
        createLiveKitService().setParticipantCanPublish(makeContext(), {
          kind: 'space',
          id: 'space-test',
          identity: player,
          canPublish: false,
        }),
      ).rejects.toThrow('Participant update incomplete');
      expect(update.mock.calls.map((call) => call[1]).sort()).toEqual([qualified, sibling].sort());
    } finally {
      list.mockRestore();
      update.mockRestore();
    }
  });

  it('an exact legacy cutoff does not expand to qualified sibling identities', async () => {
    const { RoomServiceClient } = await import('livekit-server-sdk');
    const list = vi.spyOn(RoomServiceClient.prototype, 'listParticipants');
    const remove = vi.spyOn(RoomServiceClient.prototype, 'removeParticipant').mockResolvedValue();
    try {
      const legacy = '019a5750-0000-7000-8000-000000000001';
      await createLiveKitService().removeParticipant(makeContext(), {
        kind: 'video',
        id: 'v',
        identity: legacy,
        exact: true,
      });
      expect(list).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]![1]).toBe(legacy);
    } finally {
      list.mockRestore();
      remove.mockRestore();
    }
  });

  it('only treats structured provider not_found as absence', async () => {
    const { RoomServiceClient } = await import('livekit-server-sdk');
    const list = vi.spyOn(RoomServiceClient.prototype, 'listParticipants');
    try {
      const service = createLiveKitService(),
        ctx = makeContext();
      for (const error of [
        new Error('404 not found'),
        Object.assign(new Error('participant not found'), { code: 'unavailable' }),
      ]) {
        list.mockRejectedValueOnce(error);
        await expect(service.participants(ctx, 'video:v')).rejects.toBe(error);
      }
      list.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'not_found' }));
      await expect(service.participants(ctx, 'video:v')).resolves.toEqual([]);
    } finally {
      list.mockRestore();
    }
  });

  it('uses the SDK abort timeout for provider requests', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"rooms":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      await expect(createLiveKitService().rooms(makeContext())).resolves.toEqual([]);
      expect(timeout).toHaveBeenCalledWith(5000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
      fetch.mockRestore();
    }
  });

  it('endRoom swallows 404', async () => {
    // Mock the SDK module before the service picks it up. The
    // service caches the client per URL, so we need to mock at the
    // module level via vi.mock.
    const { RoomServiceClient } = await import('livekit-server-sdk');
    const proto = RoomServiceClient.prototype as unknown as {
      deleteRoom: () => Promise<void>;
      updateParticipant: () => Promise<void>;
    };
    const originalDelete = proto.deleteRoom;
    const originalUpdate = proto.updateParticipant;
    proto.deleteRoom = vi.fn(async () => {
      const e = new Error('not found') as Error & { code?: string };
      e.code = 'not_found';
      throw e;
    });
    proto.updateParticipant = vi.fn(async () => undefined);

    try {
      const ctx = makeContext();
      const svc = createLiveKitService();
      await expect(svc.endRoom(ctx, { kind: 'space', id: 'sp-404' })).resolves.toBeUndefined();
    } finally {
      proto.deleteRoom = originalDelete;
      proto.updateParticipant = originalUpdate;
    }
  });

  it('setParticipantCanPublish calls updateParticipant', async () => {
    const { RoomServiceClient } = await import('livekit-server-sdk');
    const proto = RoomServiceClient.prototype as unknown as {
      updateParticipant: (...args: unknown[]) => Promise<void>;
    };
    const original = proto.updateParticipant;
    const spy = vi.fn(async () => undefined);
    proto.updateParticipant = spy;

    try {
      const ctx = makeContext();
      const svc = createLiveKitService();
      await svc.setParticipantCanPublish(ctx, {
        kind: 'space',
        id: 'sp-x',
        identity: 'u-y',
        canPublish: true,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0] as unknown[];
      expect(args[0]).toBe('space:sp-x');
      expect(args[1]).toBe('u-y');
      const opts = args[3] as Record<string, unknown>;
      expect(opts.canPublish).toBe(true);
    } finally {
      proto.updateParticipant = original;
    }
  });

  it('removeParticipant disconnects from the venue room and swallows 404', async () => {
    const { RoomServiceClient } = await import('livekit-server-sdk');
    const proto = RoomServiceClient.prototype as unknown as {
      removeParticipant: (...args: unknown[]) => Promise<void>;
    };
    const original = proto.removeParticipant;
    const spy = vi.fn(async () => undefined);
    proto.removeParticipant = spy;
    try {
      const ctx = makeContext();
      const svc = createLiveKitService();
      await svc.removeParticipant(ctx, { kind: 'venue', id: 'inst-1', identity: 'u-1' });
      expect(spy.mock.calls[0]).toEqual([
        'venue:inst-1',
        'u-1',
        { revokeTokenTs: expect.any(BigInt) },
      ]);
      const cutoff = ((spy.mock.calls[0] as unknown as unknown[])[2] as { revokeTokenTs: bigint })
        .revokeTokenTs;
      expect(Number(cutoff)).toBeGreaterThan(Math.floor(Date.now() / 1000));
      proto.removeParticipant = vi.fn(async () => {
        throw Object.assign(new Error('participant not found'), { code: 'not_found' });
      });
      await expect(
        svc.removeParticipant(ctx, { kind: 'proximity', id: 'inst-1', identity: 'u-1' }),
      ).resolves.toBeUndefined();
    } finally {
      proto.removeParticipant = original;
    }
  });
});

describe('canonicalRoomName', () => {
  it('adds the kind prefix exactly once', async () => {
    const { canonicalRoomName } = await import('../shared/livekit/token.js');
    expect(canonicalRoomName('space', 'abc')).toBe('space:abc');
    expect(canonicalRoomName('space', 'space:abc')).toBe('space:abc');
    expect(roomName('video', 'video:abc')).toBe('video:abc');
  });

  it('rejects empty ids, double prefixes and other kinds', async () => {
    const { canonicalRoomName } = await import('../shared/livekit/token.js');
    expect(canonicalRoomName('space', '')).toBeNull();
    expect(canonicalRoomName('space', 'space:')).toBeNull();
    expect(canonicalRoomName('space', 'space:space:abc')).toBeNull();
    expect(canonicalRoomName('space', 'video:abc')).toBeNull();
    expect(() => roomName('space', 'paid_call:abc')).toThrow();
  });
});
