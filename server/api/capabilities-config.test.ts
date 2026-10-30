/**
 * CAPABILITIES_ON drives `capabilities` and `competitionCapabilities` in GET /config,
 * and APP_ENV=prod (mainnet) refuses to boot without ALLOW_MAINNET=1.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildServer } from './main.js';
import { _resetContextForTests } from '../application/context.js';
import { _resetConfigForTests, loadConfig } from '../shared/config/config.js';

loadDotenv({ path: process.cwd() + '/.env' });

const KEYS = [
  'CAPABILITIES_ON',
  'APP_ENV',
  'ALLOW_MAINNET',
  'ENABLE_DEV_AUTH',
  'TREASURY_PUBKEY_MAINNET',
  'SETTLE_AUTHORITY_KEYPAIR_MAINNET',
  'ADMIN_KEYPAIR_MAINNET',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setEnv(vars: Partial<Record<(typeof KEYS)[number], string | undefined>>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetConfigForTests();
  _resetContextForTests();
}

afterAll(() => {
  setEnv(saved);
});

describe('mainnet boot guard', () => {
  const mainnetKeys = {
    APP_ENV: 'prod',
    ENABLE_DEV_AUTH: 'false',
    TREASURY_PUBKEY_MAINNET: 'test-treasury',
    SETTLE_AUTHORITY_KEYPAIR_MAINNET: 'test-settle',
    ADMIN_KEYPAIR_MAINNET: 'test-admin',
  };

  afterEach(() => {
    setEnv(saved);
  });

  it('refuses APP_ENV=prod unless ALLOW_MAINNET is exactly 1', () => {
    for (const v of [undefined, '', '0', 'true', 'yes']) {
      setEnv({ ...mainnetKeys, ALLOW_MAINNET: v });
      expect(() => loadConfig(), String(v)).toThrow(/ALLOW_MAINNET/);
    }
  });

  it('boots on mainnet with ALLOW_MAINNET=1, and devnet never needs it', () => {
    setEnv({ ...mainnetKeys, ALLOW_MAINNET: '1' });
    expect(loadConfig().solana.cluster).toBe('mainnet');
    for (const env of ['local', 'staging']) {
      // Dev auth is refused on staging, so turn it off for that load.
      setEnv({ ...saved, APP_ENV: env, ALLOW_MAINNET: undefined, ENABLE_DEV_AUTH: 'false' });
      expect(loadConfig().solana.cluster).toBe('devnet');
    }
  });
});

describe('GET /config capabilities', () => {
  let app: Awaited<ReturnType<typeof buildServer>>['app'];
  let stop: () => Promise<void>;

  async function boot(on: string | undefined): Promise<void> {
    setEnv({ ...saved, CAPABILITIES_ON: on });
    process.env.LOG_LEVEL = 'warn';
    const handle = await buildServer();
    app = handle.app;
    await app.ready();
    stop = handle.stop;
  }

  beforeAll(() => {
    process.env.APP_ENV = process.env.APP_ENV ?? 'local';
    saved.APP_ENV = process.env.APP_ENV;
  });

  it('sends everything off with no CAPABILITIES_ON, and only listed names when set', async () => {
    await boot(undefined);
    const a = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(a.statusCode).toBe(200);
    const off = a.json();
    expect(off.capabilities.version).toBe(2);
    expect(Object.values(off.capabilities.apps).some(Boolean)).toBe(false);
    expect(Object.values(off.capabilities.features).some(Boolean)).toBe(false);
    expect(off.competitionCapabilities).toEqual({
      version: 1,
      beefChallenges: false,
      targetedCabalInvites: false,
    });
    const etagOff = a.headers.etag;
    await stop();

    await boot('worldEvents, beef,cabalInvites,notAThing');
    const b = await app.inject({ method: 'GET', url: '/v1/config' });
    const on = b.json();
    expect(on.capabilities.features.worldEvents).toBe(true);
    expect(on.capabilities.features.districtStandings).toBe(false);
    expect(on.capabilities.apps.beef).toBe(true);
    expect(on.capabilities.apps.builder).toBe(false);
    expect(on.competitionCapabilities).toEqual({
      version: 1,
      beefChallenges: true,
      targetedCabalInvites: true,
    });
    expect(JSON.stringify(on)).not.toContain('notAThing');
    // Flipping a capability changes the ETag, so cached clients see it.
    expect(b.headers.etag).not.toBe(etagOff);
    await stop();
  }, 30_000);
});
