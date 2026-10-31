/**
 * Web clients and multi-platform releases over HTTP (real API, real Postgres/Redis):
 *   - CORS for WEB_ORIGINS (preflight, actual request, no-Origin native requests);
 *   - per-platform minimum versions on GET /config (426 CLIENT_OUTDATED, reload vs store);
 *   - the per-platform capability kill-list in /config and at the route gates;
 *   - the client-platform hook never scopes webhook routes;
 *   - malformed platform env stops the boot.
 */
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, errCode, errDetails, type TestApi } from './http-test-kit.js';
import { registerClientPlatformHook } from './middleware/client-platform.js';
import { isCapabilityOn } from '../application/capabilities.js';
import type { AppContext } from '../application/context.js';
import { _resetConfigForTests, loadConfig } from '../shared/config/config.js';
import { parseCapabilitiesOffByPlatform } from '../shared/domain/client-platform.js';
import type { CapabilityName } from '../shared/domain/capabilities.js';

const WEB = 'https://play.ctlife.fun';
const EVIL = 'https://evil.example';
const UUID = '0190f3c4-0000-7000-8000-000000000001';

type Inject = Awaited<ReturnType<TestApi['app']['inject']>>;

describe('web platform over HTTP', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await bootApi('paidCalls,worldEvents,seasonPassPurchase', {
      WEB_ORIGINS: `${WEB},http://localhost:8080`,
      MIN_CLIENT_VERSION_BY_PLATFORM: '{"android":"1.5.0","web":"1.6.0"}',
      CAPABILITIES_OFF_BY_PLATFORM: '{"web":["paidCalls","seasonPassPurchase"]}',
      LATEST_WEB_BUILD: '2716521',
    });
  });

  afterAll(async () => {
    await api.stop();
  });

  const get = (url: string, headers: Record<string, string> = {}): Promise<Inject> =>
    api.app.inject({ method: 'GET', url, headers });

  describe('CORS', () => {
    it('answers a preflight from an allowed origin with the client headers', async () => {
      const r = await api.app.inject({
        method: 'OPTIONS',
        url: '/v1/auth/verify',
        headers: {
          origin: WEB,
          'access-control-request-method': 'POST',
          'access-control-request-headers':
            'authorization,content-type,idempotency-key,x-client-version,x-client-platform,x-client-build',
        },
      });
      expect(r.statusCode).toBe(204);
      expect(r.headers['access-control-allow-origin']).toBe(WEB);
      expect(r.headers['access-control-allow-credentials']).toBe('true');
      const allowed = String(r.headers['access-control-allow-headers']).toLowerCase();
      for (const h of [
        'authorization',
        'content-type',
        'idempotency-key',
        'x-client-version',
        'x-contract-version',
        'x-client-platform',
        'x-client-build',
      ]) {
        expect(allowed.split(', ')).toContain(h);
      }
      expect(String(r.headers['access-control-allow-methods'])).toContain('POST');
      expect(r.headers['access-control-max-age']).toBe('600');
      expect(String(r.headers.vary)).toMatch(/Origin/);
    });

    it('gives a disallowed origin no CORS headers, preflight or not', async () => {
      const pre = await api.app.inject({
        method: 'OPTIONS',
        url: '/v1/config',
        headers: { origin: EVIL, 'access-control-request-method': 'GET' },
      });
      expect(pre.statusCode).toBe(404);
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
      const r = await get('/v1/config', { origin: EVIL });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('never answers with a wildcard and echoes the exact allowed origin', async () => {
      const local = await get('/v1/config', { origin: 'http://localhost:8080' });
      expect(local.headers['access-control-allow-origin']).toBe('http://localhost:8080');
      const r = await get('/v1/config', { origin: WEB });
      expect(r.statusCode).toBe(200);
      expect(r.headers['access-control-allow-origin']).toBe(WEB);
      expect(String(r.headers['access-control-expose-headers'])).toContain('ETag');
    });

    it('leaves native requests (no Origin) alone', async () => {
      const r = await get('/v1/config');
      expect(r.statusCode).toBe(200);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('error responses to an allowed origin still carry CORS headers (the 426 is readable)', async () => {
      const r = await get('/v1/config', { origin: WEB, 'x-client-version': '1.0.0' });
      expect(r.statusCode).toBe(426);
      expect(r.headers['access-control-allow-origin']).toBe(WEB);
    });
  });

  describe('GET /config per platform', () => {
    it('sends the caller platform minimum, every platform minimum and the web build', async () => {
      const r = await get('/v1/config', { 'x-client-platform': 'web', origin: WEB });
      const b = r.json() as Record<string, unknown>;
      expect(b.minClientVersion).toBe('1.6.0');
      expect(b.minClientVersionByPlatform).toEqual({
        android: '1.5.0',
        web: '1.6.0',
        desktop: '1.0.0',
        ios: '1.0.0',
      });
      expect(b.latestWebBuild).toBe(2716521);
      expect(b.clientPlatform).toBe('web');
      expect(String(r.headers.vary)).toMatch(/X-Client-Platform/);
      const android = (await get('/v1/config', { 'x-client-platform': 'android' })).json() as {
        minClientVersion: string;
      };
      expect(android.minClientVersion).toBe('1.5.0');
    });

    it('426 CLIENT_OUTDATED tells web to reload', async () => {
      const r = await get('/v1/config', {
        origin: WEB,
        'x-client-platform': 'web',
        'x-client-version': '1.5.9',
      });
      expect(r.statusCode).toBe(426);
      const body = { status: r.statusCode, body: r.json(), headers: r.headers, raw: r.rawPayload };
      expect(errCode(body)).toBe('CLIENT_OUTDATED');
      expect(errDetails(body)).toEqual({
        minClientVersion: '1.6.0',
        clientVersion: '1.5.9',
        platform: 'web',
        action: 'reload',
      });
      expect((r.json() as { error: { message: string } }).error.message).toMatch(/Reload/);
    });

    it('426 tells the app to update from the store, and a legacy app with no header is android', async () => {
      const cases: Record<string, string>[] = [
        { 'x-client-platform': 'android', 'x-client-version': '1.4.0' },
        { 'x-client-version': '1.4.0' },
      ];
      for (const headers of cases) {
        const r = await get('/v1/config', headers);
        expect(r.statusCode).toBe(426);
        const d = (r.json() as { error: { details: Record<string, unknown> } }).error.details;
        expect(d).toMatchObject({
          minClientVersion: '1.5.0',
          platform: 'android',
          action: 'store',
        });
      }
      expect((await get('/v1/config', { 'x-client-version': '1.5.0' })).statusCode).toBe(200);
    });

    it('checks the version before the ETag, so a cached ETag cannot dodge the 426', async () => {
      const ok = await get('/v1/config', { 'x-client-platform': 'web', origin: WEB });
      const etag = String(ok.headers.etag);
      const same = await get('/v1/config', {
        'x-client-platform': 'web',
        origin: WEB,
        'if-none-match': etag,
      });
      expect(same.statusCode).toBe(304);
      const old = await get('/v1/config', {
        'x-client-platform': 'web',
        origin: WEB,
        'if-none-match': etag,
        'x-client-version': '1.0.0',
      });
      expect(old.statusCode).toBe(426);
    });

    it('applies the web kill-list to capabilities and the blocks that depend on them', async () => {
      const web = (await get('/v1/config', { origin: WEB })).json() as {
        capabilities: { features: Record<string, boolean> };
        seasonPass?: unknown;
      };
      expect(web.capabilities.features.paidCalls).toBe(false);
      expect(web.capabilities.features.seasonPassPurchase).toBe(false);
      expect(web.capabilities.features.worldEvents).toBe(true);
      expect(web.seasonPass).toBeUndefined();

      const android = (await get('/v1/config', { 'x-client-platform': 'android' })).json() as {
        capabilities: { features: Record<string, boolean> };
      };
      expect(android.capabilities.features.paidCalls).toBe(true);
      expect(android.capabilities.features.seasonPassPurchase).toBe(true);
    });

    it('a web page cannot claim android to get the android capabilities', async () => {
      const r = (
        await get('/v1/config', { origin: WEB, 'x-client-platform': 'android' })
      ).json() as {
        clientPlatform: string;
        capabilities: { features: Record<string, boolean> };
      };
      expect(r.clientPlatform).toBe('web');
      expect(r.capabilities.features.paidCalls).toBe(false);
    });

    it('an unknown platform loses the union of the kill-lists', async () => {
      const r = (await get('/v1/config', { 'x-client-platform': 'toaster' })).json() as {
        clientPlatform: string;
        minClientVersion: string;
        capabilities: { features: Record<string, boolean> };
      };
      expect(r.clientPlatform).toBe('unknown');
      expect(r.minClientVersion).toBe('1.0.0');
      expect(r.capabilities.features.paidCalls).toBe(false);
    });
  });

  describe('route gates', () => {
    it('refuses a killed capability for web with 503 CAPABILITY_OFF, not for android', async () => {
      const web = await get(`/v1/paid-calls/${UUID}`, { origin: WEB, 'x-client-platform': 'web' });
      expect(web.statusCode).toBe(503);
      expect((web.json() as { error: { code: string; details: unknown } }).error).toMatchObject({
        code: 'CAPABILITY_OFF',
        details: { capability: 'paidCalls' },
      });
      expect(web.headers['access-control-allow-origin']).toBe(WEB);

      // Android passes the capability gate and stops at auth (anonymous call).
      const android = await get(`/v1/paid-calls/${UUID}`, { 'x-client-platform': 'android' });
      expect(android.statusCode).toBe(401);
      // A legacy request (no header, no Origin) is not scoped.
      expect((await get(`/v1/paid-calls/${UUID}`)).statusCode).toBe(401);
    });

    it('leaves capabilities a platform did not lose alone', async () => {
      const p = await api.player();
      const r = await api.app.inject({
        method: 'GET',
        url: '/v1/events/active',
        headers: { origin: WEB, authorization: `Bearer ${p.accessToken}` },
      });
      expect(r.statusCode).toBe(200);
    });
  });
});

describe('client-platform hook (isolated)', () => {
  const on = new Set<CapabilityName>(['paidCalls', 'worldEvents']);
  const ctx = {
    config: {
      capabilities: { on, ignored: [] },
      clients: {
        minVersionByPlatform: {},
        capabilitiesOffByPlatform: parseCapabilitiesOffByPlatform('{"android":["paidCalls"]}'),
        latestWebBuild: null,
      },
    },
  } as unknown as AppContext;

  async function app(): Promise<ReturnType<typeof Fastify>> {
    const a = Fastify();
    a.addHook('onRequest', async (req) => {
      req.ctx = ctx;
    });
    registerClientPlatformHook(a);
    const handler = async (req: import('fastify').FastifyRequest): Promise<unknown> => ({
      client: req.client,
      paidCalls: isCapabilityOn(req.ctx, 'paidCalls'),
    });
    a.post('/v1/webhooks/test', handler);
    a.get('/v1/thing', handler);
    await a.ready();
    return a;
  }

  it('scopes client routes and never webhook routes', async () => {
    const a = await app();
    const client = await a.inject({
      method: 'GET',
      url: '/v1/thing',
      headers: { 'x-client-platform': 'android', 'x-client-build': '42' },
    });
    expect(client.json()).toMatchObject({
      client: { platform: 'android', build: 42, scoped: true },
      paidCalls: false,
    });
    const hook = await a.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: { 'x-client-platform': 'android', origin: EVIL },
      payload: {},
    });
    expect(hook.json()).toMatchObject({ client: { scoped: false }, paidCalls: true });
    const legacy = await a.inject({ method: 'GET', url: '/v1/thing' });
    expect(legacy.json()).toMatchObject({ client: { scoped: false }, paidCalls: true });
    await a.close();
  });
});

describe('platform env at boot', () => {
  const keys = [
    'WEB_ORIGINS',
    'MIN_CLIENT_VERSION_BY_PLATFORM',
    'CAPABILITIES_OFF_BY_PLATFORM',
    'LATEST_WEB_BUILD',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetConfigForTests();
  });

  it('refuses a wildcard origin and malformed per-platform JSON, naming the variable', () => {
    const cases: [string, string, RegExp][] = [
      ['WEB_ORIGINS', '*', /WEB_ORIGINS/],
      ['WEB_ORIGINS', 'https://*.ctlife.fun', /WEB_ORIGINS/],
      ['MIN_CLIENT_VERSION_BY_PLATFORM', '{"web":"latest"}', /MIN_CLIENT_VERSION_BY_PLATFORM/],
      ['CAPABILITIES_OFF_BY_PLATFORM', '{"web":"paidCalls"}', /CAPABILITIES_OFF_BY_PLATFORM/],
      ['LATEST_WEB_BUILD', 'v12', /LATEST_WEB_BUILD/],
    ];
    for (const [k, v, re] of cases) {
      for (const key of keys) delete process.env[key];
      process.env[k] = v;
      _resetConfigForTests();
      expect(() => loadConfig(), `${k}=${v}`).toThrow(re);
    }
  });

  it('defaults: no web origins, no per-platform rules', () => {
    for (const key of keys) delete process.env[key];
    _resetConfigForTests();
    const cfg = loadConfig();
    expect(cfg.web.origins).toEqual([]);
    expect(cfg.clients.minVersionByPlatform).toEqual({});
    expect(cfg.clients.capabilitiesOffByPlatform.off).toEqual({});
    expect(cfg.clients.latestWebBuild).toBeNull();
  });
});
