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
      },
    } as AppContext['config'],
    db: {} as AppContext['db'],
    redis: {} as AppContext['redis'],
    jwt: {} as AppContext['jwt'],
    helius: {} as AppContext['helius'],
    idempotency: {} as AppContext['idempotency'],
    livekit: {} as AppContext['livekit'],
    instanceId: 'test',
    nonces: {} as AppContext['nonces'],
    configCache: {} as AppContext['configCache'],
    ...overrides,
  };
}

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
      userId: 'u-1',
      kind: 'space',
      id: 'sp-1',
    });
    expect(out.roomName).toBe('space:sp-1');
    expect(out.identity).toBe('u-1');
    expect(out.url).toBe('ws://localhost:7880');
    // Spaces default to canPublish=false for listeners.
    expect(out.canPublish).toBe(false);
    expect(out.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const decoded = decodeJwt(out.token);
    expect(decoded.payload.sub).toBe('u-1');
    const video = decoded.payload.video as Record<string, unknown>;
    expect(video?.room).toBe('space:sp-1');
    expect(video?.canPublish).toBe(false);
    expect(video?.roomJoin).toBe(true);
  });

  it('canPublish=true for non-space kinds by default', async () => {
    const out = await svc.mintRtcToken({
      userId: 'u-2',
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
      userId: 'u-3',
      kind: 'space',
      id: 'sp-2',
      canPublish: true,
    });
    expect(out.canPublish).toBe(true);
    const decoded = decodeJwt(out.token);
    const video = decoded.payload.video as Record<string, unknown>;
    expect(video?.canPublish).toBe(true);
  });

  it('TTL is roughly 1 hour by default', async () => {
    const before = Math.floor(Date.now() / 1000);
    const out = await svc.mintRtcToken({ userId: 'u-4', kind: 'video', id: 'v-1' });
    const ttl = out.expiresAt - before;
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });
});

describe('livekit room service client', () => {
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
      const e = new Error('not found') as Error & { status?: number };
      e.status = 404;
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
});
