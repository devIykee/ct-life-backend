/**
 * LIVE_PHASE: the release phase `GET /config` sends as `livePhase`. Default 1, 1 to 6
 * allowed, anything else fails the config load.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildServer } from './main.js';
import { _resetContextForTests } from '../application/context.js';
import { _resetConfigForTests, loadConfig } from '../shared/config/config.js';

loadDotenv({ path: process.cwd() + '/.env' });

const saved = process.env.LIVE_PHASE;
function withPhase(v: string | undefined): void {
  if (v === undefined) delete process.env.LIVE_PHASE;
  else process.env.LIVE_PHASE = v;
  _resetConfigForTests();
  _resetContextForTests();
}

afterAll(() => {
  withPhase(saved);
});

describe('LIVE_PHASE in the config', () => {
  it('defaults to 1 when unset or empty', () => {
    withPhase(undefined);
    expect(loadConfig().livePhase).toBe(1);
    withPhase('');
    expect(loadConfig().livePhase).toBe(1);
  });

  it('takes 1 to 6', () => {
    for (const v of ['1', '2', '6']) {
      withPhase(v);
      expect(loadConfig().livePhase).toBe(Number(v));
    }
  });

  it('fails the config load for anything else', () => {
    for (const v of ['0', '7', '-1', '3.5', 'six', '1e1']) {
      withPhase(v);
      expect(() => loadConfig(), v).toThrow(/LIVE_PHASE/);
    }
  });
});

describe('GET /config', () => {
  let app: Awaited<ReturnType<typeof buildServer>>['app'];
  let stop: () => Promise<void>;

  async function boot(v: string | undefined): Promise<void> {
    withPhase(v);
    process.env.LOG_LEVEL = 'warn';
    const handle = await buildServer();
    app = handle.app;
    await app.ready();
    stop = handle.stop;
  }

  beforeAll(() => {
    process.env.APP_ENV = process.env.APP_ENV ?? 'local';
  });

  it('sends livePhase 1 by default and 6 when LIVE_PHASE=6, and the ETag follows it', async () => {
    await boot(undefined);
    const a = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(a.statusCode).toBe(200);
    expect(a.json().livePhase).toBe(1);
    const etag1 = a.headers.etag;
    await stop();

    await boot('6');
    const b = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(b.json().livePhase).toBe(6);
    expect(b.headers.etag).not.toBe(etag1);
    // A client holding the old ETag gets the new body, not a 304.
    const c = await app.inject({
      method: 'GET',
      url: '/v1/config',
      headers: { 'if-none-match': String(etag1) },
    });
    expect(c.statusCode).toBe(200);
    expect(c.json().livePhase).toBe(6);
    await stop();
  }, 30_000);
});
